// The joint control (core/baseJoint.ts) on a wheeled base, against a fake bridge: which joints it offers and picks, that
// it jogs through the arm's joint jog onto the profile's joint topic (the R1's /r1pro/joint_command), and that driving's
// STOP and a halt stop it and refuse a new jog until a reconnect. R1-shaped: dimos's r1pro_coordinator joint names, and its
// coordinator_joint_state renamed /coordinator/joint_state by a transport (the metadata only has port names).
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { ArmControl, jointCommand, LEAD_S } from "../src/core/arm.ts"
import { armTopics } from "../src/core/armTopics.ts"
import { jogPicked, movableJoints, pickedJoint, pickJoint } from "../src/core/baseJoint.ts"
import { Drive } from "../src/core/drive.ts"
import { decode, encode } from "../src/core/lcm/lcm.ts"
import armProfile from "../src/profile/arm.ts"
import wheeled from "../src/profile/wheeled.ts"
import { keyBindings } from "../src/ui/keymap.ts"
import type { Module } from "../src/core/cmdvel.ts"
import type { Connection } from "../src/core/transport.ts"

const JOINT_STATE = "sensor_msgs.JointState"
const TORSO = [1, 2, 3, 4].map((index) => `r1pro/torso_joint${index}`)
const R1_JOINTS = [...TORSO, "r1pro/left_arm_joint1", "r1pro/right_arm_joint1", "chassis/vx", "chassis/vy", "chassis/wz", "r1pro/left_gripper_finger_joint1", "steer_motor_joint1", "wheel_motor_joint1"]
const R1_COORDINATOR: Module[] = [{
    name: "controlcoordinator",
    streams: [
        { name: "coordinator_joint_state", type: "dimos.msgs.sensor_msgs.JointState.JointState", direction: "out" },
        { name: "joint_command", type: "dimos.msgs.sensor_msgs.JointState.JointState", direction: "in" },
        { name: "twist_command", type: "dimos.msgs.geometry_msgs.Twist.Twist", direction: "in" },
    ],
}]
const R1_BRIDGE = ["/coordinator/joint_state", "/r1pro/motor_states"]

