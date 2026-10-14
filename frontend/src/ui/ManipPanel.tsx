// The arm's planner panel, viser's Manipulation Panel: the planner's state, the target (planning mode, presets, joint
// targets; or drag the gizmo in the 3D view), the reach of a dragged pose, the next plan's speed, Plan / Preview /
// Execute / Cancel / Clear plan, and the 3D arm's display. Every action is an api/manipulation endpoint
// (core/manipulation.ts); the planner is dimos's ManipulationModule.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import type { ManipulationTarget, PlanningMode } from "../core/manipulation.ts"
import { Badge, Button, Field, Heading, Select, Slider, Toggle } from "dimos-react"

const degrees = (radians: number) => `${((radians * 180) / Math.PI).toFixed(1)}°`

type Tone = "default" | "info" | "ok" | "warn" | "danger"

function statusTone(name: string | null | undefined): Tone {
    switch (name) {
        case "EXECUTING":
        case "PLANNING":
            return "info"
        case "COMPLETED":
        case "IDLE":
            return "ok"
        case "FAULT":
        case "ABORTED":
            return "danger"
        default:
            return "default"
    }
}

export function ManipPanel({ app }: { app: ViewerApp }) {
    const manipulation = app.manipulation
    const state = useStore(manipulation.state)
    const options = useStore(manipulation.options)
    const gizmo = useStore(manipulation.gizmo)
    const view = useStore(app.manipView.status)
    const group = state.groups[0]
    const groupState = group ? state.planner?.groups[group.id] : undefined
    const current: Record<string, number> = groupState ? Object.fromEntries(groupState.joints.name.map((name, index) => [name, groupState.joints.position[index]])) : {}
    const target = state.target
    const limits = (name: string): [number, number] => app.manipView.model?.kinematics.joints.get(name)?.limit ?? [-Math.PI, Math.PI]
    const busy = state.busy !== null
    const executing = state.planner?.operation_status.name === "EXECUTING" || state.planner?.execution_status.name === "EXECUTING"

    if (state.available === false) {
        return (
            <div className="manip-panel" data-testid="manip-panel">
                <p className="hint" data-testid="manip-unavailable">
                    No planner: nothing answers dimos's <code>ManipulationModule</code> RPCs ({state.error}). Run a manipulation blueprint (e.g. <code>xarm-perception-sim</code>); the jog controls below work without it.
                </p>
            </div>
        )
    }

    /** a joint target from the current joints (or the target's), with one joint changed */
    const jointTarget = (name: string, value: number): ManipulationTarget => {
        const base = target?.mode === "joint" && target.joints ? target.joints : current
        return { mode: "joint", group: group?.id ?? "manipulator", joints: { ...current, ...base, [name]: value } }
    }
    const shown = (name: string) => (target?.mode === "joint" && target.joints?.[name] !== undefined ? target.joints[name] : current[name] ?? 0)

    return (
        <div className="manip-panel" data-testid="manip-panel">
            <div className="manip-status" data-testid="manip-status">
                <Badge tone={statusTone(state.planner?.operation_status.name)} dot>{state.planner?.operation_status.name ?? "…"}</Badge>
                <span className="hint">execution <b>{state.planner?.execution_status.name ?? "—"}</b></span>
                {group && <span className="hint">group <code>{group.id}</code> · tip <code>{group.tip_frame}</code></span>}
            </div>
            {view.model ? <p className="hint" data-testid="manip-model">3D arm: {view.model}</p> : <p className="hint">3D arm: waiting for a RobotDescriptionModule on <code>/robot_description</code>.</p>}
            {state.planner?.error && <p className="problem">{state.planner.error}</p>}

            <Heading level={3}>Target</Heading>
            <Field inline label="Planning mode">
                <Select<PlanningMode>
                    aria-label="Planning mode"
                    value={options.mode}
                    options={[["joint", "Joint space"], ["cartesian", "Cartesian space"]]}
                    onChange={(mode: PlanningMode) => manipulation.options.update({ mode })}
                />
            </Field>
            <div className="button-row" data-testid="manip-presets">
                <Button size="sm" onClick={() => manipulation.preset("current")} title="The target is where the arm is now">Current</Button>
                <Button size="sm" onClick={() => manipulation.preset("init")} title="Where the arm was when the planner started">Init</Button>
                <Button size="sm" onClick={() => manipulation.preset("home")} title="The robot's home joints">Home</Button>
                <Button size="sm" variant="ghost" disabled={!target} onClick={() => manipulation.setTarget(null)}>Clear target</Button>
            </div>
            <div className="button-row" data-testid="manip-gizmo">
                <span className="hint">Gizmo:</span>
                <Button size="sm" pressed={gizmo.mode === "translate"} onClick={() => manipulation.gizmo.update({ mode: "translate" })}>Move</Button>
                <Button size="sm" pressed={gizmo.mode === "rotate"} onClick={() => manipulation.gizmo.update({ mode: "rotate" })}>Rotate</Button>
            </div>
            <p className="hint" data-testid="manip-target">
                {!target
                    ? "No target: drag the gizmo on the arm's tip in the 3D view, move a joint below, or pick a preset."
                    : target.mode === "cartesian" && target.pose
                    ? <>Pose target ({target.pose.position.map((value) => value.toFixed(3)).join(", ")}) m{" "}
                        {state.reach && <Badge tone={state.reach.reachable ? "ok" : "warn"} data-testid="manip-reach">{state.reach.reachable ? "reachable" : `unreachable (${(state.reach.positionError * 100).toFixed(1)} cm off)`}</Badge>}</>
                    : `Joint target${target.preset ? ` (${target.preset})` : ""}`}
            </p>
            {group && options.mode === "joint" && (
                <div className="manip-joints" data-testid="manip-joints">
                    {group.joint_names.map((name) => {
                        const [min, max] = limits(name)
                        return (
                            <div className="joint-row" key={name} data-joint={name}>
                                <span className="joint-name">{name}</span>
                                <Slider
                                    className="joint-slider"
                                    aria-label={`${name} target`}
                                    min={min}
                                    max={max}
                                    step={0.01}
                                    value={shown(name)}
                                    showValue={false}
                                    onChange={(value: number) => manipulation.setTarget(jointTarget(name, value), false)}
                                    onCommit={(value: number) => manipulation.setTarget(jointTarget(name, value), true)}
                                />
                                <span className="joint-value">{degrees(shown(name))}</span>
                            </div>
                        )
                    })}
                </div>
            )}

            <Heading level={3}>Plan</Heading>
            <Field inline label="Next plan speed">
                <Slider min={0.05} max={1} step={0.05} value={options.speed} format={(speed: number) => `${Math.round(speed * 100)}%`} onChange={(speed: number) => manipulation.options.update({ speed })} />
            </Field>
            <div className="button-row manip-actions" data-testid="manip-actions">
                <Button size="sm" variant="primary" disabled={!target || busy || executing} loading={state.busy === "plan"} onClick={() => manipulation.plan()} data-testid="manip-plan">Plan</Button>
                <Button size="sm" disabled={!state.plan || busy} onClick={() => manipulation.preview()} data-testid="manip-preview">Preview</Button>
                <Button size="sm" disabled={!state.plan || busy || executing} loading={state.busy === "execute"} onClick={() => manipulation.execute()} data-testid="manip-execute">Execute</Button>
                <Button size="sm" variant="danger" disabled={!executing && state.busy !== "plan"} onClick={() => manipulation.cancel()} data-testid="manip-cancel">Cancel</Button>
                <Button size="sm" variant="ghost" disabled={!state.plan} onClick={() => manipulation.clear()} data-testid="manip-clear">Clear plan</Button>
            </div>
            {state.plan && <p className="hint" data-testid="manip-plan-info">Plan {state.plan.id.slice(0, 8)}: {state.plan.duration.toFixed(2)} s, {state.plan.positions.length} points{state.preview ? " · previewing" : ""}</p>}
            {state.last && <p className={state.last.ok ? "hint" : "warn-text"} data-testid="manip-last">{state.last.action}: {state.last.message || (state.last.ok ? "ok" : "failed")}</p>}

            <Heading level={3}>Display</Heading>
            <Field inline label="Arm in 3D"><Toggle value={options.interact} onChange={(interact: boolean) => manipulation.options.update({ interact })} /></Field>
            <Field inline label="Robot display">
                <Select<string>
                    aria-label="Robot display"
                    value={options.display}
                    options={[["visual", "Visual"], ["collision", "Collision"], ["both", "Both"]]}
                    onChange={(display: string) => manipulation.options.update({ display: display as "visual" | "collision" | "both" })}
                />
            </Field>
            <Field inline label="Obstacles"><Toggle value={options.obstacles} onChange={(obstacles: boolean) => manipulation.options.update({ obstacles })} /></Field>
        </div>
    )
}
