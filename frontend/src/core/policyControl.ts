import { Store } from "./store.ts"

export type PolicyAction = "activate" | "deactivate" | "stop-motion" | "damping-stop" | "mode" | "height" | "clip"
export type PolicyCommand = Exclude<PolicyAction, "mode" | "height" | "clip">
    | { action: "mode"; mode: string }
    | { action: "height"; height: number | null }
    | { action: "clip"; name: string }
// NVIDIA's gamepad_manager.hpp clamps its height adjustment to this range.
// These are planner input limits, not a claim of hardware-safe postures.
export const HEIGHT_RANGE = { min: 0.2, max: 0.8, step: 0.02 }
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
    mode?: number
    mode_override?: number
    mode_queue?: number[]
    stream_active?: boolean
    stream_frame?: number
    stream_frames?: number
    webxr?: { mode: string; reason: string | null; body_age_ms: number | null }
    policy_timing?: {
        target_hz: number
        last_step_age_ms: number | null
        step_ms: TimingSummary
        start_interval_ms: TimingSummary
    }
}
export interface TimingSummary { samples: number; mean: number; p99: number; max: number }
export interface SimulationTiming {
    target_hz: number; actual_hz: number | null; real_time_factor: number | null
    physics_age_ms: number | null; interval_p99_ms: number | null; interval_max_ms: number | null
    work_overruns: number; samples: number
    sensor_age_ms: number | null; sensor_work_ms: number | null; sensor_error: string | null
}
export interface HardwareTiming {
    configured_rate_hz: number; frames_sent: number; latest_command_age_ms: number | null
    feedback_age_ms: number | null; fault_reason: string | null
}
export interface PolicyOptions { modes: Record<string, number>; clips: string[]; height: boolean }
interface Instance { id: string; class: string; namespace: string | null; rpcs: { name: string }[] }
export interface PolicyTarget { run: string; policy: string; movement: string | null; hardware: string | null }
export interface PolicyState {
    required: boolean
    target: PolicyTarget | null
    status: PolicyStatus | null
    stale: boolean
    error: string | null
    pending: PolicyAction | null
    options: PolicyOptions | null
    optionsError: string | null
    notice: string | null
    simulationTiming: SimulationTiming | null
    hardwareTiming: HardwareTiming | null
    diagnosticsError: string | null
}
export const INITIAL_POLICY_STATE: PolicyState = { required: false, target: null, status: null, stale: true, error: null, pending: null, options: null, optionsError: null, notice: null, simulationTiming: null, hardwareTiming: null, diagnosticsError: null }

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value)
const freshFeedback = (status: PolicyStatus) => [status.feedback_age_ms, status.imu_age_ms]
    .every((age) => finite(age) && age >= 0 && age < status.feedback_timeout_ms)

export function timingWarnings(state: PolicyState): string[] {
    if (state.stale || !state.status) return ["Control status is stale or unavailable"]
    const warnings: string[] = []
    const status = state.status
    const timing = status.policy_timing
    if (status.fault_reason) warnings.push(status.fault_reason)
    if (!status.simulation && !freshFeedback(status)) warnings.push("Motor or IMU feedback is stale or unavailable")
    if (!finite(timing?.target_hz) || !timing?.step_ms.samples) warnings.push("Policy timing unavailable")
    else if (status.control_state === "control") {
        const period = 1000 / timing.target_hz
        if (timing.step_ms.max > period) warnings.push("Policy computation exceeded its tick budget in the recent window")
        if (timing.start_interval_ms.max > period * 1.5) warnings.push("Control tick gap exceeded 1.5 periods in the recent window")
        if (!finite(timing.last_step_age_ms) || timing.last_step_age_ms > period * 2) warnings.push("Policy updates are late")
    }
    const sim = state.simulationTiming
    if (status.simulation) {
        if (!sim || !finite(sim.real_time_factor)) warnings.push("Simulation timing unavailable")
        else {
            if (sim.real_time_factor < 0.9 || sim.real_time_factor > 1.1) warnings.push("Physics and controller clocks differ by more than 10%")
            if (!finite(sim.physics_age_ms) || sim.physics_age_ms >= status.feedback_timeout_ms) warnings.push("Physics feedback is stale or unavailable")
            if (finite(sim.interval_max_ms) && sim.interval_max_ms > 1000 / sim.target_hz * 3) warnings.push("Physics tick gap exceeded 3 periods in the recent window")
            if (sim.sensor_error) warnings.push(`Sensor failure: ${sim.sensor_error}`)
        }
    }
    if (state.hardwareTiming?.fault_reason) warnings.push(state.hardwareTiming.fault_reason)
    if (state.diagnosticsError) warnings.push(state.diagnosticsError)
    return warnings
}

export function modeLabel(name: string): string {
    return name.replace(/^IDEL_/, "").toLowerCase().split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ")
}

export function modeName(state: PolicyState, id: number | undefined): string {
    const entry = Object.entries(state.options?.modes ?? {}).find(([, value]) => value === id)
    return entry ? modeLabel(entry[0]) : id === undefined ? "Unknown" : `Mode ${id}`
}

export function driveBlock(state: PolicyState): string | null {
    if (!state.required) return null
    if (state.stale || !state.status) return "Waiting for fresh SONIC state"
    if (state.pending) return "SONIC action in progress"
    if (state.status.fault_reason) return state.status.fault_reason
    if (!state.status.simulation && !freshFeedback(state.status)) return "Motor or IMU feedback is stale or unavailable"
    if (state.status.reference_source !== "planner") return "SONIC is following a motion reference"
    return state.status.active && state.status.control_state === "control" && !state.status.dry_run ? null : "Activate SONIC to drive"
}

