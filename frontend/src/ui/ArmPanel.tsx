// The arm panel (robot type arm, in place of the drive settings): arm, joints (hold − / + to jog, or drag a slider to
// send a target), the end effector (hold to move along / about an axis), the gripper, and home. Everything is sent by
// logic/arm.ts on the topics logic/armTopics.ts found; a section whose input isn't running says so instead.
import { type PointerEvent as ReactPointerEvent, useState } from "react"
import { Alert, Button, Field, Heading, Panel, Row, Slider, Text } from "dimos-react"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"
import { isGripperJoint } from "../logic/armTopics.ts"
import type { ArmControl, Joint } from "../logic/arm.ts"
import { EE_AXES, type EeAxis } from "../profile/types.ts"

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
        <Button
            size="sm"
            variant={active ? "primary" : "default"}
            className="hold-button"
            title={title}
            aria-label={title}
            pressed={!!active}
            disabled={disabled}
            data-testid={testId}
            onPointerDown={start}
            onPointerUp={onRelease}
            onPointerCancel={onRelease}
            onLostPointerCapture={onRelease}
            onContextMenu={(event: Event) => event.preventDefault()}
        >
            {label}
        </Button>
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
            <Text small mono className="joint-name" title={joint.name}>{shortName(joint.name)}</Text>
            <HoldButton label="−" title={`Hold to turn ${joint.name} negative`} disabled={!enabled} active={jogging < 0} onHold={() => arm.jogJoint(joint.name, -1)} onRelease={() => arm.releaseJoint()} testId={`jog-${shortName(joint.name)}-minus`} />
            <Slider
                className="joint-slider"
                aria-label={`${joint.name} target`}
                min={joint.min}
                max={joint.max}
                step={span / 400}
                value={value}
                disabled={!enabled}
                showValue={false}
                onChange={(next: number) => {
                    setDragging(next)
                    arm.setJoint(joint.name, next)
                }}
                onCommit={() => setDragging(null)}
                onBlur={() => setDragging(null)}
            />
            <HoldButton label="+" title={`Hold to turn ${joint.name} positive`} disabled={!enabled} active={jogging > 0} onHold={() => arm.jogJoint(joint.name, 1)} onRelease={() => arm.releaseJoint()} testId={`jog-${shortName(joint.name)}-plus`} />
            <Text small mono className="joint-value">{degrees(joint.position)}</Text>
        </div>
    )
}

/** Open / Close / an opening slider, for one gripper topic or (no topic) every one. */
function GripperRow({ arm, armed, topic, label, openKey, closeKey, value }: { arm: ArmControl; armed: boolean; topic?: string; label: string | null; openKey?: string; closeKey?: string; value: number | undefined }) {
    return (
        <div className="gripper-row" data-gripper={topic ?? "all"}>
            {label && <Text small mono className="joint-name">{label}</Text>}
            <Button size="sm" disabled={!armed} data-testid={topic ? undefined : "gripper-open"} onClick={() => arm.setGripper(1, topic)}>Open{openKey ? ` · ${openKey}` : ""}</Button>
            <Button size="sm" disabled={!armed} data-testid={topic ? undefined : "gripper-close"} onClick={() => arm.setGripper(0, topic)}>Close{closeKey ? ` · ${closeKey}` : ""}</Button>
            <Slider aria-label={`${topic ?? "gripper"} opening`} min={0} max={1} step={0.05} disabled={!armed} value={value ?? 1} format={() => (value === undefined ? "—" : `${Math.round(value * 100)}% open`)} onChange={(next: number) => arm.setGripper(next, topic)} />
        </div>
    )
}

const EE_LABELS: Record<EeAxis, string> = { x: "X", y: "Y", z: "Z", roll: "Roll", pitch: "Pitch", yaw: "Yaw" }

