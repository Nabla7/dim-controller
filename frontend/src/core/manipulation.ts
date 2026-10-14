// viser's manipulation workflow for the arm mode, the page's side (server/src/manipulation.rs does the planner calls):
// the target (the ghost arm), Plan, Preview, Execute, Cancel, Clear, and the planner's live state. Every action is the
// backend's endpoint, so the agent and other open pages see the same target and plan (the `manipulation` event).
import { persistentStore, Store } from "./store.ts"

export type PlanningMode = "joint" | "cartesian"

export interface ManipulationTarget {
    mode: PlanningMode
    group: string
    joints?: Record<string, number>
    /** world frame: position [x, y, z], orientation [x, y, z, w] */
    pose?: { position: [number, number, number]; orientation: [number, number, number, number]; frame?: string }
    preset?: string
}

export interface ManipulationPlan {
    id: string
    group: string
    duration: number
    jointNames: string[]
    times: number[]
    positions: number[][]
    target: ManipulationTarget
}

export interface PlanningGroup {
    id: string
    joint_names: string[]
    base_frame: string
    tip_frame: string
    has_gripper: boolean
}

interface EnumValue {
    name: string | null
    value: number
}

export interface PlannerState {
    operation_status: EnumValue
    execution_status: EnumValue
    has_pending_plan: boolean
    error: string | null
    groups: Record<string, {
        joints: { name: string[]; position: number[] }
        end_effector_pose: { frame_id: string; position: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } }
        gripper_position: number | null
        joint_presets: Record<string, { name: string[]; position: number[] }>
    }>
}

export interface ManipulationOptions {
    mode: PlanningMode
    /** the next plan's speed scale, 0.05-1 */
    speed: number
    display: "visual" | "collision" | "both"
    obstacles: boolean
    /** the 3D arm, ghost and gizmo are drawn */
    interact: boolean
}

export interface ManipulationState {
    /** whether a ManipulationModule answers (null: not asked yet) */
    available: boolean | null
    error: string | null
    planner: PlannerState | null
    groups: PlanningGroup[]
    target: ManipulationTarget | null
    plan: ManipulationPlan | null
    /** the plan being previewed on the ghost: its id and when it started (performance.now) */
    preview: { id: string; startedAt: number } | null
    /** what the last action said: plan / execute / cancel / clear */
    last: { action: string; ok: boolean; message: string } | null
    busy: string | null
    /** the ghost pose from the gizmo: reachable (browser IK); null when the target is joints */
    reach: { reachable: boolean; positionError: number; angleError: number } | null
}

const POLL_MS = 700

export class Manipulation {
    readonly state = new Store<ManipulationState>({ available: null, error: null, planner: null, groups: [], target: null, plan: null, preview: null, last: null, busy: null, reach: null })
    readonly options = persistentStore<ManipulationOptions>("lv.manip", { mode: "joint", speed: 1, display: "visual", obstacles: true, interact: true })
    /** the gizmo's drag is moving the target and it isn't committed yet: polls keep it */
    readonly gizmo = new Store<{ mode: "translate" | "rotate"; dragging: boolean }>({ mode: "translate", dragging: false })
    #polling: ReturnType<typeof setInterval> | null = null
    #inFlight = false
    #uncommitted = false

