// viser's manipulation panel for the arm mode, the page's side (server/src/manipulation.rs does the planner calls):
// the selected planning groups, the target (joints per group and a TCP pose per pose-capable group, as viser's
// sliders and gizmos), its feasibility (checked by the planner through dim-controller's hook, as viser does), Plan /
// Preview / Execute / Cancel / Clear, and the planner's live state. Every action is the backend's endpoint, so the
// agent and other open pages see the same target and plan (the `manipulation` event).
import { persistentStore, Store } from "./store.ts"

export type PlanningMode = "joint" | "cartesian"

export interface Pose {
    /** world frame */
    position: [number, number, number]
    orientation: [number, number, number, number]
    frame?: string
}

export interface ManipulationTarget {
    groups: string[]
    /** every selected group's joints (viser's sliders) */
    joints: Record<string, number>
    /** a TCP pose per selected group with a tip (viser's gizmos) */
    poses: Record<string, Pose>
    /** what was edited last: the sliders (joints) or a gizmo (cartesian); the other follows from the check */
    source: "joints" | "cartesian"
    preset?: string
}

export interface ManipulationPlan {
    id: string
    groups: string[]
    mode: PlanningMode
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
    tip_frame: string | null
    has_gripper: boolean
}

/** dim-controller's hook in the blueprint's process (server/python/dim_controller_hook), when it is loaded */
export interface HookInfo {
    hook: number
    pid: number
    python: string
    visualization: string | null
    visualization_url: string | null
    operator: boolean
    /** per joint, as viser's sliders read it: limited | circle (-pi..pi) | line (unbounded: a number box) */
    joint_topology: Record<string, string>
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
        joints: { name: string[]; position: number[] } | null
        end_effector_pose: { frame_id: string; position: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } } | null
        gripper_position: number | null
        joint_presets: Record<string, { name: string[]; position: number[] }>
    }>
}

/** viser's FeasibilityStatus; "unchecked" when there is no hook to ask */
export type Feasibility = "unknown" | "checking" | "feasible" | "collision" | "ik_failed" | "invalid" | "unchecked"

export interface ManipulationOptions {
    mode: PlanningMode
    /** the next plan's speed scale, 0.05-1 */
    speed: number
    display: "visual" | "collision" | "both"
    obstacles: boolean
    grasps: boolean
    grid: boolean
    /** the 3D arm, ghost and gizmo are drawn */
    interact: boolean
    /** the gizmo keeps one size on screen as the view zooms; off: a fixed size in the world, beside the arm */
    gizmoScalesWithView: boolean
    /** group -> the link its gizmo sits on, when not the planner's tip (or, without one, the group's last link) */
    gizmoLinks: Record<string, string>
}

/** a saved target, shown as a button (api/manipulation/poses: poses.yaml per URDF name) */
export interface SavedPose {
    name: string
    color?: string
    target: ManipulationTarget
}

export interface ManipulationState {
    /** whether a ManipulationModule answers (null: not asked yet) */
    available: boolean | null
    error: string | null
    planner: PlannerState | null
    groups: PlanningGroup[]
    hook: HookInfo | null
    /** viser's planning-group toggles */
    selected: string[]
    target: ManipulationTarget | null
    /** bumps on every target edit: a plan or check made for an older one is stale (viser's sequence ids) */
    targetSequence: number
    feasibility: { status: Feasibility; message: string; sequence: number }
    plan: ManipulationPlan | null
    /** the target sequence the plan was made for */
    planSequence: number | null
    /** the plan being previewed on the preview ghost: its id and when it started (performance.now) */
    preview: { id: string; startedAt: number } | null
    /** what the last action said: plan / execute / cancel / clear (viser's "Last result") */
    last: { action: string; ok: boolean; message: string } | null
    busy: string | null
    /** without the hook: the gizmo pose's reach by the page's own IK */
    reach: { reachable: boolean; positionError: number; angleError: number } | null
}

const POLL_MS = 700
const WATCH_MS = 5000
const CHECKING_STATUSES: Record<string, Feasibility> = {
    FEASIBLE: "feasible",
    COLLISION: "collision",
    COLLISION_AT_START: "collision",
    COLLISION_AT_GOAL: "collision",
    NO_SOLUTION: "ik_failed",
    SINGULARITY: "ik_failed",
    JOINT_LIMITS: "ik_failed",
    TIMEOUT: "ik_failed",
}

