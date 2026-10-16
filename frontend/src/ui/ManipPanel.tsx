// The arm's planner panel, viser's Manipulation Panel in its order: status, scene grid, robot display, planning-group
// toggles, target (preset, feasibility, the gizmo: arrows move, rings rotate), actions (next plan speed, planning mode, Plan / Preview / Execute /
// Cancel / Clear plan), joint control, and the scene's obstacle and grasp-proposal toggles. Every action is an
// api/manipulation endpoint (core/manipulation.ts); the planner is dimos's ManipulationModule, and what the RPCs
// don't give (the model, feasibility, obstacle shapes, grasps) comes from dim-controller's hook in its process.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { jointControl, type ManipulationTarget, type PlanningMode, wrapAngle } from "../core/manipulation.ts"
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

            <Heading level={3}>Planning Groups</Heading>
            <p className="hint">Active planning groups for pose goals, planning, and joint edits.</p>
            <div className="button-row" data-testid="manip-groups">
                {state.groups.map((group) => (
                    <Button key={group.id} size="sm" pressed={selected.includes(group.id)} onClick={() => manipulation.toggleGroup(group.id)} title="Toggle this planning group in the target set" data-group={group.id}>{group.id}</Button>
                ))}
            </div>

            <Heading level={3}>Target</Heading>
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

            <Heading level={3}>Actions</Heading>
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
            <div className="button-row manip-actions" data-testid="manip-actions">
                <Button size="sm" variant="primary" disabled={!manipulation.canPlan()} loading={state.busy === "plan"} onClick={() => manipulation.plan()} data-testid="manip-plan">Plan</Button>
                <Button size="sm" disabled={!manipulation.planIsFresh() || busy} onClick={() => manipulation.preview()} data-testid="manip-preview">Preview</Button>
                <Button size="sm" disabled={!manipulation.canExecute()} loading={state.busy === "execute"} onClick={() => manipulation.execute()} data-testid="manip-execute">Execute</Button>
                {manipulation.canCancel() && <Button size="sm" variant="danger" onClick={() => manipulation.cancel()} data-testid="manip-cancel">Cancel</Button>}
                <Button size="sm" variant="ghost" disabled={!state.plan} onClick={() => manipulation.clear()} data-testid="manip-clear">Clear plan</Button>
            </div>
            {state.plan && <p className="hint" data-testid="manip-plan-info">Plan {state.plan.id.slice(0, 8)} ({state.plan.mode}): {state.plan.duration.toFixed(2)} s, {state.plan.positions.length} points{state.preview ? " · previewing" : ""}</p>}

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

            <Heading level={3}>Scene</Heading>
            <Field inline label="Obstacles"><Toggle value={options.obstacles} onChange={(obstacles: boolean) => manipulation.options.update({ obstacles })} /></Field>
            <Field inline label="Grasp proposals"><Toggle value={options.grasps} onChange={(grasps: boolean) => manipulation.options.update({ grasps })} /></Field>
            <p className="hint" data-testid="manip-scene">{view.obstacleCount} obstacles · {view.graspCount} grasp proposals</p>
            {view.obstacleProblems.map((problem) => <p className="warn-text" key={problem}>⚠ Obstacle drawn as a stand-in: {problem}</p>)}
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