function setup() {
    localStorage.clear()
    const puts: { key: string; bytes: Uint8Array }[] = []
    let onState: ((message: { bytes: Uint8Array }) => void) | null = null
    const client = { state: "connected", publisher: (key: string) => ({ state: "open", put: (bytes: Uint8Array) => puts.push({ key, bytes }), setDeadman: () => Promise.resolve(), clearDeadman: () => Promise.resolve(), close() {} }) }
    const connection = { client, command() {}, subscribe: (_key: string, _options: unknown, handler: typeof onState) => ((onState = handler), () => (onState = null)) } as unknown as Connection
    const drive = new Drive(connection, wheeled)
    drive.settings.update({ joint: undefined, jointTopic: wheeled.joint!.commandTopic })
    const arm = new ArmControl(connection, drive, armProfile.arm!)
    arm.setRunning({ "r1pro-coordinator": R1_COORDINATOR }, R1_BRIDGE)
    const sendState = (positions: Record<string, number>) => onState?.({ bytes: encode(JOINT_STATE, jointCommand(positions)) })
    sendState(Object.fromEntries(R1_JOINTS.map((name) => [name, name === "r1pro/torso_joint2" ? -0.5 : 0])))
    const targets = (key: string) => puts.filter((put) => put.key === key).map((put) => decode(JOINT_STATE, put.bytes))
    return { drive, arm, puts, sendState, targets, dispose: () => (arm.dispose(), drive.dispose()) }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const R1_COMMAND = "dimos/r1pro/joint_command/sensor_msgs.JointState"

Deno.test("movable joints: not grippers, a twist base's virtual joints, wheels or steering; the pick defaults to a torso joint", () => {
    assertEquals(movableJoints(R1_JOINTS), [...TORSO, "r1pro/left_arm_joint1", "r1pro/right_arm_joint1"])
    assertEquals(pickJoint(movableJoints(R1_JOINTS), undefined), "r1pro/torso_joint1")
    assertEquals(pickJoint(movableJoints(R1_JOINTS), "r1pro/torso_joint3"), "r1pro/torso_joint3")
    // a saved pick this robot doesn't have: the default, the saved one kept for when it's back
    assertEquals(pickJoint(["arm/joint1", "arm/lift"], "r1pro/torso_joint3"), "arm/lift")
    assertEquals(pickJoint(["arm/joint1"], undefined), "arm/joint1")
    assertEquals(pickJoint([], "r1pro/torso_joint3"), null)
})

Deno.test("R1 topics: the joint state is the bridge's /coordinator/joint_state, not the metadata's port name", () => {
    assertEquals(armTopics({ bp: R1_COORDINATOR }, R1_BRIDGE).jointState, "/coordinator/joint_state")
    // the metadata's own name wins when the bridge has it (or the bridge isn't listed yet)
    assertEquals(armTopics({ bp: R1_COORDINATOR }, ["/coordinator_joint_state", "/r1pro/motor_states"]).jointState, "/coordinator_joint_state")
    assertEquals(armTopics({ bp: R1_COORDINATOR }, []).jointState, "/coordinator_joint_state")
})

Deno.test("a held jog of the picked joint goes to the profile's joint topic, at most LEAD_S ahead; a release holds it", async () => {
    const { drive, arm, targets, sendState, dispose } = setup()
    drive.settings.update({ joint: "r1pro/torso_joint2" })
    assertEquals(pickedJoint(arm, drive), "r1pro/torso_joint2")
    jogPicked(arm, drive, -1)
    await wait(300)
    const sent = targets(R1_COMMAND)
    assert(sent.length >= 4)
    assertEquals(sent.at(-1)!.name, ["r1pro/torso_joint2"])
    assertAlmostEquals(sent.at(-1)!.position[0], -0.5 - arm.settings.get().jointSpeed * LEAD_S, 1e-9)
    sendState({ "r1pro/torso_joint2": -0.6 })
    arm.releaseJoint()
    assertEquals(targets(R1_COMMAND).at(-1)!.position, [-0.6])
    // the topic setting cleared: the coordinator's joint_command
    drive.settings.update({ jointTopic: "" })
    jogPicked(arm, drive, 1)
    arm.releaseJoint()
    assert(targets("dimos/joint_command/sensor_msgs.JointState").length >= 1)
    dispose()
})

Deno.test("driving's STOP holds a jogging joint; a halt holds it and refuses a new jog until resume", () => {
    const { drive, arm, puts, targets, dispose } = setup()
    jogPicked(arm, drive, 1)
    assertEquals(arm.state.get().jogging?.joint, "r1pro/torso_joint1")
    drive.stop()
    assertEquals(arm.state.get().jogging, null)
    assertEquals(targets(R1_COMMAND).at(-1)!.position, [0], "held where it is")

    jogPicked(arm, drive, 1)
    drive.halt({ reason: "latency", latencyMs: 900, maxMs: 500 })
    assertEquals(arm.state.get().jogging, null)
    assertEquals(targets(R1_COMMAND).at(-1)!.position, [0])
    const count = puts.length
    jogPicked(arm, drive, 1)
    assertEquals(arm.state.get().jogging, null)
    assertEquals(puts.length, count, "nothing sent while disengaged")
    assert(arm.state.get().error?.includes("disengaged"))
    drive.resume()
    jogPicked(arm, drive, 1)
    assertEquals(arm.state.get().jogging?.sign, 1)
    arm.releaseJoint()
    dispose()
})

Deno.test("no joint state: the jog says so and sends nothing", () => {
    localStorage.clear()
    const puts: unknown[] = []
    const connection = { command() {}, client: { state: "connected", publisher: () => ({ state: "open", put: (bytes: unknown) => puts.push(bytes), close() {} }) }, subscribe: () => () => {} } as unknown as Connection
    const drive = new Drive(connection, wheeled)
    const arm = new ArmControl(connection, drive, armProfile.arm!)
    arm.setRunning({ "r1pro-coordinator": R1_COORDINATOR }, R1_BRIDGE)
    jogPicked(arm, drive, 1)
    assertEquals(puts.length, 0)
    assertEquals(arm.state.get().error, "no joint state on /coordinator/joint_state: nothing to move")
    arm.dispose()
    drive.dispose()
})

Deno.test("the wheeled base's R/F are listed in the ? sheet as the joint's ▲ / ▼", () => {
    const bindings = keyBindings(wheeled)
    assertEquals(bindings.find((binding) => binding.action.startsWith("Picked joint ▲"))?.keys, ["R"])
    assertEquals(bindings.find((binding) => binding.action.startsWith("Picked joint ▼"))?.keys, ["F"])
})