    #url(path: string): string {
        return new URL(path, location.href).href
    }

    async #call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
        const response = await fetch(this.#url(path), {
            method,
            headers: body === undefined ? {} : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        })
        const answer = await response.json().catch(() => ({ error: `${response.status} ${response.statusText}` }))
        if (!response.ok) {
            throw new Error(String(answer.error ?? response.statusText))
        }
        return answer
    }

    /** Polls the planner's state while the arm mode shows it. */
    setActive(active: boolean) {
        if (active && !this.#polling) {
            this.refresh()
            this.#polling = setInterval(() => this.refresh(), POLL_MS)
        } else if (!active && this.#polling) {
            clearInterval(this.#polling)
            this.#polling = null
        }
    }

    async refresh() {
        if (this.#inFlight || (typeof document !== "undefined" && document.hidden)) {
            return
        }
        this.#inFlight = true
        try {
            const answer = await this.#call("GET", "api/manipulation")
            if (answer.available) {
                this.state.update({
                    available: true,
                    error: null,
                    planner: answer.state as PlannerState,
                    groups: (answer.groups as PlanningGroup[]) ?? [],
                    target: this.#uncommitted ? this.state.get().target : (answer.target as ManipulationTarget | null) ?? null,
                    plan: (answer.plan as ManipulationPlan | null) ?? null,
                })
            } else {
                this.state.update({ available: false, error: String(answer.error ?? "no ManipulationModule answered") })
            }
        } catch (error) {
            this.state.update({ available: false, error: String(error) })
        } finally {
            this.#inFlight = false
        }
    }

    get group(): string {
        return this.state.get().groups[0]?.id ?? "manipulator"
    }

    /** The ghost follows at once; the backend (and other pages) get it when the drag or slide ends (`commit`). */
    setTarget(target: ManipulationTarget | null, commit = true) {
        this.state.update({ target, preview: null })
        this.#uncommitted = !commit
        if (!commit) {
            return
        }
        const body = target ? { ...target, from: "page" } : { clear: true }
        this.#call("POST", "api/manipulation/target", body).catch((error) => this.state.update({ last: { action: "target", ok: false, message: String(error) } }))
    }

    setReach(reach: ManipulationState["reach"]) {
        this.state.update({ reach })
    }

    async preset(name: "current" | "init" | "home") {
        try {
            const answer = await this.#call("POST", "api/manipulation/target", { preset: name, group: this.group })
            this.state.update({ target: answer.target as ManipulationTarget, preview: null, reach: null })
        } catch (error) {
            this.state.update({ last: { action: "preset", ok: false, message: String(error) } })
        }
    }

    async #act(action: string, path: string, body?: unknown) {
        this.state.update({ busy: action })
        try {
            const answer = await this.#call("POST", path, body)
            const ok = answer.ok !== false
            const message = String(answer.message ?? answer.status ?? "")
            this.state.update({ last: { action, ok, message } })
            return answer
        } catch (error) {
            this.state.update({ last: { action, ok: false, message: String(error) } })
            return null
        } finally {
            this.state.update({ busy: null })
            this.refresh()
        }
    }

    async plan() {
        const target = this.state.get().target
        const answer = await this.#act("plan", "api/manipulation/plan", target ? { ...target, speed: this.options.get().speed } : {})
        if (answer) {
            this.state.update({ plan: (answer.plan as ManipulationPlan | null) ?? null, preview: null })
        }
    }

    preview() {
        this.#act("preview", "api/manipulation/preview")
        this.startPreview()
    }

    startPreview(id?: string) {
        const plan = this.state.get().plan
        if (plan && (!id || id === plan.id)) {
            this.state.update({ preview: { id: plan.id, startedAt: performance.now() } })
        }
    }

    execute() {
        this.state.update({ preview: null })
        this.#act("execute", "api/manipulation/execute")
    }

    cancel() {
        this.state.update({ preview: null })
        this.#act("cancel", "api/manipulation/cancel")
    }

    clear() {
        this.state.update({ plan: null, preview: null })
        this.#act("clear", "api/manipulation/clear")
    }

    /** The backend's `manipulation` event: another page's or the agent's target, plan, preview or execute. */
    applyEvent(event: Record<string, unknown>) {
        if ("target" in event && event.from !== "page") {
            this.state.update({ target: event.target as ManipulationTarget | null, reach: null })
        }
        if ("plan" in event) {
            this.state.update({ plan: event.plan as ManipulationPlan | null, preview: null })
        }
        if (typeof event.preview === "string") {
            this.startPreview(event.preview)
        }
        if (event.cancel || event.executed) {
            this.state.update({ preview: null })
        }
    }

    /** The joint positions of the plan's trajectory at `seconds` after it starts (linear between its points). */
    static sample(plan: ManipulationPlan, seconds: number): Record<string, number> {
        const { times, positions, jointNames } = plan
        let index = times.findIndex((time) => time >= seconds)
        if (index < 0) {
            index = times.length - 1
        }
        const after = positions[index]
        const before = positions[Math.max(0, index - 1)]
        const span = times[index] - times[Math.max(0, index - 1)]
        const fraction = index === 0 || span <= 0 ? 1 : Math.min(1, Math.max(0, (seconds - times[index - 1]) / span))
        return Object.fromEntries(jointNames.map((name, joint) => [name, before[joint] + (after[joint] - before[joint]) * fraction]))
    }
}
