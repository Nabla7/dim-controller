import { Store } from "./store.ts"

export type PolicyAction = "activate" | "deactivate" | "stop-motion" | "damping-stop"
export interface PolicyStatus {
    active: boolean
    control_state: string
    arm_pending: boolean
    dry_run: boolean
    fault_reason: string | null
    feedback_received: boolean
    simulation: boolean
    feedback_age_ms: number | null
    imu_age_ms: number | null
    feedback_timeout_ms: number
    reference_source: string
}
interface Instance { id: string; class: string; namespace: string | null; rpcs: { name: string }[] }
export interface PolicyTarget { run: string; policy: string; movement: string | null; hardware: string | null }
export interface PolicyState {
    required: boolean
    target: PolicyTarget | null
    status: PolicyStatus | null
    stale: boolean
    error: string | null
    pending: PolicyAction | null
}
export const INITIAL_POLICY_STATE: PolicyState = { required: false, target: null, status: null, stale: true, error: null, pending: null }

export function driveBlock(state: PolicyState): string | null {
    if (!state.required) return null
    if (state.stale || !state.status) return "Waiting for fresh SONIC state"
    if (state.pending) return "SONIC action in progress"
    if (state.status.fault_reason) return state.status.fault_reason
    if (state.status.reference_source !== "planner") return "SONIC is following a motion reference"
    return state.status.active && state.status.control_state === "control" && !state.status.dry_run ? null : "Activate SONIC to drive"
}

export function actionAllowed(state: PolicyState, action: PolicyAction): boolean {
    if (!state.target) return false
    if (action === "damping-stop") return true
    if (state.stale || !state.status || state.pending || state.status.fault_reason || !state.status.active) return false
    const status = state.status
    if (action === "activate") {
        const fresh = status.simulation || [status.feedback_age_ms, status.imu_age_ms].every((age) => age !== null && age >= 0 && age < status.feedback_timeout_ms)
        return status.control_state === "unarmed" && !status.arm_pending && status.feedback_received && fresh
    }
    if (action === "deactivate") return status.arm_pending || ["initializing", "control"].includes(status.control_state)
    return true
}

/** RPCs are bound to the inspected run. Mutations are never retried. */
export class PolicyControl {
    readonly state = new Store<PolicyState>({ ...INITIAL_POLICY_STATE })
    #timer: ReturnType<typeof setTimeout> | undefined
    #freshness: ReturnType<typeof setInterval> | undefined
    #lastSuccess = 0
    #sequence = 0
    #closed = false
    constructor(private clearInput: () => void) {}

    start() {
        this.#freshness = setInterval(() => {
            if (!this.state.get().stale && Date.now() - this.#lastSuccess > 3000) this.state.update({ stale: true })
        }, 250)
        const poll = async () => {
            await this.refresh()
            if (!this.#closed) this.#timer = setTimeout(poll, 1000)
        }
        void poll()
    }

    async #request(path: string, body?: unknown) {
        const response = await fetch(new URL(`../../gateways/dimos/${path}`, location.href), {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            cache: "no-store", signal: AbortSignal.timeout(5000),
        })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || `SONIC request failed (${response.status})`)
        return result
    }

    async #rpc(target: PolicyTarget, module: string, method: string, kwargs = {}) {
        const reply = await this.#request(`active/modules/${encodeURIComponent(module)}/rpcs/${method}`, { run_id: target.run, kwargs })
        if (!reply.ok || reply.result === false) throw new Error(reply.error || `${method} was rejected`)
        return reply.result
    }

    async refresh() {
        if (this.state.get().pending || this.#closed) return
        const sequence = this.#sequence
        try {
            const active = await this.#request("active")
            const modules: Instance[] = active.running ? (await this.#request("active/modules")).modules : []
            const policies = modules.filter((module) => module.class.startsWith("G1Sonic") && module.rpcs.some((rpc) => rpc.name === "activate"))
            if (this.#sequence !== sequence || this.#closed) return
            if (!policies.length) {
                if (this.state.get().required) this.clearInput()
                this.state.set({ ...INITIAL_POLICY_STATE, stale: false })
                return
            }
            this.state.update({ required: true })
            if (policies.length !== 1) {
                this.clearInput()
                this.state.update({ target: null, status: null })
                throw new Error("Select a run with one SONIC controller")
            }
            const policy = policies[0]
            const sibling = (name: string) => {
                const matches = modules.filter((module) => module.class === name && module.namespace === policy.namespace)
                if (matches.length > 1) throw new Error(`Ambiguous ${name}`)
                return matches[0]?.id ?? null
            }
            const target = { run: active.runId, policy: policy.id, movement: sibling("MovementManager"), hardware: sibling("G1WholeBodyConnection") }
            if (!target.run) throw new Error("No active run ID")
            const status: PolicyStatus = await this.#rpc(target, target.policy, "status")
            if (this.#sequence !== sequence || this.#closed) return
            if (this.state.get().target?.run !== target.run || this.state.get().target?.policy !== target.policy) this.clearInput()
            this.#lastSuccess = Date.now()
            this.state.update({ target, status, stale: false, error: null })
        } catch (error) {
            if (this.#sequence === sequence && !this.#closed) this.state.update({ stale: true, error: String(error) })
        }
    }

    async act(action: PolicyAction) {
        const before = this.state.get()
        if (!actionAllowed(before, action)) return
        const target = before.target!
        const sequence = ++this.#sequence
        this.clearInput()
        this.state.update({ pending: action, error: null })
        try {
            if (action === "damping-stop") {
                if (target.hardware) await this.#rpc(target, target.hardware, "set_estop", { estopped: true })
                else await this.#rpc(target, target.policy, "halt_robot")
            } else {
                if (target.movement) await this.#rpc(target, target.movement, "stop_motion")
                if (this.#sequence !== sequence) return
                await this.#rpc(target, target.policy, action === "activate" ? "activate" : action === "deactivate" ? "disarm" : "stop_motion")
            }
            if (sequence === this.#sequence && !this.#closed) {
                this.state.update({ pending: null, stale: true })
                await this.refresh()
            }
        } catch (error) {
            if (sequence === this.#sequence && !this.#closed) this.state.update({ pending: null, stale: true, error: String(error) })
        }
    }

    dispose() {
        this.#closed = true
        clearTimeout(this.#timer)
        clearInterval(this.#freshness)
    }
}