export class Manipulation {
    readonly state = new Store<ManipulationState>({
        available: null,
        error: null,
        planner: null,
        groups: [],
        hook: null,
        selected: [],
        target: null,
        targetSequence: 0,
        feasibility: { status: "unknown", message: "", sequence: 0 },
        plan: null,
        planSequence: null,
        preview: null,
        last: null,
        busy: null,
        reach: null,
    })
    readonly options = persistentStore<ManipulationOptions>("lv.manip", { mode: "joint", speed: 1, display: "visual", obstacles: true, grasps: true, grid: true, interact: true, gizmoScalesWithView: false, gizmoLinks: {} })
    /** the poses saved for the loaded URDF (`robot`: its name; null until one loads) */
    readonly saved = new Store<{ robot: string | null; poses: SavedPose[]; error: string | null }>({ robot: null, poses: [], error: null })
    /** a gizmo's drag is moving the target and it isn't committed yet: polls keep it */
    readonly gizmo = new Store<{ dragging: boolean }>({ dragging: false })
    #polling: ReturnType<typeof setInterval> | null = null
    #inFlight = false
    #uncommitted = false
    #checking = false
    #checkAgain = false
    /** the target sequence this page edited last: only its own edits take the check's other half (and send it on) */
    #localSequence = -1
    /** bumps whenever this page sets the plan: a poll that started before then carries an older plan, not this one */
    #planEpoch = 0
    /** committed targets before the current one, newest last: undo steps back through them */
    #history: (ManipulationTarget | null)[] = []
    #committedTarget: ManipulationTarget | null = null

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

    /** Whether a planner answers at all, every few seconds while nothing shows it (the full poll is setActive's). */
    watch() {
        setInterval(() => this.#polling === null && this.refresh(), WATCH_MS)
        this.refresh()
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
        const planEpoch = this.#planEpoch
        try {
            const answer = await this.#call("GET", "api/manipulation")
            if (answer.available) {
                const groups = (answer.groups as PlanningGroup[]) ?? []
                const hadHook = this.state.get().hook !== null
                const known = new Set(groups.map((group) => group.id))
                const served = (answer.target as ManipulationTarget | null) ?? null
                // a target left from another blueprint's planner (its groups aren't this one's) is no target
                const target = this.#uncommitted ? this.state.get().target : served && served.groups.every((group) => known.has(group)) ? served : null
                const changed = JSON.stringify(target) !== JSON.stringify(this.state.get().target)
                this.state.update({
                    available: true,
                    error: null,
                    planner: answer.state as PlannerState,
                    groups,
                    hook: (answer.hook as HookInfo | null) ?? null,
                    target,
                    ...(planEpoch === this.#planEpoch ? { plan: this.#samePlan(wholePlan(answer.plan as ManipulationPlan | null)) } : {}),
                    ...(this.state.get().selected.length && this.state.get().selected.every((group) => known.has(group)) ? {} : { selected: defaultSelection(groups) }),
                })
                if (target && target.groups.length && !this.#uncommitted) {
                    this.state.update({ selected: target.groups })
                }
                if (changed || (!hadHook && this.state.get().hook)) {
                    this.#edited(false)
                }
            } else {
                this.state.update({ available: false, error: String(answer.error ?? "no ManipulationModule answered") })
            }
        } catch (error) {
            this.state.update({ available: false, error: String(error) })
        } finally {
            this.#inFlight = false
        }
    }

    /** the plan held already when it's the same one (the preview's id and freshness stay put) */
    #samePlan(plan: ManipulationPlan | null): ManipulationPlan | null {
        const held = this.state.get().plan
        return plan && held && plan.id === held.id ? held : plan
    }

    groupById(id: string): PlanningGroup | undefined {
        return this.state.get().groups.find((group) => group.id === id)
    }

    /** The selected groups' measured joints. */
    currentJoints(groups = this.state.get().selected): Record<string, number> {
        const planner = this.state.get().planner
        const joints: Record<string, number> = {}
        for (const id of groups) {
            const measured = planner?.groups[id]?.joints
            measured?.name.forEach((name, index) => (joints[name] = measured.position[index]))
        }
        return joints
    }

    /** viser's group toggle: the target keeps the groups still selected, plus the new group's current joints. */
    toggleGroup(id: string) {
        const { selected, target } = this.state.get()
        const next = selected.includes(id) ? selected.filter((group) => group !== id) : [...selected, id]
        // viser's order: groups with a tip first, then by id
        next.sort((a, b) => Number(!this.groupById(a)?.tip_frame) - Number(!this.groupById(b)?.tip_frame) || a.localeCompare(b))
        this.state.update({ selected: next })
        if (!target) {
            return
        }
        const keep = new Set(next.flatMap((group) => this.groupById(group)?.joint_names ?? []))
        const joints = { ...this.currentJoints(next), ...Object.fromEntries(Object.entries(target.joints).filter(([name]) => keep.has(name))) }
        const poses = Object.fromEntries(Object.entries(target.poses).filter(([group]) => next.includes(group)))
        this.setTarget(next.length ? { ...target, groups: next, joints, poses, source: "joints" } : null)
    }

    /** The ghost follows at once; the backend (and other pages) get it when the drag or slide ends (`commit`). */
    setTarget(target: ManipulationTarget | null, commit = true) {
        this.state.update({ target, preview: null, ...(target?.source === "cartesian" ? {} : { reach: null }) })
        this.#uncommitted = !commit
        this.#edited(true)
        this.#localSequence = this.state.get().targetSequence
        if (commit) {
            this.#remember(target)
            this.#commit(target)
        }
    }

    /** The target as it was before the last committed edit (a whole drag is one step). */
    undo() {
        if (!this.#history.length) {
            return
        }
        const previous = this.#history.pop()!
        this.setTarget(previous, false)
        this.#uncommitted = false
        this.#committedTarget = previous
        this.#commit(previous)
    }

    #remember(target: ManipulationTarget | null) {
        if (target !== this.#committedTarget) {
            this.#history = [...this.#history, this.#committedTarget].slice(-50)
            this.#committedTarget = target
        }
    }

