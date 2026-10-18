import { Store } from "./store.ts"

export type PolicyAction = "activate" | "deactivate" | "stop-motion" | "damping-stop"
export interface PolicyStatus {
    available: boolean
    run_id: string | null
    controller: { id: string; name: string; robot: string; model: string | null; teleop_topic: string; capabilities: string[] } | null
    phase: "unavailable" | "pose-hold" | "activating" | "balancing" | "dry-run" | "fault" | "stopped"
    dry_run: boolean
    fault: string | null
    reason: string | null
    can_activate: boolean
    can_deactivate: boolean
    command_source: string
    feedback_age_ms: number | null
    command_age_ms: number | null
    motor_rate_hz: number | null
    actions: PolicyAction[]
}
export interface PolicyState {
    required: boolean
    status: PolicyStatus | null
    stale: boolean
    error: string | null
    pending: PolicyAction | null
}

export const PHASE_LABELS: Record<PolicyStatus["phase"], string> = {
    unavailable: "Unavailable", "pose-hold": "Pose hold", activating: "Activating…",
    balancing: "Balancing", "dry-run": "Dry-run · pose held", fault: "Damping stop latched", stopped: "Stopped",
}

export function driveBlock(state: PolicyState): string | null {
    if (!state.required) return null
    if (state.stale || !state.status) return "Waiting for fresh policy state"
    if (state.pending && state.pending !== "stop-motion") return "Policy action in progress"
    const status = state.status
    if (status.fault || status.reason) return status.fault || status.reason
    return status.phase === "balancing" && !status.dry_run ? null : "Activate the policy to drive"
}

export function actionAllowed(state: PolicyState, action: PolicyAction): boolean {
    const status = state.status
    if (!status?.available || !status.run_id || !status.controller || !status.actions.includes(action)) return false
    // Damping remains available if state polling fails or another action is awaiting acknowledgement.
    if (action === "damping-stop") return true
    if (state.stale || state.pending) return false
    if (action === "activate") return status.can_activate
    if (action === "deactivate") return status.can_deactivate
    return true
}

const POLL_MS = 1000
const STALE_MS = 3000

/** Backend state is authoritative; mutation requests are never retried automatically. */
export class PolicyControl {
    readonly state = new Store<PolicyState>({ required: false, status: null, stale: true, error: null, pending: null })
    #timer: ReturnType<typeof setTimeout> | undefined
    #freshness: ReturnType<typeof setInterval>
    #lastSuccess = 0
    #generation = 0
    #action = 0
    #actionError: string | null = null
    #closed = false

    constructor(private resetInput: () => void) {
        this.#freshness = setInterval(() => {
            if (!this.state.get().stale && Date.now() - this.#lastSuccess > STALE_MS) this.state.update({ stale: true })
        }, 250)
    }

    setRunning(names: string[]) {
        const required = names.includes("unitree-g1-sonic-wbc")
        if (required === this.state.get().required) return
        this.#generation++
        this.#actionError = null
        clearTimeout(this.#timer)
        this.resetInput()
        this.state.set({ required, status: null, stale: true, error: null, pending: null })
        if (required) void this.#poll(this.#generation)
    }

    async #request(path: string, body?: unknown): Promise<PolicyStatus> {
        const response = await fetch(new URL(`../../dimos-gateway/control${path}`, location.href), {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            cache: "no-store", signal: AbortSignal.timeout(body === undefined ? 5000 : 10000),
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || `Robot control request failed (${response.status})`)
        return data
    }

    #accept(status: PolicyStatus) {
        if (this.state.get().status?.run_id !== status.run_id) this.resetInput()
        this.#lastSuccess = Date.now()
        this.state.update({ status, stale: false })
    }

    async #poll(generation: number) {
        const sequence = this.#action
        try {
            if (this.state.get().pending) return
            const status = await this.#request("")
            if (generation === this.#generation && sequence === this.#action && !this.#closed) {
                this.#accept(status)
                this.state.update({ error: this.#actionError })
            }
        } catch (error) {
            if (generation === this.#generation && sequence === this.#action && !this.#closed) this.state.update({ stale: true, error: this.#actionError || String(error) })
        } finally {
            if (generation === this.#generation && this.state.get().required && !this.#closed) this.#timer = setTimeout(() => void this.#poll(generation), POLL_MS)
        }
    }

    async act(action: PolicyAction) {
        const before = this.state.get()
        if (!actionAllowed(before, action)) return
        const target = before.status!
        const generation = this.#generation
        const sequence = ++this.#action
        this.#actionError = null
        this.state.update({ pending: action, error: null })
        this.resetInput()
        try {
            const status = await this.#request("/actions", { run_id: target.run_id, controller_id: target.controller!.id, action })
            if (generation === this.#generation && sequence === this.#action && !this.#closed) this.#accept(status)
        } catch (error) {
            if (generation === this.#generation && sequence === this.#action && !this.#closed) {
                this.#actionError = String(error)
                this.state.update({ stale: true, error: this.#actionError })
            }
        } finally {
            if (generation === this.#generation && sequence === this.#action && !this.#closed) this.state.update({ pending: null })
        }
    }

    dispose() {
        this.#closed = true
        clearTimeout(this.#timer)
        clearInterval(this.#freshness)
    }
}
