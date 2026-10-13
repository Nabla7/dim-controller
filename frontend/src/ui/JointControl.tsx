// The joint control (a profile's `joint`; core/baseJoint.ts): the picked joint and its position, a select to pick
// another, and ▲ / ▼ held to jog it. Phone: a chip and two hold buttons between the sticks; desktop: the R/F keys
// lighting up in the dock, and the drive panel's section with the speed and the topic. With no joint state it says so.
import { useEffect, useRef } from "react"
import type { ViewerApp } from "../core/app.ts"
import { jogPicked, movableJoints, pickJoint } from "../core/baseJoint.ts"
import { useStore } from "../core/store.ts"
import { Field, HoldButton, Kbd, Select, Slider, TextInput } from "dimos-react"
import { keyName } from "./keymap.ts"

const shortName = (name: string) => name.replace(/^.*\//, "")
/** the chip's name: without the namespace or "joint" (r1pro/torso_joint1 → torso1), so it fits between a phone's sticks */
const chipName = (name: string) => shortName(name).replace(/_?joint_?/, "") || shortName(name)
const degrees = (radians: number) => `${((radians * 180) / Math.PI).toFixed(0)}°`

/** What the control shows: the joints it can pick, the pick and its position, and why it can't move (null: it can). */
function useJoint(app: ViewerApp) {
    const arm = useStore(app.arm.state)
    const settings = useStore(app.drive.settings)
    const drive = useStore(app.drive.state)
    const movable = movableJoints(arm.joints.map((joint) => joint.name))
    const picked = pickJoint(movable, settings.joint)
    const position = arm.joints.find((joint) => joint.name === picked)?.position ?? null
    const topic = app.arm.jointCommandTopic()
    const blocked = !picked
        ? `no JointState on ${arm.topics.jointState ?? "the bridge"}`
        : !topic
        ? "no joint_command topic"
        : drive.halt
        ? "driving is disengaged"
        : null
    const jogging = arm.jogging?.joint === picked ? arm.jogging.sign : 0
    return { arm, movable, picked, position, topic, blocked, jogging, select: (joint: string) => app.drive.settings.update({ joint }) }
}

/** ▲ / ▼: hold to jog the pick; let go (or this unmounting mid-hold) holds it where it is. */
function JogButtons({ app, blocked, jogging, size }: { app: ViewerApp; blocked: string | null; jogging: number; size?: "sm" }) {
    const holding = useRef(false)
    useEffect(() => () => {
        if (holding.current) {
            app.arm.releaseJoint()
        }
    }, [app])
    const button = (sign: number) => (
        <HoldButton
            size={size}
            className="joint-jog-button"
            data-testid={`joint-${sign > 0 ? "up" : "down"}`}
            aria-label={`Hold to move the joint ${sign > 0 ? "+" : "−"}`}
            title={blocked ?? `Hold to move the joint ${sign > 0 ? "+ (▲)" : "− (▼)"}`}
            pressed={jogging === sign}
            disabled={!!blocked}
            onHold={() => {
                holding.current = true
                jogPicked(app.arm, app.drive, sign)
            }}
            onRelease={() => {
                holding.current = false
                app.arm.releaseJoint()
            }}
        >
            {sign > 0 ? "▲" : "▼"}
        </HoldButton>
    )
    return <>{button(1)}{button(-1)}</>
}

/** The pick as a chip (name · position ▾) with the native select over it: a tap opens the phone's own picker. */
function JointPicker({ app, joint }: { app: ViewerApp; joint: ReturnType<typeof useJoint> }) {
    const text = joint.picked ? `${chipName(joint.picked)} · ${joint.position === null ? "—" : degrees(joint.position)}` : "no joints"
    return (
        <span className={`joint-chip ${joint.picked ? "" : "empty"}`} data-testid="joint-chip" title={joint.blocked ?? `${joint.picked} → ${joint.topic}`}>
            <span className="joint-chip-text">{text}</span>
            {joint.movable.length > 0 && <span aria-hidden="true">▾</span>}
            {joint.movable.length > 0 && (
                <Select
                    size="sm"
                    className="joint-select"
                    aria-label="Joint to move"
                    data-testid="joint-select"
                    value={joint.picked}
                    options={joint.movable.map((name) => ({ value: name, label: shortName(name) }))}
                    onChange={(name) => name && joint.select(name)}
                />
            )}
        </span>
    )
}

/** Phone: the chip over ▲ ▼, in the column between the sticks. */
export function JointHud({ app }: { app: ViewerApp }) {
    const joint = useJoint(app)
    return (
        <div className={`joint-hud ${joint.jogging ? "jogging" : ""}`} data-testid="joint-hud">
            <JointPicker app={app} joint={joint} />
            <JogButtons app={app} blocked={joint.blocked} jogging={joint.jogging} />
        </div>
    )
}

/** The profile's keys for joint ▲ / ▼ ("R", "F"). */
const jointKeys = (app: ViewerApp) => [1, -1].map((sign) => keyName(Object.entries(app.profile.drive.keys).find(([, action]) => "joint" in action && Math.sign(action.joint) === sign)?.[0] ?? ""))

/** Desktop dock: the joint keys lit while jogging, and the chip. */
export function JointDock({ app }: { app: ViewerApp }) {
    const joint = useJoint(app)
    const [up, down] = jointKeys(app)
    return (
        <div className={`dock-joint ${joint.jogging ? "moving" : ""}`} data-testid="joint-dock">
            <div className="keys" aria-label="joint keys">
                <div><span className={`key ${joint.jogging > 0 ? "down" : ""}`} title="hold: joint ▲ +">{up}</span></div>
                <div><span className={`key ${joint.jogging < 0 ? "down" : ""}`} title="hold: joint ▼ −">{down}</span></div>
            </div>
            <JointPicker app={app} joint={joint} />
        </div>
    )
}

/** The drive panel's section: pick, ▲ / ▼, the speed (the arm's joint speed: one setting) and where targets go. */
export function JointSection({ app }: { app: ViewerApp }) {
    const joint = useJoint(app)
    const speed = useStore(app.arm.settings).jointSpeed
    const settings = useStore(app.drive.settings)
    const [up, down] = jointKeys(app)
    return (
        <section className="joint-section" data-testid="joint-section">
            <Field inline label="Joint" title="Hold ▲ / ▼ (or the keys) to move one joint; letting go, STOP, Space or a disengaged link holds it where it is">
                <div className="joint-pick-row">
                    <JointPicker app={app} joint={joint} />
                    <JogButtons app={app} blocked={joint.blocked} jogging={joint.jogging} size="sm" />
                    <span className="hint"><Kbd>{up}</Kbd> / <Kbd>{down}</Kbd></span>
                </div>
            </Field>
            <Field inline label="Joint speed" title="The arm's joint speed (the same setting)"><Slider min={0.05} max={1.5} step={0.05} value={speed} format={(value) => `${value.toFixed(2)} rad/s`} onChange={(jointSpeed) => app.arm.settings.update({ jointSpeed })} /></Field>
            <Field inline label="Joint topic" title="The JointState topic targets go to; empty: the running coordinator's joint_command">
                <TextInput data-testid="joint-topic" aria-label="Joint command topic" placeholder={`auto: ${joint.arm.topics.jointCommand ?? "none"}`} value={settings.jointTopic} onCommit={(text) => app.drive.settings.update({ jointTopic: text.trim().replace(/^(?=[^/])/, "/") })} />
            </Field>
            <p className="hint" data-testid="joint-status">
                {joint.blocked
                    ? `Can't move a joint: ${joint.blocked}.`
                    : joint.arm.response === "no-response"
                    ? `Nothing moved: is ${joint.topic} the coordinator's joint_command?`
                    : `${joint.picked} → ${joint.topic}`}
            </p>
            {joint.arm.error && <p className="problem">{joint.arm.error}</p>}
        </section>
    )
}