    #commit(target: ManipulationTarget | null) {
        const body = target ? { ...target, from: "page" } : { clear: true }
        this.#call("POST", "api/manipulation/target", body).catch((error) => this.state.update({ last: { action: "target", ok: false, message: String(error) } }))
    }

    setReach(reach: ManipulationState["reach"]) {
        this.state.update({ reach })
    }

    /** A new target (or a new hook): a new sequence, the plan goes stale, and the planner checks it (viser's worker). */
    #edited(bump: boolean) {
        const { targetSequence, hook, target } = this.state.get()
        const sequence = bump ? targetSequence + 1 : targetSequence
        this.state.update({
            targetSequence: sequence,
            feasibility: { status: !target ? "unknown" : hook ? "checking" : "unchecked", message: "", sequence },
        })
        if (target && hook) {
            this.#check()
        }
    }

    /** One check in flight, the newest target next (viser's TargetEvaluationWorker); stale answers are dropped. */
    async #check() {
        if (this.#checking) {
            this.#checkAgain = true
            return
        }
        this.#checking = true
        try {
            do {
                this.#checkAgain = false
                const { target, targetSequence } = this.state.get()
                if (!target) {
                    break
                }
                let result: Record<string, unknown>
                try {
                    result = await this.#call("POST", "api/manipulation/evaluate", target)
                } catch (error) {
                    result = { success: false, status: "INVALID", message: String(error) }
                }
                if (this.state.get().targetSequence !== targetSequence) {
                    continue
                }
                this.#applyCheck(target, result)
            } while (this.#checkAgain)
        } finally {
            this.#checking = false
        }
    }

    #applyCheck(target: ManipulationTarget, result: Record<string, unknown>) {
        const feasible = result.success === true && result.collision_free === true
        const status: Feasibility = feasible ? "feasible" : CHECKING_STATUSES[String(result.status)] ?? "invalid"
        const sequence = this.state.get().targetSequence
        const update: Partial<ManipulationState> = { feasibility: { status, message: String(result.message ?? ""), sequence } }
        // this page's edit: the other half of the target follows, as viser's sliders follow a gizmo's IK and a gizmo
        // follows the sliders (another page's edit arrives whole)
        if (sequence === this.#localSequence) {
            if (target.source === "cartesian" && result.joints) {
                update.target = { ...target, joints: { ...target.joints, ...(result.joints as Record<string, number>) } }
            } else if (target.source === "joints" && result.poses) {
                const poses = Object.fromEntries(Object.entries(result.poses as Record<string, Pose>).filter(([group]) => this.groupById(group)?.tip_frame))
                update.target = { ...target, poses: { ...target.poses, ...poses } }
            }
        }
        this.state.update(update)
        if (update.target && !this.#uncommitted) {
            this.#commit(update.target)
        }
    }

    /** viser's Preset menu: Current, Init or Home joints for the selected groups. */
    async preset(name: "current" | "init" | "home") {
        try {
            const answer = await this.#call("POST", "api/manipulation/target", { preset: name, groups: this.state.get().selected })
            this.#remember(answer.target as ManipulationTarget)
            this.state.update({ target: answer.target as ManipulationTarget, preview: null, reach: null })
            this.#uncommitted = false
            this.#edited(true)
            this.#localSequence = this.state.get().targetSequence
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

    /** viser's can_plan: a target the planner found feasible (when there's a hook to ask), and the planner idle. */
    canPlan(): boolean {
        const { target, feasibility, hook, busy } = this.state.get()
        return !!target && busy === null && this.#plannerIdle() && (hook ? feasibility.status === "feasible" : true)
    }

    /** viser's plan freshness: made for this exact target, groups and planning mode. */
    planIsFresh(): boolean {
        const { plan, planSequence, targetSequence, selected } = this.state.get()
        return !!plan && planSequence === targetSequence && plan.mode === this.options.get().mode && plan.groups.join() === selected.join()
    }

    canExecute(): boolean {
        const { busy, feasibility, hook } = this.state.get()
        return this.planIsFresh() && busy === null && this.#plannerIdle() && (hook ? feasibility.status === "feasible" : true)
    }

    canCancel(): boolean {
        const { busy, planner } = this.state.get()
        return busy === "plan" || busy === "execute" || planner?.operation_status.name === "EXECUTING" || planner?.execution_status.name === "EXECUTING"
    }

    #plannerIdle(): boolean {
        const status = this.state.get().planner?.operation_status.name
        return status === "IDLE" || status === "COMPLETED"
    }

    async plan() {
        const { targetSequence } = this.state.get()
        let target = this.state.get().target
        // a pose on another link than the planner's tip isn't a pose the planner can reach for: cartesian mode leaves it out
        const moved = Object.keys(this.options.get().gizmoLinks ?? {})
        if (target && this.options.get().mode === "cartesian" && moved.some((group) => group in target!.poses)) {
            target = { ...target, poses: Object.fromEntries(Object.entries(target.poses).filter(([group]) => !moved.includes(group))) }
        }
        const answer = await this.#act("plan", "api/manipulation/plan", target ? { ...target, mode: this.options.get().mode, speed: this.options.get().speed, from: "page" } : { from: "page" })
        if (answer) {
            this.#planEpoch++
            this.state.update({ plan: wholePlan(answer.plan as ManipulationPlan | null), planSequence: answer.plan ? targetSequence : null, preview: null })
        }
    }

    /** Plans first when the target has no fresh plan yet: one press, not Plan then Preview. */
    async preview() {
        if (!(await this.#planned())) {
            return
        }
        this.#act("preview", "api/manipulation/preview")
        this.startPreview()
    }
    /** Whether a fresh plan for the target exists, planning it now if it doesn't. */
    async #planned(): Promise<boolean> {
        if (!this.planIsFresh()) {
            await this.plan()
        }
        return this.planIsFresh()
    }
    /** Preview or Execute can go: a fresh plan, or a target that can be planned. */
    canRun(): boolean {
        return this.planIsFresh() ? this.canExecute() : this.canPlan()
    }

    startPreview(id?: string) {
        const plan = this.state.get().plan
        if (plan && (!id || id === plan.id)) {
            this.state.update({ preview: { id: plan.id, startedAt: performance.now() } })
        }
    }

    /** Plans first when the target has no fresh plan yet: one press, not Plan then Execute. */
    async execute() {
        if (!(await this.#planned())) {
            return
        }
        this.state.update({ preview: null })
        this.#act("execute", "api/manipulation/execute")
    }

    /** Loads the poses saved for `robot` (the URDF's name), once per name. */
    async loadSavedPoses(robot: string) {
        if (this.saved.get().robot === robot) {
            return
        }
        this.saved.update({ robot, poses: [], error: null })
        try {
            const answer = await this.#call("GET", `api/manipulation/poses?robot=${encodeURIComponent(robot)}`)
            if (this.saved.get().robot === robot) {
                this.saved.update({ poses: (answer.poses as SavedPose[]) ?? [] })
            }
        } catch (error) {
            this.saved.update({ error: String(error) })
        }
    }

    /** Writes the whole list (every open page follows). */
    async #storePoses(poses: SavedPose[]) {
        const robot = this.saved.get().robot
        if (!robot) {
            return
        }
        const before = this.saved.get().poses
        this.saved.update({ poses, error: null })
        try {
            await this.#call("PUT", "api/manipulation/poses", { robot, poses, from: "page" })
        } catch (error) {
            this.saved.update({ poses: before, error: String(error) })
        }
    }

    /** The target as a saved pose (no target: the selected groups' joints as they are now). */
    savePose(name: string, color?: string) {
        const { target, selected } = this.state.get()
        const pose: SavedPose = { name, ...(color ? { color } : {}), target: target ?? { groups: selected, joints: this.currentJoints(), poses: {}, source: "joints" } }
        return this.#storePoses([...this.saved.get().poses, pose])
    }

    editPose(index: number, change: Partial<SavedPose> | null) {
        const poses = [...this.saved.get().poses]
        if (change) {
            poses[index] = { ...poses[index], ...change }
        } else {
            poses.splice(index, 1)
        }
        return this.#storePoses(poses)
    }

    /** A saved pose becomes the target (it moves nothing: Preview / Execute do). */
    applyPose(index: number) {
        const pose = this.saved.get().poses[index]
        if (!pose) {
            return
        }
        if (pose.target.groups.length) {
            this.state.update({ selected: pose.target.groups })
        }
        this.setTarget(structuredClone(pose.target))
    }

    cancel() {
        this.state.update({ preview: null })
        this.#act("cancel", "api/manipulation/cancel")
    }

    /** The plan, its preview and the target the gizmo moved: the arm's gizmo goes back to its tip (undo brings the target back). */
    clear() {
        this.#planEpoch++
        this.state.update({ plan: null, planSequence: null, preview: null })
        this.#act("clear", "api/manipulation/clear")
        if (this.state.get().target) {
            this.setTarget(null)
        }
    }

    /** The backend's `manipulation` event: another page's or the agent's target, plan, preview or execute. */
    applyEvent(event: Record<string, unknown>) {
        // the target a plan was made for comes back with it: this page's own plan (it's planning), or the same target,
        // is no edit (bumping the sequence would make the plan just made stale, and Preview would do nothing)
        const ownPlan = "plan" in event && this.state.get().busy === "plan"
        if ("target" in event && event.from !== "page" && !ownPlan && canonical(event.target) !== canonical(this.state.get().target)) {
            const target = event.target as ManipulationTarget | null
            this.#committedTarget = target
            this.state.update({ target, reach: null, ...(target?.groups.length ? { selected: target.groups } : {}) })
            this.#edited(true)
        }
        if ("plan" in event) {
            const plan = wholePlan(event.plan as ManipulationPlan | null)
            // this page's own plan coming back: nothing changes (its preview keeps playing)
            if (!(plan && plan.id === this.state.get().plan?.id)) {
                // a plan made elsewhere for the target just set is fresh for it
                this.#planEpoch++
                this.state.update({ plan, planSequence: plan ? this.state.get().targetSequence : null, preview: null })
            }
        }
        const saved = event.savedPoses as { robot: string; poses: SavedPose[] } | undefined
        if (saved && saved.robot === this.saved.get().robot) {
            this.saved.update({ poses: saved.poses })
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

/** JSON with object keys sorted: the same value from the backend (its own key order) compares equal. */
export function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, inner) =>
        inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner)
}

