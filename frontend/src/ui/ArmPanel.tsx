// The arm panel (robot type arm, in place of the drive settings): arm, joints (hold − / + to jog, or drag a slider to
// send a target), the end effector (hold to move along / about an axis), the gripper, and home. Everything is sent by
// core/arm.ts on the topics core/armTopics.ts found; a section whose input isn't running says so instead.
import { type PointerEvent as ReactPointerEvent, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { isGripperJoint } from "../core/armTopics.ts"
import type { ArmControl, Joint } from "../core/arm.ts"
import { EE_AXES, type EeAxis } from "../profile/types.ts"
import { Field, Slider } from "./controls.tsx"

const degrees = (radians: number) => `${((radians * 180) / Math.PI).toFixed(1)}°`
const shortName = (name: string) => name.replace(/^.*\//, "")

/** A button that acts while held: pointer down starts, up / cancel / leaving stops (so a lost release still stops). */
function HoldButton({ label, title, onHold, onRelease, disabled, active, testId }: { label: string; title: string; onHold: () => void; onRelease: () => void; disabled?: boolean; active?: boolean; testId?: string }) {
    const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (disabled || event.button !== 0) {
            return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        onHold()
    }
    return (
        <button
            type="button"
            className={`dim-btn sm hold-button ${active ? "on" : ""}`}
            title={title}
            aria-label={title}
            aria-pressed={active}
            disabled={disabled}
            data-testid={testId}
            onPointerDown={start}
            onPointerUp={onRelease}
            onPointerCancel={onRelease}
            onLostPointerCapture={onRelease}
            onContextMenu={(event) => event.preventDefault()}
        >
            {label}
        </button>
    )
}

function JointRow({ arm, joint, armed, canCommand }: { arm: ArmControl; joint: Joint; armed: boolean; canCommand: boolean }) {
    const state = useStore(arm.state)
    const [dragging, setDragging] = useState<number | null>(null)
    const jogging = state.jogging?.joint === joint.name ? state.jogging.sign : 0
    const enabled = armed && canCommand
    const value = dragging ?? joint.position
    const span = joint.max - joint.min
    return (
        <div className={`joint-row ${jogging ? "jogging" : ""}`} data-joint={joint.name}>
            <span className="joint-name" title={joint.name}>{shortName(joint.name)}</span>
            <HoldButton label="−" title={`Hold to turn ${joint.name} negative`} disabled={!enabled} active={jogging < 0} onHold={() => arm.jogJoint(joint.name, -1)} onRelease={() => arm.releaseJoint()} testId={`jog-${shortName(joint.name)}-minus`} />
            <input
                type="range"
                className="dim-range joint-slider"
                aria-label={`${joint.name} target`}
                min={joint.min}
                max={joint.max}
                step={span / 400}
                value={value}
                disabled={!enabled}
                onChange={(event) => {
                    const next = Number(event.target.value)
                    setDragging(next)
                    arm.setJoint(joint.name, next)
                }}
                onPointerUp={() => setDragging(null)}
                onBlur={() => setDragging(null)}
            />
            <HoldButton label="+" title={`Hold to turn ${joint.name} positive`} disabled={!enabled} active={jogging > 0} onHold={() => arm.jogJoint(joint.name, 1)} onRelease={() => arm.releaseJoint()} testId={`jog-${shortName(joint.name)}-plus`} />
            <span className="joint-value">{degrees(joint.position)}</span>
        </div>
    )
}

/** Open / Close / an opening slider, for one gripper topic or (no topic) every one. */
function GripperRow({ arm, armed, topic, label, openKey, closeKey, value }: { arm: ArmControl; armed: boolean; topic?: string; label: string | null; openKey?: string; closeKey?: string; value: number | undefined }) {
    return (
        <div className="gripper-row" data-gripper={topic ?? "all"}>
            {label && <span className="joint-name"><code>{label}</code></span>}
            <button type="button" className="dim-btn sm" disabled={!armed} data-testid={topic ? undefined : "gripper-open"} onClick={() => arm.setGripper(1, topic)}>Open{openKey ? ` · ${openKey}` : ""}</button>
            <button type="button" className="dim-btn sm" disabled={!armed} data-testid={topic ? undefined : "gripper-close"} onClick={() => arm.setGripper(0, topic)}>Close{closeKey ? ` · ${closeKey}` : ""}</button>
            <span className="slider">
                <input type="range" className="dim-range" aria-label={`${topic ?? "gripper"} opening`} min={0} max={1} step={0.05} disabled={!armed} value={value ?? 1} onChange={(event) => arm.setGripper(Number(event.target.value), topic)} />
                <span className="slider-value">{value === undefined ? "—" : `${Math.round(value * 100)}% open`}</span>
            </span>
        </div>
    )
}

const EE_LABELS: Record<EeAxis, string> = { x: "X", y: "Y", z: "Z", roll: "Roll", pitch: "Pitch", yaw: "Yaw" }

export function ArmPanel({ app }: { app: ViewerApp }) {
    const arm = app.arm
    const drive = useStore(app.drive.state)
    const state = useStore(arm.state)
    const settings = useStore(arm.settings)
    const profile = app.profile.arm!
    const { topics } = state
    const armed = drive.armed
    const armJoints = state.joints.filter((joint) => !isGripperJoint(joint.name))
    const gripperJoints = state.joints.filter((joint) => isGripperJoint(joint.name))
    const ageMs = state.stateAt ? performance.now() - state.stateAt : null
    const keyFor = (axis: EeAxis, sign: number) => Object.entries(profile.keys).find(([, action]) => "ee" in action && action.ee === axis && Math.sign(action.value) === sign)?.[0].replace(/^Key/, "")
    const gripperKey = (value: number) => Object.entries(profile.keys).find(([, action]) => "gripper" in action && action.gripper === value)?.[0].replace(/^Bracket(Left|Right)$/, (_, side) => (side === "Left" ? "[" : "]"))

    return (
        <div className="arm-panel" data-testid="arm-panel">
            <p className="hint" data-testid="arm-topics">
                {topics.jointState ? <>Joints from <code>{topics.jointState}</code>{ageMs !== null && ageMs < 2000 ? "" : " (nothing yet)"}</> : "No joint state topic yet."}
                {" · "}sends {[topics.jointCommand, topics.eeTwist, ...topics.grippers].filter(Boolean).join(", ") || "nothing (no arm inputs running)"}
                {topics.fromMetadata ? "" : " (standard names: Desktop didn't describe what's running)"}
            </p>

            <h3 className="dim-label">Joints</h3>
            {!topics.jointCommand && <p className="hint">What's running has no <code>joint_command</code> input: joints are shown, not commanded.</p>}
            {armJoints.length === 0
                ? <p className="empty">Waiting for a joint state ({topics.jointState ?? "coordinator_joint_state"}).</p>
                : armJoints.map((joint) => <JointRow key={joint.name} arm={arm} joint={joint} armed={armed} canCommand={!!topics.jointCommand} />)}
            {topics.jointCommand && armJoints.length > 0 && (
                <>
                    <Field label="Joint speed"><Slider min={0.05} max={1.5} step={0.05} value={settings.jointSpeed} format={(speed) => `${speed.toFixed(2)} rad/s`} onChange={(jointSpeed) => arm.settings.update({ jointSpeed })} /></Field>
                    <div className="button-row">
                        <button type="button" className="dim-btn sm" disabled={!armed} data-testid="arm-home-zero" title="Send every joint to 0 (joint_command); the coordinator limits the speed" onClick={() => arm.home("zero")}>Home (all 0)</button>
                        <button type="button" className="dim-btn sm" disabled={!armed || !arm.hasStartPose()} data-testid="arm-home-start" title="Back to where the joints were when the Controller first saw them" onClick={() => arm.home("start")}>Start pose</button>
                    </div>
                </>
            )}

            <h3 className="dim-label">End effector</h3>
            {topics.eeTwist
                ? (
                    <>
                        <div className="ee-grid" data-testid="ee-grid">
                            {EE_AXES.map((axis) => (
                                <div className="ee-axis" key={axis}>
                                    <span className="ee-name">{EE_LABELS[axis]}</span>
                                    <HoldButton label={`−${keyFor(axis, -1) ? ` ${keyFor(axis, -1)}` : ""}`} title={`Hold to move ${EE_LABELS[axis]} negative`} disabled={!armed} active={state.ee[axis] < 0} onHold={() => arm.setEe(`button-${axis}`, { [axis]: -1 })} onRelease={() => arm.setEe(`button-${axis}`, {})} testId={`ee-${axis}-minus`} />
                                    <HoldButton label={`+${keyFor(axis, 1) ? ` ${keyFor(axis, 1)}` : ""}`} title={`Hold to move ${EE_LABELS[axis]} positive`} disabled={!armed} active={state.ee[axis] > 0} onHold={() => arm.setEe(`button-${axis}`, { [axis]: 1 })} onRelease={() => arm.setEe(`button-${axis}`, {})} testId={`ee-${axis}-plus`} />
                                </div>
                            ))}
                        </div>
                        <Field label="Linear"><Slider min={0.005} max={0.25} step={0.005} value={settings.linear} format={(speed) => `${(speed * 100).toFixed(1)} cm/s`} onChange={(linear) => arm.settings.update({ linear })} /></Field>
                        <Field label="Angular"><Slider min={0.05} max={1.5} step={0.05} value={settings.angular} format={(speed) => `${speed.toFixed(2)} rad/s`} onChange={(angular) => arm.settings.update({ angular })} /></Field>
                    </>
                )
                : <p className="hint">What's running has no <code>ee_twist_command</code> input (an arm teleop blueprint has one: keyboard-teleop-*, coordinator-teleop-*).</p>}
            {topics.cartesian && <p className="hint"><code>{topics.cartesian}</code> (absolute pose targets) is running too; the panel jogs by twist and joints only.</p>}

            <h3 className="dim-label">Gripper</h3>
            {topics.grippers.length
                ? (
                    <>
                        <GripperRow arm={arm} armed={armed} label={topics.grippers.length > 1 ? "all" : null} openKey={gripperKey(1)} closeKey={gripperKey(0)} value={state.gripper[topics.grippers[0]]} />
                        {topics.grippers.length > 1 && (
                            <details className="other-topics">
                                <summary>Each gripper ({topics.grippers.join(", ")})</summary>
                                {topics.grippers.map((topic) => <GripperRow key={topic} arm={arm} armed={armed} topic={topic} label={topic} value={state.gripper[topic]} />)}
                            </details>
                        )}
                    </>
                )
                : <p className="hint">What's running has no <code>gripper_command</code> input.</p>}
            {gripperJoints.map((joint) => <p className="hint" key={joint.name}>{joint.name}: {joint.position.toFixed(3)}</p>)}

            <div className="twist-readout" data-testid="arm-readout">
                <span>{state.jogging ? `jog ${shortName(state.jogging.joint)} ${state.jogging.sign > 0 ? "+" : "−"}` : EE_AXES.some((axis) => state.ee[axis]) ? `ee ${EE_AXES.filter((axis) => state.ee[axis]).map((axis) => `${axis}${state.ee[axis] > 0 ? "+" : "−"}`).join(" ")}` : "idle"}</span>
                <span>sent {state.sent}</span>
                {state.response === "moved" && <span className="ok-text">moved</span>}
            </div>
            {state.response === "no-response" && <p className="warn-text" data-testid="arm-no-response">Sent, but no joint moved. The running blueprint may not act on that input (a coordinator only does when one of its tasks takes it).</p>}
            {state.error && <p className="problem">{state.error}</p>}
            <p className="hint">dimos publishes no joint limits: sliders span ±180° unless a joint is past that. Space or Esc stops.</p>
        </div>
    )
}