export function ArmPanel({ app }: { app: ControllerApp }) {
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
            <Text as="p" small muted data-testid="arm-topics">
                {topics.jointState ? <>Joints from <Text mono>{topics.jointState}</Text>{ageMs !== null && ageMs < 2000 ? "" : " (nothing yet)"}</> : "No joint state topic yet."}
                {" · "}sends {[topics.jointCommand, topics.eeTwist, ...topics.grippers].filter(Boolean).join(", ") || "nothing (no arm inputs running)"}
                {topics.fromMetadata ? "" : " (standard names: Desktop didn't describe what's running)"}
            </Text>

            <Heading level={3}>Joints</Heading>
            {!topics.jointCommand && <Text as="p" small muted>What's running has no <Text mono>joint_command</Text> input: joints are shown, not commanded.</Text>}
            {armJoints.length === 0
                ? <Text as="p" small muted>Waiting for a joint state ({topics.jointState ?? "coordinator_joint_state"}).</Text>
                : armJoints.map((joint) => <JointRow key={joint.name} arm={arm} joint={joint} armed={armed} canCommand={!!topics.jointCommand} />)}
            {topics.jointCommand && armJoints.length > 0 && (
                <>
                    <Field label="Joint speed"><Slider min={0.05} max={1.5} step={0.05} value={settings.jointSpeed} format={(speed: number) => `${speed.toFixed(2)} rad/s`} onChange={(jointSpeed: number) => arm.settings.update({ jointSpeed })} /></Field>
                    <Row gap={6}>
                        <Button size="sm" disabled={!armed} data-testid="arm-home-zero" title="Send every joint to 0 (joint_command); the coordinator limits the speed" onClick={() => arm.home("zero")}>Home (all 0)</Button>
                        <Button size="sm" disabled={!armed || !arm.hasStartPose()} data-testid="arm-home-start" title="Back to where the joints were when the Controller first saw them" onClick={() => arm.home("start")}>Start pose</Button>
                    </Row>
                </>
            )}

            <Heading level={3}>End effector</Heading>
            {topics.eeTwist
                ? (
                    <>
                        <div className="ee-grid" data-testid="ee-grid">
                            {EE_AXES.map((axis) => (
                                <div className="ee-axis" key={axis}>
                                    <Text small className="ee-name">{EE_LABELS[axis]}</Text>
                                    <HoldButton label={`−${keyFor(axis, -1) ? ` ${keyFor(axis, -1)}` : ""}`} title={`Hold to move ${EE_LABELS[axis]} negative`} disabled={!armed} active={state.ee[axis] < 0} onHold={() => arm.setEe(`button-${axis}`, { [axis]: -1 })} onRelease={() => arm.setEe(`button-${axis}`, {})} testId={`ee-${axis}-minus`} />
                                    <HoldButton label={`+${keyFor(axis, 1) ? ` ${keyFor(axis, 1)}` : ""}`} title={`Hold to move ${EE_LABELS[axis]} positive`} disabled={!armed} active={state.ee[axis] > 0} onHold={() => arm.setEe(`button-${axis}`, { [axis]: 1 })} onRelease={() => arm.setEe(`button-${axis}`, {})} testId={`ee-${axis}-plus`} />
                                </div>
                            ))}
                        </div>
                        <Field label="Linear"><Slider min={0.005} max={0.25} step={0.005} value={settings.linear} format={(speed: number) => `${(speed * 100).toFixed(1)} cm/s`} onChange={(linear: number) => arm.settings.update({ linear })} /></Field>
                        <Field label="Angular"><Slider min={0.05} max={1.5} step={0.05} value={settings.angular} format={(speed: number) => `${speed.toFixed(2)} rad/s`} onChange={(angular: number) => arm.settings.update({ angular })} /></Field>
                    </>
                )
                : <Text as="p" small muted>What's running has no <Text mono>ee_twist_command</Text> input (an arm teleop blueprint has one: keyboard-teleop-*, coordinator-teleop-*).</Text>}
            {topics.cartesian && <Text as="p" small muted><Text mono>{topics.cartesian}</Text> (absolute pose targets) is running too; the panel jogs by twist and joints only.</Text>}

            <Heading level={3}>Gripper</Heading>
            {topics.grippers.length
                ? (
                    <>
                        <GripperRow arm={arm} armed={armed} label={topics.grippers.length > 1 ? "all" : null} openKey={gripperKey(1)} closeKey={gripperKey(0)} value={state.gripper[topics.grippers[0]]} />
                        {topics.grippers.length > 1 && (
                            <Panel collapsible defaultOpen={false} title={`Each gripper (${topics.grippers.join(", ")})`}>
                                {topics.grippers.map((topic) => <GripperRow key={topic} arm={arm} armed={armed} topic={topic} label={topic} value={state.gripper[topic]} />)}
                            </Panel>
                        )}
                    </>
                )
                : <Text as="p" small muted>What's running has no <Text mono>gripper_command</Text> input.</Text>}
            {gripperJoints.map((joint) => <Text as="p" small muted key={joint.name}>{joint.name}: {joint.position.toFixed(3)}</Text>)}

            <Row gap={10} data-testid="arm-readout">
                <Text small mono>{state.jogging ? `jog ${shortName(state.jogging.joint)} ${state.jogging.sign > 0 ? "+" : "−"}` : EE_AXES.some((axis) => state.ee[axis]) ? `ee ${EE_AXES.filter((axis) => state.ee[axis]).map((axis) => `${axis}${state.ee[axis] > 0 ? "+" : "−"}`).join(" ")}` : "idle"}</Text>
                <Text small mono muted>sent {state.sent}</Text>
                {state.response === "moved" && <Text small tone="ok">moved</Text>}
            </Row>
            {state.response === "no-response" && <Alert tone="warn" data-testid="arm-no-response">Sent, but no joint moved. The running blueprint may not act on that input (a coordinator only does when one of its tasks takes it).</Alert>}
            {state.error && <Alert tone="danger">{state.error}</Alert>}
            <Text as="p" small muted>dimos publishes no joint limits: sliders span ±180° unless a joint is past that. Space or Esc stops.</Text>
        </div>
    )
}