export function actionAllowed(state: PolicyState, action: PolicyAction): boolean {
    if (!state.target) return false
    if (action === "damping-stop") return true
    if (state.stale || !state.status || state.pending || state.status.fault_reason || !state.status.active) return false
    const status = state.status
    if (action === "activate") {
        const fresh = status.simulation || freshFeedback(status)
        return status.control_state === "unarmed" && !status.arm_pending && status.feedback_received && fresh
    }
    if (action === "deactivate") return status.arm_pending || ["initializing", "control"].includes(status.control_state)
    if (["mode", "height", "clip"].includes(action)) {
        if (!status.simulation && !freshFeedback(status)) return false
        if (status.control_state !== "control" || status.dry_run || status.arm_pending || !state.options) return false
        if (status.reference_source !== "planner") return false
        return action === "mode" ? Object.keys(state.options.modes).length > 0
            : action === "clip" ? state.options.clips.length > 0 : state.options.height
    }
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
    #refreshing = false
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
        if (this.state.get().pending || this.#closed || this.#refreshing) return
        this.#refreshing = true
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
                this.state.update({ target: null, status: null, options: null, notice: null, simulationTiming: null, hardwareTiming: null })
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
            const changed = this.state.get().target?.run !== target.run || this.state.get().target?.policy !== target.policy
            if (changed) this.clearInput()
            this.#lastSuccess = Date.now()
            this.state.update({ target, status, stale: false, error: null, ...(changed ? { options: null, optionsError: null, notice: null, simulationTiming: null, hardwareTiming: null, diagnosticsError: null } : {}) })
            try {
                let simulationTiming: SimulationTiming | null = null
                let hardwareTiming: HardwareTiming | null = null
                if (status.simulation) {
                    const sims = modules.filter((module) => module.class === "MujocoSimModule" && module.rpcs.some((rpc) => rpc.name === "timing"))
                    if (sims.length !== 1) throw new Error("Simulation timing unavailable")
                    simulationTiming = await this.#rpc(target, sims[0].id, "timing")
                } else if (target.hardware) {
                    hardwareTiming = await this.#rpc(target, target.hardware, "command_stream_status")
                }
                if (this.#sequence !== sequence || this.#closed) return
                this.state.update({ simulationTiming, hardwareTiming, diagnosticsError: null })
            } catch (error) {
                if (this.#sequence === sequence && !this.#closed) this.state.update({ simulationTiming: null, hardwareTiming: null, diagnosticsError: String(error) })
            }
            if (!this.state.get().options) {
                try {
                    const has = (method: string) => policy.rpcs.some((rpc) => rpc.name === method)
                    const modes = has("list_locomotion_modes") && has("set_locomotion_mode")
                        ? await this.#rpc(target, target.policy, "list_locomotion_modes") : {}
                    const clips = has("list_motion_clips") && has("play_motion_clip")
                        ? await this.#rpc(target, target.policy, "list_motion_clips") : []
                    if (this.#sequence !== sequence || this.#closed) return
                    this.state.update({ options: { modes, clips, height: has("set_base_height") }, optionsError: null })
                } catch (error) {
                    if (this.#sequence === sequence && !this.#closed) this.state.update({ optionsError: String(error) })
                }
            }
        } catch (error) {
            if (this.#sequence === sequence && !this.#closed) this.state.update({ stale: true, error: String(error) })
        } finally {
            this.#refreshing = false
        }
    }

    async act(command: PolicyCommand) {
        const action = typeof command === "string" ? command : command.action
        const before = this.state.get()
        if (this.#closed) return
        if (!actionAllowed(before, action)) {
            if (action === "damping-stop" && before.required && !before.target) {
                this.clearInput()
                this.state.update({ error: "Damping stop not sent: no unambiguous SONIC control endpoint" })
            }
            return
        }
        let method = action === "activate" ? "activate" : action === "deactivate" ? "disarm" : "stop_motion"
        let kwargs: Record<string, unknown> = {}
        let notice: string | null = null
        if (typeof command !== "string") {
            if (command.action === "mode") {
                if (!Object.hasOwn(before.options!.modes, command.mode)) return
                method = "set_locomotion_mode"
                kwargs = { mode: command.mode }
                notice = `Requested ${modeLabel(command.mode)}`
            } else if (command.action === "height") {
                const height = command.height
                if (height !== null && (!Number.isFinite(height) || height < HEIGHT_RANGE.min || height > HEIGHT_RANGE.max)) return
                method = "set_base_height"
                kwargs = { height: height ?? -1 }
                notice = height === null ? "Requested mode-default height" : `Requested pelvis height ${height.toFixed(2)} m`
            } else {
                if (!before.options!.clips.includes(command.name)) return
                method = "play_motion_clip"
                kwargs = { name: command.name }
                notice = `Started ${command.name}`
            }
        }
        const target = before.target!
        const sequence = ++this.#sequence
        this.clearInput()
        this.state.update({ pending: action, error: null, notice: null })
        try {
            if (action === "damping-stop") {
                if (target.hardware) await this.#rpc(target, target.hardware, "set_estop", { estopped: true })
                else await this.#rpc(target, target.policy, "halt_robot")
            } else {
                if (target.movement) await this.#rpc(target, target.movement, "stop_motion")
                if (this.#sequence !== sequence || this.#closed) return
                await this.#rpc(target, target.policy, method, kwargs)
            }
            if (sequence === this.#sequence && !this.#closed) {
                this.state.update({ pending: null, stale: true, notice })
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
