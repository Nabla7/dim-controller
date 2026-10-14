// Arm control: joint jog and sliders (joint_command), end-effector jog (ee_twist_command), the gripper
// (gripper_command) and going home, published straight through the bridge like driving (core/armTopics.ts says which
// topics and why). The same safety as driving: nothing is sent unless drive is ARMED (one switch: the backend's), and
// letting go stops:
// - a held joint jog sends a target that runs at most LEAD_S ahead of where the joint is, so if this page goes quiet the
//   joint stops within that, but never steps back against the jog (a late joint state doesn't pull it back); a release
//   holds the last target it sent (a late measured position would undo the move);
// - a held end-effector jog sends a TwistStamped at 20 Hz with the bridge's deadman set to a zero twist (zero = hold);
//   a release sends zeros for a moment, then nothing;
// - disarming does both stops once, then nothing more is sent;
// - driving's stop (STOP, Space, Escape, leaving the page) and its halt (the link watch) stop it too, and while driving
//   is disengaged no command starts.
import { decode, encode, type LcmValue } from "./lcm/lcm.ts"
import { persistentStore, Store } from "./store.ts"
import { type Connection, Priority, type Publisher } from "./transport.ts"
import type { Drive } from "./drive.ts"
import type { Module } from "./cmdvel.ts"
import { armTopics, type ArmTopics, FLOAT32, isGripperJoint, JOINT_STATE, STANDARD_ARM, TWIST_STAMPED, zenohKey } from "./armTopics.ts"
import { EE_AXES, type ArmProfile, type EeAxis } from "../profile/types.ts"

/** How far (in seconds of motion) a joint jog's target may run ahead of the measured position. */
export const LEAD_S = 0.25
const TICK_HZ = 20
/** a release sends zero twists for this long, so the stop is heard */
const STOP_FLUSH_TICKS = 10
/** a command that hasn't moved any joint this long after it was sent: say so */
const NO_RESPONSE_MS = 1500

export interface Joint {
    name: string
    /** measured, rad (or m for a prismatic joint) */
    position: number
    /** slider range */
    min: number
    max: number
}

export interface ArmSettings {
    /** end-effector jog: m/s and rad/s */
    linear: number
    angular: number
    /** joint jog, rad/s */
    jointSpeed: number
}

export interface ArmState {
    topics: ArmTopics
    /** from the joint state (gripper joints included; the panel shows them apart) */
    joints: Joint[]
    /** ms (performance.now) the last joint state arrived, 0 = never */
    stateAt: number
    /** a joint jog held now: joint name and direction */
    jogging: { joint: string; sign: number } | null
    /** end-effector axes held now, -1..1 each */
    ee: Record<EeAxis, number>
    /** last gripper command sent, per topic (0 closed … 1 open) */
    gripper: Record<string, number>
    sent: number
    /** what the last command did: moved, or nothing moved (the running blueprint may not act on it) */
    response: "moved" | "no-response" | null
    error: string | null
}

const zeroEe = (): Record<EeAxis, number> => ({ x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 })

const stampNow = () => {
    const now = Date.now()
    return { sec: Math.floor(now / 1000), nsec: (now % 1000) * 1_000_000 }
}

/** The JointState a set of position targets is sent as (only the joints given: the trajectory task takes a subset). */
export function jointCommand(targets: Record<string, number>): LcmValue {
    const names = Object.keys(targets)
    return { header: { stamp: stampNow(), frame_id: "" }, name: names, position: names.map((name) => targets[name]), velocity: [], effort: [] }
}

/** The end effector's TwistStamped for held axes at the given speeds (keyboard teleop's: no frame_id, base frame). */
export function eeTwist(ee: Record<EeAxis, number>, linear: number, angular: number): LcmValue {
    return {
        header: { stamp: stampNow(), frame_id: "" },
        twist: {
            linear: { x: ee.x * linear, y: ee.y * linear, z: ee.z * linear },
            angular: { x: ee.roll * angular, y: ee.pitch * angular, z: ee.yaw * angular },
        },
    }
}

export class ArmControl {
    readonly state = new Store<ArmState>({ topics: STANDARD_ARM, joints: [], stateAt: 0, jogging: null, ee: zeroEe(), gripper: {}, sent: 0, response: null, error: null })
    readonly settings: Store<ArmSettings>
    #publishers = new Map<string, Publisher>()
    #eeDeadman = false
    #eeFlush = 0
    #eeSources = new Map<string, Partial<Record<EeAxis, number>>>()
    /** the moving jog target of the held joint */
    #jogTarget: number | null = null
    /** the last jog target sent per joint: a release holds it and the next jog starts from it */
    #jogged = new Map<string, number>()
    #timer: ReturnType<typeof setInterval>
    #stateKey: string | null = null
    #unsubscribeState: (() => void) | null = null
    /** where every joint was when the joint state first arrived (dimos's go_init pose) */
    #startPose: Record<string, number> | null = null
    /** positions when the last command went out, to tell whether it moved anything */
    #probe: { at: number; positions: Record<string, number> } | null = null
    /** when anything was last sent: a disarm then sends the stops */
    #lastSentAt = 0
    #blueprints: Record<string, Module[] | null> = {}
    #bridge: string[] = []
    #unsubscribeStop: () => void

