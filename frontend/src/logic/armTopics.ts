// Which topics the arm panel reads and commands, from the running blueprints (Desktop's /dimos/blueprints/<name>) and
// the bridge. Nothing here is invented: these are dimos's ControlCoordinator ports (dimos/control/coordinator.py) and
// its arm subclasses (dimos/robot/manipulators/common/coordinators.py, dimos/control/teleop_coordinator.py). A port
// `foo` is the topic `/foo`, zenoh key `dimos/foo/<type>` (README, "Arm control").
//
// | port                                 | type                        | what the coordinator does with it                  |
// | coordinator_joint_state (out)        | sensor_msgs.JointState      | every joint's position, 100 Hz                     |
// | joint_command (in)                   | sensor_msgs.JointState      | trajectory task: names + positions → a velocity-   |
// |                                      |                             | limited move there (a subset of joints is fine)    |
// | ee_twist_command (in)                | geometry_msgs.TwistStamped  | eef_twist task: the end effector moves at it; zero |
// |                                      |                             | holds                                              |
// | gripper_command, left_/right_ (in)   | std_msgs.Float32            | gripper task: 0 closed … 1 open                    |
// | cartesian_command (in)               | geometry_msgs.PoseStamped   | an absolute pose target (not offered: see README)  |
//
// A coordinator only acts on an input a task of its config consumes, which the metadata doesn't say: the panel watches
// the joint state to tell whether a command moved anything.
import type { Module, Stream } from "./cmdvel.ts"
import { zenohKey } from "./cmdvel.ts"

export const JOINT_STATE = "sensor_msgs.JointState"
export const FLOAT32 = "std_msgs.Float32"
export const TWIST_STAMPED = "geometry_msgs.TwistStamped"
export const POSE_STAMPED = "geometry_msgs.PoseStamped"

export interface ArmTopics {
    /** where joint positions come from (coordinator_joint_state first) */
    jointState: string | null
    /** JointState position targets */
    jointCommand: string | null
    /** TwistStamped end-effector velocity */
    eeTwist: string | null
    /** Float32 0 (closed) … 1 (open), one per gripper */
    grippers: string[]
    /** PoseStamped absolute targets, listed only */
    cartesian: string | null
    /** whether these came from the blueprints' metadata (else the standard names) */
    fromMetadata: boolean
}

/** The standard ports, for when no metadata says otherwise (outside Desktop, or an unknown blueprint). */
export const STANDARD_ARM: ArmTopics = {
    jointState: "/coordinator_joint_state",
    jointCommand: "/joint_command",
    eeTwist: "/ee_twist_command",
    grippers: ["/gripper_command"],
    cartesian: null,
    fromMetadata: false,
}

/** A dimos stream type ("dimos.msgs.sensor_msgs.JointState.JointState") is the message `short` ("JointState"). */
const isType = (stream: Stream, short: string) => new RegExp(`(^|\\.)${short}(\\.${short})?$`).test(stream.type ?? "")
const topicOf = (stream: Stream) => "/" + stream.name.replace(/^\/+/, "")

/** Joint-state outputs in preference order: the coordinator's (every joint) first, then per-robot `<hw>_joints`. */
const stateRank = (name: string) => (name === "coordinator_joint_state" ? 0 : /joint_states?$/.test(name) ? 1 : /_joints$/.test(name) ? 2 : 3)

/** The arm topics of the running blueprints; `bridge` (JointState topic names on the bridge) fills in a missing state. */
export function armTopics(blueprints: Record<string, Module[] | null>, bridge: string[] = []): ArmTopics {
    const streams = Object.values(blueprints).flatMap((modules) => (modules ?? []).flatMap((module) => module.streams ?? []))
    const known = Object.values(blueprints).some((modules) => modules !== null)
    const bridgeState = [...bridge].filter((name) => !/command/.test(name)).sort((a, b) => stateRank(a.slice(1)) - stateRank(b.slice(1)))[0] ?? null
    if (!known) {
        return { ...STANDARD_ARM, jointState: bridgeState ?? STANDARD_ARM.jointState }
    }
    const inputs = streams.filter((stream) => stream.direction !== "out")
    const outputs = streams.filter((stream) => stream.direction === "out")
    const input = (name: RegExp, type: string) => inputs.find((stream) => name.test(stream.name) && isType(stream, type))
    const states = outputs.filter((stream) => isType(stream, "JointState")).sort((a, b) => stateRank(a.name) - stateRank(b.name))
    const jointCommand = input(/^joint_command$/, "JointState")
    const eeTwist = input(/^ee_twist_command$/, "TwistStamped")
    const cartesian = input(/^cartesian_command$/, "PoseStamped")
    const grippers = [...new Set(inputs.filter((stream) => /^(left_|right_)?gripper_command$/.test(stream.name) && isType(stream, "Float32")).map(topicOf))]
    return {
        jointState: states[0] ? topicOf(states[0]) : bridgeState,
        jointCommand: jointCommand ? topicOf(jointCommand) : null,
        eeTwist: eeTwist ? topicOf(eeTwist) : null,
        grippers,
        cartesian: cartesian ? topicOf(cartesian) : null,
        fromMetadata: true,
    }
}

export { zenohKey }

/** A joint that's part of a gripper (driven by the gripper command, not jogged). */
export const isGripperJoint = (name: string) => /gripper|finger/i.test(name)