/** A plan whose duration reaches its last point: a planner's speed scaling can stretch the points' times past the
 * duration it reports, and a preview stopped at that duration never got to the target. */
export function wholePlan(plan: ManipulationPlan | null | undefined): ManipulationPlan | null {
    if (!plan) {
        return null
    }
    const last = plan.times.at(-1) ?? 0
    return last > plan.duration ? { ...plan, duration: last } : plan
}

/** viser's first selection: the first group with a tip, else the first group. */
export function defaultSelection(groups: PlanningGroup[]): string[] {
    const first = groups.find((group) => group.tip_frame) ?? groups[0]
    return first ? [first.id] : []
}

/** viser's slider for a joint: limited (its limits), circle (-pi..pi, wrapped) or line (unbounded: a number box). */
export function jointControl(topology: string | undefined, limit: [number, number] | undefined, urdfType: string | undefined): { kind: "slider" | "number"; min: number; max: number; wrap: boolean } {
    const kind = topology ?? (urdfType === "continuous" ? "circle" : !limit ? "line" : "limited")
    if (kind === "line") {
        return { kind: "number", min: -Infinity, max: Infinity, wrap: false }
    }
    if (kind === "circle" || !limit) {
        return { kind: "slider", min: -Math.PI, max: Math.PI, wrap: true }
    }
    return { kind: "slider", min: limit[0], max: limit[1], wrap: false }
}

/** An angle wrapped into -pi..pi (viser's angle_diff(value, 0)). */
export function wrapAngle(value: number): number {
    return Math.atan2(Math.sin(value), Math.cos(value))
}