    constructor(readonly connection: Connection, readonly drive: Drive, public profile: ArmProfile) {
        this.settings = persistentStore<ArmSettings>("lv.arm", { linear: profile.linear, angular: profile.angular, jointSpeed: profile.jointSpeed })
        this.#timer = setInterval(() => this.#tick(), 1000 / TICK_HZ)
        let armed = drive.state.get().armed
        drive.state.subscribe(() => {
            const now = drive.state.get().armed
            if (armed && !now) {
                this.#disarmed()
            }
            armed = now
        })
        this.#unsubscribeStop = drive.onStop(() => this.stop())
    }

    get armed(): boolean {
        return this.drive.state.get().armed
    }

    /** What's running and the JointState topics on the bridge: which topics to use. */
    setRunning(blueprints: Record<string, Module[] | null>, bridge: string[]) {
        this.#blueprints = blueprints
        this.#bridge = bridge
        const topics = armTopics(blueprints, bridge)
        if (JSON.stringify(topics) !== JSON.stringify(this.state.get().topics)) {
            this.state.update({ topics })
        }
        this.#follow(topics.jointState)
    }

    /** Subscribes to the joint state topic (one at a time). */
    #follow(topic: string | null) {
        const key = topic ? zenohKey(topic, JOINT_STATE) : null
        if (key === this.#stateKey) {
            return
        }
        this.#unsubscribeState?.()
        this.#unsubscribeState = null
        this.#stateKey = key
        this.#startPose = null
        if (!key) {
            return
        }
        this.#unsubscribeState = this.connection.subscribe(key, { maxHz: 30 }, (message) => {
            try {
                this.applyJointState(decode(JOINT_STATE, message.bytes))
            } catch {
                // not a JointState after all
            }
        })
    }

    /** A JointState arrived: the joints, their positions and slider ranges. */
    applyJointState(message: LcmValue) {
        const names: string[] = message.name ?? []
        const positions: number[] = message.position ?? []
        if (!names.length || names.length !== positions.length) {
            return
        }
        const [low, high] = this.profile.defaultLimit
        const joints = names.map((name, index) => {
            const position = positions[index]
            const [min, max] = this.profile.limits[name] ?? [low, high]
            // a joint past its range widens it, so the slider can show where it is
            return { name, position, min: Math.min(min, position), max: Math.max(max, position) }
        })
        this.#startPose ??= Object.fromEntries(joints.map((joint) => [joint.name, joint.position]))
        let response = this.state.get().response
        if (this.#probe) {
            const moved = joints.some((joint) => Math.abs(joint.position - (this.#probe!.positions[joint.name] ?? joint.position)) > 1e-3)
            if (moved) {
                response = "moved"
                this.#probe = null
            }
        }
        this.state.update({ joints, stateAt: performance.now(), response })
    }

    /** Where joint targets go: the drive settings' joint topic (the joint control's), else the coordinator's joint_command. */
    jointCommandTopic(): string | null {
        return this.drive.settings.get().jointTopic || this.state.get().topics.jointCommand
    }

    position(name: string): number | null {
        return this.state.get().joints.find((joint) => joint.name === name)?.position ?? null
    }

    /** Hold-to-jog one joint (sign ±1); `releaseJoint` stops it. */
    jogJoint(name: string, sign: number) {
        if (!this.#mayCommand("jointCommand")) {
            return
        }
        const position = this.position(name)
        if (position === null) {
            this.state.update({ error: `no position for ${name} yet` })
            return
        }
        this.#jogTarget = this.#jogged.get(name) ?? position
        this.state.update({ jogging: { joint: name, sign: Math.sign(sign) }, error: null })
        this.#tick()
    }

    releaseJoint() {
        const jogging = this.state.get().jogging
        if (!jogging) {
            return
        }
        this.#jogTarget = null
        this.state.update({ jogging: null })
        if (this.armed) {
            this.#holdJogged(jogging.joint)
        }
    }

    /** A slider: one joint to an absolute position (the coordinator limits how fast it gets there). */
    setJoint(name: string, value: number) {
        if (!this.#mayCommand("jointCommand")) {
            return
        }
        const joint = this.state.get().joints.find((each) => each.name === name)
        const clamped = joint ? Math.max(joint.min, Math.min(joint.max, value)) : value
        this.#jogged.delete(name)
        this.#sendJoints({ [name]: clamped })
    }

    /** Every arm joint to 0 ("zero"), or back where they were when the joint state first came ("start"). */
    home(pose: "zero" | "start") {
        if (!this.#mayCommand("jointCommand")) {
            return
        }
        const arm = this.state.get().joints.filter((joint) => !isGripperJoint(joint.name))
        if (!arm.length) {
            this.state.update({ error: "no joint state yet: nothing to send home" })
            return
        }
        const targets = Object.fromEntries(arm.map((joint) => [joint.name, pose === "zero" ? 0 : this.#startPose?.[joint.name] ?? joint.position]))
        this.#jogged.clear()
        this.#sendJoints(targets)
    }

    /** Whether there's a start pose to go back to. */
    hasStartPose(): boolean {
        return this.#startPose !== null
    }

    /** A source ("keys", "buttons") sets its share of the end-effector axes; the sum (clamped) is sent while armed. */
    setEe(source: string, axes: Partial<Record<EeAxis, number>>) {
        if (Object.values(axes).some((value) => value) && !this.#mayCommand("eeTwist")) {
            return
        }
        this.#eeSources.set(source, axes)
        const ee = zeroEe()
        for (const share of this.#eeSources.values()) {
            for (const axis of EE_AXES) {
                ee[axis] = Math.max(-1, Math.min(1, ee[axis] + (share[axis] ?? 0)))
            }
        }
        this.state.update({ ee })
    }

    /** Gripper to `value` (0 closed … 1 open), on one gripper topic or every one. */
    setGripper(value: number, topic?: string) {
        if (!this.#mayCommand("grippers")) {
            return
        }
        const topics = topic ? [topic] : this.state.get().topics.grippers
        const clamped = Math.max(0, Math.min(1, value))
        for (const each of topics) {
            this.#put(zenohKey(each, FLOAT32), FLOAT32, { data: clamped }, Priority.INTERACTIVE_HIGH)
        }
        this.state.update({ gripper: { ...this.state.get().gripper, ...Object.fromEntries(topics.map((each) => [each, clamped])) } })
    }

    /** Stop everything at once (Space, STOP): end-effector zeros, joints held where they are. */
    stop() {
        this.#eeSources.clear()
        this.state.update({ ee: zeroEe() })
        const jogging = this.state.get().jogging
        this.#jogTarget = null
        this.state.update({ jogging: null })
        if (this.armed && jogging) {
            this.#holdJogged(jogging.joint)
        }
    }

    #mayCommand(kind: "jointCommand" | "eeTwist" | "grippers"): boolean {
        if (!this.armed) {
            this.state.update({ error: "arm to send commands" })
            return false
        }
        if (this.drive.state.get().halt) {
            this.state.update({ error: "driving is disengaged: Reconnect first" })
            return false
        }
        const topics = this.state.get().topics
        const missing = kind === "grippers" ? !topics.grippers.length : kind === "jointCommand" ? !this.jointCommandTopic() : !topics[kind]
        if (missing) {
            const what = { jointCommand: "joint_command", eeTwist: "ee_twist_command", grippers: "gripper_command" }[kind]
            this.state.update({ error: `what's running has no ${what} input` })
            return false
        }
        return true
    }

    #disarmed() {
        this.#eeSources.clear()
        const { jogging, topics } = this.state.get()
        this.state.update({ ee: zeroEe(), jogging: null })
        this.#jogTarget = null
        // a stop goes out once, if anything was sent lately; then nothing
        if (performance.now() - this.#lastSentAt < 3000) {
            if (topics.eeTwist && this.#publishers.has(zenohKey(topics.eeTwist, TWIST_STAMPED))) {
                this.#put(zenohKey(topics.eeTwist, TWIST_STAMPED), TWIST_STAMPED, eeTwist(zeroEe(), 0, 0), Priority.REAL_TIME)
            }
            if (jogging && this.jointCommandTopic()) {
                this.#holdJogged(jogging.joint, true)
            }
        }
        for (const publisher of this.#publishers.values()) {
            publisher.clearDeadman().catch(() => {})
            publisher.close()
        }
        this.#publishers.clear()
        this.#eeDeadman = false
        this.#eeFlush = 0
    }

    /** A jogged joint stops at the last target sent (where it was heading), else where it is. */
    #holdJogged(name: string, force = false) {
        const target = this.#jogged.get(name)
        if (target === undefined) {
            this.#holdJoints([name], force)
        } else {
            this.#sendJoints({ [name]: target }, force)
        }
    }

    /** Targets = where the joints are now: they stop. */
    #holdJoints(names: string[], force = false) {
        const targets: Record<string, number> = {}
        for (const name of names) {
            const position = this.position(name)
            if (position !== null) {
                targets[name] = position
            }
        }
        if (Object.keys(targets).length) {
            this.#sendJoints(targets, force)
        }
    }

    #sendJoints(targets: Record<string, number>, force = false) {
        const topic = this.jointCommandTopic()
        if (!topic || (!this.armed && !force)) {
            return
        }
        this.#put(zenohKey(topic, JOINT_STATE), JOINT_STATE, jointCommand(targets), Priority.INTERACTIVE_HIGH)
        this.#probe ??= { at: performance.now(), positions: Object.fromEntries(this.state.get().joints.map((joint) => [joint.name, joint.position])) }
    }

    #publisher(key: string, priority: number): Publisher | null {
        const client = this.connection.client
        if (!client || client.state === "lost") {
            this.state.update({ error: "not connected to the gateway" })
            return null
        }
        let publisher = this.#publishers.get(key)
        if (!publisher || ["tripped", "closed", "rejected"].includes(publisher.state)) {
            publisher = client.publisher(key, priority === Priority.REAL_TIME ? { priority, latencyLimit: 400 } : { priority, delivery: "reliable" })
            this.#publishers.set(key, publisher)
            if (key.endsWith(TWIST_STAMPED)) {
                this.#eeDeadman = false
            }
        }
        return publisher
    }

    #put(key: string, type: string, message: LcmValue, priority: number) {
        const publisher = this.#publisher(key, priority)
        if (!publisher) {
            return
        }
        try {
            publisher.put(encode(type, message))
            this.#lastSentAt = performance.now()
            this.state.update({ sent: this.state.get().sent + 1, error: null })
        } catch (caught) {
            this.#publishers.delete(key)
            this.state.update({ error: String(caught) })
        }
    }

    #tick() {
        const state = this.state.get()
        if (this.#probe && performance.now() - this.#probe.at > NO_RESPONSE_MS) {
            this.#probe = null
            if (state.response !== "no-response") {
                this.state.update({ response: "no-response" })
            }
        }
        if (!this.armed) {
            return
        }
        // a held joint: its target creeps ahead at jointSpeed, never more than LEAD_S of motion past the joint
        if (state.jogging && this.#jogTarget !== null) {
            const measured = this.position(state.jogging.joint)
            if (measured !== null) {
                const speed = this.settings.get().jointSpeed
                const lead = speed * LEAD_S
                const step = speed / TICK_HZ
                const joint = state.joints.find((each) => each.name === state.jogging!.joint)!
                // one step the jog's way, held back to LEAD_S past the measured joint, but never moved against the jog
                const forward = state.jogging.sign > 0
                    ? Math.max(this.#jogTarget, Math.min(this.#jogTarget + step, measured + lead))
                    : Math.min(this.#jogTarget, Math.max(this.#jogTarget - step, measured - lead))
                this.#jogTarget = Math.max(joint.min, Math.min(joint.max, forward))
                this.#jogged.set(state.jogging.joint, this.#jogTarget)
                this.#sendJoints({ [state.jogging.joint]: this.#jogTarget })
            }
        }
        // the end effector: a twist while held, then a short burst of zeros, then quiet
        const topic = state.topics.eeTwist
        if (!topic) {
            return
        }
        const moving = EE_AXES.some((axis) => state.ee[axis] !== 0)
        if (moving) {
            this.#eeFlush = STOP_FLUSH_TICKS
        } else if (this.#eeFlush > 0) {
            this.#eeFlush--
        } else {
            if (this.#eeDeadman) {
                this.#eeDeadman = false
                this.#publishers.get(zenohKey(topic, TWIST_STAMPED))?.clearDeadman().catch(() => {})
            }
            return
        }
        const key = zenohKey(topic, TWIST_STAMPED)
        const publisher = this.#publisher(key, Priority.REAL_TIME)
        if (!publisher) {
            return
        }
        if (moving && !this.#eeDeadman) {
            this.#eeDeadman = true
            publisher.setDeadman(encode(TWIST_STAMPED, eeTwist(zeroEe(), 0, 0))).catch((caught) => {
                this.#eeDeadman = false
                this.state.update({ error: `deadman: ${caught}` })
            })
        }
        const { linear, angular } = this.settings.get()
        this.#put(key, TWIST_STAMPED, eeTwist(state.ee, linear, angular), Priority.REAL_TIME)
        if (moving) {
            this.#probe ??= { at: performance.now(), positions: Object.fromEntries(state.joints.map((joint) => [joint.name, joint.position])) }
        }
    }

    /** Re-reads the topics (e.g. after the robot type changed). */
    refresh() {
        this.setRunning(this.#blueprints, this.#bridge)
    }

    dispose() {
        clearInterval(this.#timer)
        this.#unsubscribeStop()
        this.#unsubscribeState?.()
        for (const publisher of this.#publishers.values()) {
            publisher.close()
        }
    }
}
