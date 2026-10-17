// The arm's planner panel. At the top: Preview / Execute (each planning first when needed) / Cancel / Clear plan, the planning-group
// toggles and the scene (grid, robot display, gizmo size, obstacles, grasps). Then
// viser's Manipulation Panel in its order: status, target (preset, feasibility, the gizmo: arrows move, arcs rotate), planning (next plan speed, planning mode), and joint control. Every action is an
// api/manipulation endpoint (core/manipulation.ts); the planner is dimos's ManipulationModule, and what the RPCs
// don't give (the model, feasibility, obstacle shapes, grasps) comes from dim-controller's hook in its process.
import { useEffect, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { isTypingTarget } from "./keymap.ts"
import { useStore } from "../core/store.ts"
import { canonical, jointControl, type ManipulationTarget, type PlanningMode, wrapAngle } from "../core/manipulation.ts"
import { Badge, Button, Field, Heading, NumberInput, Select, Slider, Toggle } from "dimos-react"

const degrees = (radians: number) => `${((radians * 180) / Math.PI).toFixed(1)}°`

type Tone = "default" | "info" | "ok" | "warn" | "danger"

function statusTone(name: string | null | undefined): Tone {
    switch (name) {
        case "EXECUTING":
        case "PLANNING":
        case "CHECKING":
            return "info"
        case "COMPLETED":
        case "IDLE":
        case "FEASIBLE":
        case "FRESH":
            return "ok"
        case "STALE":
        case "UNCHECKED":
            return "warn"
        case "FAULT":
        case "ABORTED":
        case "INFEASIBLE":
        case "FAILED":
            return "danger"
        default:
            return "default"
    }
}

export function ManipPanel({ app }: { app: ViewerApp }) {
    const manipulation = app.manipulation
    const state = useStore(manipulation.state)
    const options = useStore(manipulation.options)
    const view = useStore(app.manipView.status)
    const { target, selected, hook, planner } = state
    const current = manipulation.currentJoints()
    const busy = state.busy !== null

    // Ctrl+Z (Cmd+Z on a Mac) puts the target back where it was before its last edit
    useEffect(() => {
        const undo = (event: KeyboardEvent) => {
            if (event.code === "KeyZ" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !isTypingTarget(event.target)) {
                event.preventDefault()
                manipulation.undo()
            }
        }
        addEventListener("keydown", undo)
        return () => removeEventListener("keydown", undo)
    }, [manipulation])

    if (state.available === false) {
        return (
            <div className="manip-panel" data-testid="manip-panel">
                <p className="hint" data-testid="manip-unavailable">
                    No planner: nothing answers dimos's <code>ManipulationModule</code> RPCs ({state.error}). Run a manipulation blueprint (e.g. <code>xarm-perception-sim</code>); the jog controls below work without it.
                </p>
            </div>
        )
    }

    const targetStatus = !target ? "EMPTY" : state.feasibility.status === "checking" ? "CHECKING" : state.feasibility.status === "feasible" ? "FEASIBLE" : state.feasibility.status === "unchecked" ? "UNCHECKED" : "INFEASIBLE"
    const planStatus = state.busy === "plan" ? "PLANNING" : state.plan ? (manipulation.planIsFresh() ? "FRESH" : "STALE") : state.last?.action === "plan" && !state.last.ok ? "FAILED" : "NONE"
    const stale = selected.some((group) => !planner?.groups[group]?.joints)
    const moduleState = planner?.error ?? planner?.operation_status.name ?? "…"

    /** the sliders' target: the selected groups' current joints under the target's, with one joint changed */
    const jointTarget = (name: string, value: number): ManipulationTarget => ({
        groups: selected,
        joints: { ...current, ...(target?.joints ?? {}), [name]: value },
        poses: target?.poses ?? {},
        source: "joints",
    })
    const shown = (name: string) => target?.joints[name] ?? current[name] ?? 0
    const urdfJoint = (name: string) => app.manipView.model?.kinematics.joints.get(name)

    return (
        <div className="manip-panel" data-testid="manip-panel">
            <ManipActions app={app} />
            {state.plan && <p className="hint" data-testid="manip-plan-info">Plan {state.plan.id.slice(0, 8)} ({state.plan.mode}): {state.plan.duration.toFixed(2)} s, {state.plan.positions.length} points{state.preview ? " · previewing" : ""}</p>}

            <SavedPoses app={app} />

            <Heading level={3}>Planning Groups</Heading>
            <div className="button-row" data-testid="manip-groups">
                {state.groups.map((group) => (
                    <Button key={group.id} size="sm" pressed={selected.includes(group.id)} onClick={() => manipulation.toggleGroup(group.id)} title="Toggle this planning group in the target set" data-group={group.id}>{group.id}</Button>
                ))}
            </div>

            <Heading level={3}>Scene</Heading>
            <Field inline label="Scene grid"><Toggle value={options.grid} onChange={(grid: boolean) => manipulation.options.update({ grid })} /></Field>
            <Field inline label="Robot display">
                <Select<string>
                    aria-label="Robot display"
                    value={options.display}
                    options={[["visual", "Visual"], ["collision", "Collision"], ["both", "Both"]]}
                    onChange={(display: string) => manipulation.options.update({ display: display as "visual" | "collision" | "both" })}
                />
            </Field>
            {options.display !== "visual" && view.collisionMissing && <p className="warn-text" data-testid="manip-collision-warning"><b>Collision meshes unavailable.</b> Showing visual geometry with collision styling.</p>}
            <Field inline label="Arm in 3D"><Toggle value={options.interact} onChange={(interact: boolean) => manipulation.options.update({ interact })} /></Field>
            <Field inline label="Gizmo scales with view" title="on: the gizmo keeps one size on screen as you zoom; off: a fixed size beside the arm"><Toggle value={options.gizmoScalesWithView} onChange={(gizmoScalesWithView: boolean) => manipulation.options.update({ gizmoScalesWithView })} /></Field>
            <Field inline label="Obstacles"><Toggle value={options.obstacles} onChange={(obstacles: boolean) => manipulation.options.update({ obstacles })} /></Field>
            <Field inline label="Grasp proposals"><Toggle value={options.grasps} onChange={(grasps: boolean) => manipulation.options.update({ grasps })} /></Field>
            <p className="hint" data-testid="manip-scene">{view.obstacleCount} obstacles · {view.graspCount} grasp proposals</p>
            {view.obstacleProblems.map((problem) => <p className="warn-text" key={problem}>⚠ Obstacle drawn as a stand-in: {problem}</p>)}

            <Heading level={3}>Status</Heading>
            <div className="manip-status" data-testid="manip-status">
                <span className="hint">State</span> <Badge tone={statusTone(planner?.operation_status.name)} dot data-testid="manip-state">{moduleState}</Badge>
                <span className="hint">Target</span> <Badge tone={statusTone(targetStatus)} data-testid="manip-target-status">{targetStatus}</Badge>
                <span className="hint">Plan</span> <Badge tone={statusTone(planStatus)} data-testid="manip-plan-status">{planStatus}</Badge>
            </div>
            {selected.length > 0 && <p className="hint">State stale: <code>{String(stale)}</code> · execution <b>{planner?.execution_status.name ?? "—"}</b></p>}
            {Object.keys(current).length > 0 && <p className="hint" data-testid="manip-current">Current joints: <code>[{Object.values(current).map((value) => value.toFixed(3)).join(", ")}]</code></p>}
            {state.last && <p className={state.last.ok ? "hint" : "warn-text"} data-testid="manip-last">Last result: {state.last.action}{state.last.ok ? "" : " failed"}{state.last.message ? `: ${state.last.message}` : ""}</p>}
            <p className="hint" data-testid="manip-hook">
                {hook
                    ? <>Planner's process (pid {hook.pid}): model, feasibility, obstacles and grasps from dim-controller's hook{hook.visualization ? `, beside ${hook.visualization}` : ""}.</>
                    : <>No dim-controller hook in the planner's process: {view.model ? "no live collision check, obstacle shapes or grasps" : "no 3D arm, live collision check, obstacle shapes or grasps"}. <HookInstall app={app} /></>}
            </p>
            {view.model ? <p className="hint" data-testid="manip-model">3D arm: {view.model}</p> : view.problem && <p className="hint">3D arm: {view.problem}</p>}

            <Heading level={3}>Target</Heading>
            {selected.map((group) => {
                const { links, fallback } = app.manipView.gizmoChoices(group)
                if (!links.length) {
                    return null
                }
                const choose = (link: string) => {
                    const gizmoLinks = { ...options.gizmoLinks }
                    if (link) {
                        gizmoLinks[group] = link
                    } else {
                        delete gizmoLinks[group]
                    }
                    manipulation.options.update({ gizmoLinks })
                    // the gizmo starts over on its new link
                    if (target?.poses[group]) {
                        const { [group]: _dropped, ...poses } = target.poses
                        manipulation.setTarget({ ...target, poses })
                    }
                }
                return (
                    <Field inline key={group} label={`${group} gizmo on`} title="the link the gizmo sits on and the IK moves (only this group's and the other selected groups' joints move)">
                        <Select<string> aria-label={`${group} gizmo link`} value={options.gizmoLinks?.[group] ?? ""} options={[["", `${fallback} (default)`], ...links.filter((link) => link !== fallback).map((link) => [link, link] as [string, string])]} onChange={choose} />
                    </Field>
                )
            })}
            <Field inline label="Preset">
                <Select<string>
                    aria-label="Preset"
                    value=""
                    placeholder="Select preset..."
                    options={[
                        ...(selected.every((group) => planner?.groups[group]?.joint_presets.init) && selected.length ? [["init", "Init"] as [string, string]] : []),
                        ["current", "Current"],
                        ...(selected.every((group) => planner?.groups[group]?.joint_presets.home) && selected.length ? [["home", "Home"] as [string, string]] : []),
                    ]}
                    onChange={(preset: string) => manipulation.preset(preset as "current" | "init" | "home")}
                />
            </Field>
            <p className="hint" data-testid="manip-feasibility">
                Feasibility: <code>{hook ? state.feasibility.status : "unchecked (no hook)"}</code>
                {state.feasibility.message && state.feasibility.status !== "feasible" ? ` · ${state.feasibility.message}` : ""}
                {!hook && state.reach && <> · <Badge tone={state.reach.reachable ? "ok" : "warn"} data-testid="manip-reach">{state.reach.reachable ? "reachable" : `unreachable (${(state.reach.positionError * 100).toFixed(1)} cm off)`}</Badge></>}
            </p>
            <div className="button-row" data-testid="manip-gizmo">
                <span className="hint">Gizmo: drag an arrow to move, a ring to rotate</span>
                <Button size="sm" variant="ghost" disabled={!target} onClick={() => manipulation.setTarget(null)}>Clear target</Button>
            </div>

            <Heading level={3}>Planning</Heading>
            <Field inline label="Next plan speed">
                <Slider min={0.05} max={1} step={0.05} value={options.speed} disabled={busy} format={(speed: number) => `${Math.round(speed * 100)}%`} onChange={(speed: number) => manipulation.options.update({ speed })} />
            </Field>
            <Field inline label="Planning mode">
                <Select<PlanningMode>
                    aria-label="Planning mode"
                    value={options.mode}
                    options={[["joint", "Joint space"], ["cartesian", "Cartesian space"]]}
                    onChange={(mode: PlanningMode) => manipulation.options.update({ mode })}
                />
            </Field>
            <details className="manip-joint-control" data-testid="manip-joint-control">
                <summary>Joint Control</summary>
                <div className="manip-joints" data-testid="manip-joints">
                    {selected.flatMap((groupId) => manipulation.groupById(groupId)?.joint_names.map((name) => {
                        const joint = urdfJoint(name)
                        const control = jointControl(hook?.joint_topology[name], joint?.limit, joint?.type)
                        const value = control.wrap ? wrapAngle(shown(name)) : shown(name)
                        return (
                            <div className="joint-row" key={`${groupId}/${name}`} data-joint={name}>
                                <span className="joint-name" title={`${groupId}/${name}`}>{name}</span>
                                {control.kind === "number"
                                    ? <NumberInput size="sm" aria-label={`${name} target`} value={value} step={0.001} precision={3} onChange={(next: number) => manipulation.setTarget(jointTarget(name, next), true)} />
                                    : <Slider
                                        className="joint-slider"
                                        aria-label={`${name} target`}
                                        min={control.min}
                                        max={control.max}
                                        step={0.001}
                                        value={value}
                                        showValue={false}
                                        onChange={(next: number) => manipulation.setTarget(jointTarget(name, next), false)}
                                        onCommit={(next: number) => manipulation.setTarget(jointTarget(name, next), true)}
                                    />}
                                <span className="joint-value">{control.kind === "number" ? "" : degrees(value)}</span>
                            </div>
                        )
                    }) ?? [])}
                </div>
            </details>

        </div>
    )
}

/** Puts the hook into the venv of every running `dimos run`; it loads when the blueprint restarts. */
function HookInstall({ app }: { app: ViewerApp }) {
    const install = async () => {
        const response = await fetch(new URL("api/manipulation/hook/install", location.href).href, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
        const answer = await response.json().catch(() => ({}))
        app.manipulation.state.update({ last: { action: "install hook", ok: response.ok, message: String(answer.output ?? answer.error ?? "") } })
    }
    return <Button size="sm" onClick={install} data-testid="manip-hook-install" title="Install it into the running blueprint's venv; restart the blueprint to load it">Install hook</Button>
}

/** Preview / Execute (each planning first when needed) / Cancel / Clear plan: the panel's top row, and the focused 3D
 * view's while there's a target (ui/ScenePanel.tsx). */
export function ManipActions({ app, testid = "manip" }: { app: ViewerApp; testid?: string }) {
    const manipulation = app.manipulation
    const state = useStore(manipulation.state)
    useStore(manipulation.options)
    const busy = state.busy !== null
    return (
        <div className="button-row manip-actions" data-testid={`${testid}-actions`}>
            <Button size="sm" title="plans first if the target has no plan yet" disabled={!manipulation.canRun() || busy} loading={state.busy === "plan" || state.busy === "preview"} onClick={() => void manipulation.preview()} data-testid={`${testid}-preview`}>Preview</Button>
            <Button size="sm" variant="primary" title="plans first if the target has no plan yet" disabled={!manipulation.canRun()} loading={state.busy === "execute"} onClick={() => void manipulation.execute()} data-testid={`${testid}-execute`}>Execute</Button>
            {manipulation.canCancel() && <Button size="sm" variant="danger" onClick={() => manipulation.cancel()} data-testid={`${testid}-cancel`}>Cancel</Button>}
            <Button size="sm" variant="ghost" disabled={!state.plan && !state.target} title="drops the plan and the target: the gizmo goes back to the arm (Ctrl+Z brings the target back)" onClick={() => manipulation.clear()} data-testid={`${testid}-clear`}>Clear plan</Button>
        </div>
    )
}

/** a saved pose's second press executes only this long after the first: a double click previews, it doesn't run */
const ARM_DELAY_MS = 200
const POSE_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#3e63dd", "#8e4ec6", "#d6409f", "#8b8d98"]

/** Saved poses (poses.yaml per URDF name): a button each that makes it the target, right-click to recolor, rename or
 * delete; Save pose keeps the target (or the arm as it is) under a name and color. */
function SavedPoses({ app }: { app: ViewerApp }) {
    const manipulation = app.manipulation
    const saved = useStore(manipulation.saved)
    const [adding, setAdding] = useState<{ name: string; color: string } | null>(null)
    const [editing, setEditing] = useState<number | null>(null)
    const edited = editing === null ? null : saved.poses[editing]
    const state = useStore(manipulation.state)
    // first press previews (the pose becomes the target), a second one at least ARM_DELAY_MS later executes; while
    // it runs the button is Stop. Armed only while the target is still that pose's.
    const [armed, setArmed] = useState<{ index: number; at: number } | null>(null)
    const [running, setRunning] = useState<number | null>(null)
    const [runStarted, setRunStarted] = useState(0)
    const executing = manipulation.canCancel() && state.busy !== "plan"
    useEffect(() => {
        // the planner's EXECUTING shows on its next poll: give it a moment before calling the run over
        if (running !== null && !executing && state.busy === null && performance.now() - runStarted > 1500) {
            setRunning(null)
        }
    }, [running, executing, state.busy, state.planner, runStarted])
    const armedFor = (index: number) => armed?.index === index && running === null && canonical(saved.poses[index]?.target) === canonical(state.target)
    const press = async (index: number) => {
        if (running === index) {
            manipulation.cancel()
            setRunning(null)
            return
        }
        if (state.busy === "plan") {
            return
        }
        if (armedFor(index)) {
            if (performance.now() - armed!.at < ARM_DELAY_MS) {
                return
            }
            setArmed(null)
            setRunning(index)
            setRunStarted(performance.now())
            await manipulation.execute()
            return
        }
        setArmed({ index, at: performance.now() })
        manipulation.applyPose(index)
        await manipulation.preview()
    }
    return (
        <>
            <Heading level={3}>Saved Poses</Heading>
            <div className="button-row saved-poses" data-testid="manip-saved-poses">
                {saved.poses.map((pose, index) => (
                    <span key={`${index}-${pose.name}`} className="saved-pose-slot">
                        {armedFor(index) && <span className="saved-pose-hint">click again to execute</span>}
                        <Button
                            size="sm"
                            className={`saved-pose ${running === index ? "running" : ""}`}
                            style={pose.color ? { background: pose.color, borderColor: pose.color, color: "#fff" } : undefined}
                            title={`${pose.name} (${pose.target.groups.join(", ")}): press to preview, again to execute, again to stop; right-click to edit`}
                            onClick={() => void press(index)}
                            onContextMenu={(event: React.MouseEvent) => {
                                event.preventDefault()
                                setEditing(editing === index ? null : index)
                            }}
                        >
                            {/* both labels in one cell: the button is as wide as the wider, Stop or the name */}
                            <span className="saved-pose-labels">
                                <span className={running === index ? "hidden" : ""}>{pose.name}</span>
                                <span className={running === index ? "" : "hidden"}>Stop</span>
                            </span>
                        </Button>
                    </span>
                ))}
                {!adding && (
                    <Button size="sm" variant="ghost" disabled={!saved.robot} title={saved.robot ? `save the target (or the arm as it is) for ${saved.robot}` : "no robot model loaded yet"} onClick={() => setAdding({ name: `Pose ${saved.poses.length + 1}`, color: POSE_COLORS[saved.poses.length % POSE_COLORS.length] })} data-testid="manip-save-pose">+ Save pose</Button>
                )}
            </div>
            {adding && (
                <PoseEditor
                    name={adding.name}
                    color={adding.color}
                    onChange={(change) => setAdding({ ...adding, ...change })}
                    done={{ label: "Save", run: () => { void manipulation.savePose(adding.name.trim() || "Pose", adding.color); setAdding(null) } }}
                    other={{ label: "Cancel", run: () => setAdding(null) }}
                />
            )}
            {edited && editing !== null && (
                <PoseEditor
                    name={edited.name}
                    color={edited.color ?? ""}
                    onChange={(change) => void manipulation.editPose(editing, change)}
                    done={{ label: "Done", run: () => setEditing(null) }}
                    other={{ label: "Delete", run: () => { void manipulation.editPose(editing, null); setEditing(null) } }}
                />
            )}
            {saved.error && <p className="warn-text">Saved poses: {saved.error}</p>}
        </>
    )
}

function PoseEditor({ name, color, onChange, done, other }: { name: string; color: string; onChange: (change: { name?: string; color?: string }) => void; done: { label: string; run: () => void }; other: { label: string; run: () => void } }) {
    return (
        <div className="pose-editor" data-testid="manip-pose-editor">
            <input className="pose-name" value={name} aria-label="pose name" autoFocus onChange={(event) => onChange({ name: event.target.value })} onKeyDown={(event) => event.key === "Enter" && done.run()} />
            <div className="pose-swatches">
                {POSE_COLORS.map((swatch) => (
                    <button key={swatch} type="button" className={`pose-swatch ${swatch === color ? "on" : ""}`} style={{ background: swatch }} aria-label={swatch} onClick={() => onChange({ color: swatch })} />
                ))}
                <input type="color" className="pose-color" value={color || "#8b8d98"} aria-label="pose color" onChange={(event) => onChange({ color: event.target.value })} />
            </div>
            <div className="button-row">
                <Button size="sm" variant="primary" onClick={done.run}>{done.label}</Button>
                <Button size="sm" variant="ghost" onClick={other.run}>{other.label}</Button>
            </div>
        </div>
    )
}
