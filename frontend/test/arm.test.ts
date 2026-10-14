// Arm control against a fake bridge: which topics (real Desktop metadata of dimos arm blueprints), the messages (dimos's
// LCM types: JointState on joint_command, TwistStamped on ee_twist_command, Float32 on gripper_command), and the safety
// rules: a joint jog's target never runs more than LEAD_S ahead, a release holds, the twist has a
// zero deadman, disarming stops.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { ArmControl, eeTwist, jointCommand, LEAD_S } from "../src/core/arm.ts"
import { armTopics, STANDARD_ARM } from "../src/core/armTopics.ts"
import { Drive } from "../src/core/drive.ts"
import { decode, encode } from "../src/core/lcm/lcm.ts"
import armProfile from "../src/profile/arm.ts"
import type { Connection } from "../src/core/transport.ts"
import mock from "./fixtures/blueprint_coordinator-mock.json" with { type: "json" }
import keyboardXarm7 from "./fixtures/blueprint_keyboard-teleop-xarm7.json" with { type: "json" }
import teleopXarm7 from "./fixtures/blueprint_coordinator-teleop-xarm7.json" with { type: "json" }
import go2 from "./fixtures/blueprint_unitree-go2.json" with { type: "json" }

// deno-lint-ignore no-explicit-any
type Any = any
const modules = (blueprint: Any) => blueprint.modules

function fakeBridge() {
    const puts: { key: string; bytes: Uint8Array }[] = []
    const deadmen: { key: string; bytes: Uint8Array }[] = []
    let onState: ((message: { bytes: Uint8Array }) => void) | null = null
    const client = {
        state: "connected",
        publisher(key: string) {
            return {
                state: "open",
                put: (bytes: Uint8Array) => puts.push({ key, bytes }),
                setDeadman: (bytes: Uint8Array) => (deadmen.push({ key, bytes }), Promise.resolve()),
                clearDeadman: () => Promise.resolve(),
                close() {},
            }
        },
    }
    const connection = {
        client,
        subscribe(_key: string, _options: unknown, handler: (message: { bytes: Uint8Array }) => void) {
            onState = handler
            return () => (onState = null)
        },
    } as unknown as Connection
    const sendState = (names: string[], positions: number[]) => onState?.({ bytes: encode("sensor_msgs.JointState", jointCommand(Object.fromEntries(names.map((name, index) => [name, positions[index]])))) })
    return { connection, puts, deadmen, sendState }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const JOINTS = ["arm/joint1", "arm/joint2", "arm/joint3"]

function setup(blueprint: Any = mock) {
    localStorage.clear()
    const bridge = fakeBridge()
    const drive = new Drive(bridge.connection, armProfile)
    const arm = new ArmControl(bridge.connection, drive, armProfile.arm!)
    arm.setRunning({ bp: modules(blueprint) }, [])
    bridge.sendState(JOINTS, [0, 0.5, -0.25])
    const dispose = () => (arm.dispose(), drive.dispose())
    return { ...bridge, drive, arm, dispose }
}

Deno.test("topics from real dimos arm blueprints", () => {
    assertEquals(armTopics({ "coordinator-mock": modules(mock) }), {
        jointState: "/coordinator_joint_state",
        jointCommand: "/joint_command",
        eeTwist: null,
        grippers: ["/gripper_command"],
        cartesian: null,
        fromMetadata: true,
    })
    const keyboard = armTopics({ "keyboard-teleop-xarm7": modules(keyboardXarm7) })
    assertEquals([keyboard.jointCommand, keyboard.eeTwist, keyboard.grippers], ["/joint_command", "/ee_twist_command", ["/gripper_command"]])
    const teleop = armTopics({ "coordinator-teleop-xarm7": modules(teleopXarm7) })
    assertEquals(teleop.grippers, ["/gripper_command", "/left_gripper_command", "/right_gripper_command"])
    // a dog has none of it
    const dog = armTopics({ "unitree-go2": modules(go2) })
    assertEquals([dog.jointCommand, dog.eeTwist, dog.grippers], [null, null, []])
    // no metadata: dimos's standard port names, the bridge's joint state if there is one
    assertEquals(armTopics({ bp: null }, ["/xarm_joints"]), { ...STANDARD_ARM, jointState: "/xarm_joints" })
})

Deno.test("messages are dimos's LCM types, and round-trip", () => {
    const joints = decode("sensor_msgs.JointState", encode("sensor_msgs.JointState", jointCommand({ "arm/joint1": 0.5, "arm/joint2": -1 })))
    assertEquals(joints.name, ["arm/joint1", "arm/joint2"])
    assertEquals(joints.position, [0.5, -1])
    assertEquals(joints.velocity, [])
    const twist = decode("geometry_msgs.TwistStamped", encode("geometry_msgs.TwistStamped", eeTwist({ x: 1, y: 0, z: -1, roll: 0, pitch: 0, yaw: 1 }, 0.05, 0.5)))
    assertEquals([twist.twist.linear.x, twist.twist.linear.z, twist.twist.angular.z], [0.05, -0.05, 0.5])
    assertEquals(twist.header.frame_id, "")
})

Deno.test("a held joint jog: the target creeps ahead but never more than LEAD_S of motion; a release holds where it is", async () => {
    const { arm, puts, sendState, dispose } = setup()
    arm.jogJoint("arm/joint2", 1)
    await wait(400)
    const targets = puts.filter((put) => put.key === "dimos/joint_command/sensor_msgs.JointState").map((put) => decode("sensor_msgs.JointState", put.bytes))
    assert(targets.length >= 5)
    assertEquals(targets.at(-1)!.name, ["arm/joint2"])
    // the joint (as measured) hasn't moved, so the target is capped at measured + lead
    assertAlmostEquals(targets.at(-1)!.position[0], 0.5 + armProfile.arm!.jointSpeed * LEAD_S, 1e-9)
    sendState(JOINTS, [0, 0.58, -0.25])
    arm.releaseJoint()
    const hold = decode("sensor_msgs.JointState", puts.at(-1)!.bytes)
    assertEquals(hold.name, ["arm/joint2"])
    assertAlmostEquals(hold.position[0], 0.58)
    const count = puts.length
    await wait(150)
    assertEquals(puts.length, count, "nothing after the hold")
    dispose()
})

Deno.test("sliders and home send JointState targets; home zero skips no arm joint", () => {
    const { arm, puts, dispose } = setup()
    arm.setJoint("arm/joint3", 9) // past the range: clamped to +π
    assertAlmostEquals(decode("sensor_msgs.JointState", puts.at(-1)!.bytes).position[0], Math.PI)
    arm.home("zero")
    assertEquals(decode("sensor_msgs.JointState", puts.at(-1)!.bytes), { ...decode("sensor_msgs.JointState", puts.at(-1)!.bytes), name: JOINTS, position: [0, 0, 0] })
    arm.home("start")
    assertEquals(decode("sensor_msgs.JointState", puts.at(-1)!.bytes).position, [0, 0.5, -0.25])
    dispose()
})

Deno.test("end effector: TwistStamped at the speeds while held, a zero deadman, zeros after release, then quiet", async () => {
    const { arm, puts, deadmen, dispose } = setup(keyboardXarm7)
    arm.setEe("keys", { z: 1, yaw: -1 })
    await wait(150)
    const key = "dimos/ee_twist_command/geometry_msgs.TwistStamped"
    const moving = decode("geometry_msgs.TwistStamped", puts.filter((put) => put.key === key).at(-1)!.bytes)
    assertAlmostEquals(moving.twist.linear.z, armProfile.arm!.linear)
    assertAlmostEquals(moving.twist.angular.z, -armProfile.arm!.angular)
    assertEquals(deadmen.length, 1)
    const zero = decode("geometry_msgs.TwistStamped", deadmen[0].bytes)
    assertEquals([zero.twist.linear.z, zero.twist.angular.z], [0, 0])
    arm.setEe("keys", {})
    await wait(700)
    const last = decode("geometry_msgs.TwistStamped", puts.filter((put) => put.key === key).at(-1)!.bytes)
    assertEquals([last.twist.linear.z, last.twist.angular.z], [0, 0])
    const count = puts.length
    await wait(200)
    assertEquals(puts.length, count, "quiet once the stop is sent")
    dispose()
})

Deno.test("gripper: Float32 0 closed … 1 open on every gripper topic, or one", () => {
    const { arm, puts, dispose } = setup(teleopXarm7)
    arm.setGripper(0)
    assertEquals(puts.map((put) => put.key), ["dimos/gripper_command/std_msgs.Float32", "dimos/left_gripper_command/std_msgs.Float32", "dimos/right_gripper_command/std_msgs.Float32"])
    assertEquals(decode("std_msgs.Float32", puts[0].bytes).data, 0)
    arm.setGripper(1, "/right_gripper_command")
    assertEquals(puts.at(-1)!.key, "dimos/right_gripper_command/std_msgs.Float32")
    assertEquals(decode("std_msgs.Float32", puts.at(-1)!.bytes).data, 1)
    dispose()
})

Deno.test("a command that moves nothing is reported", async () => {
    const { arm, sendState, dispose } = setup()
    arm.setJoint("arm/joint1", 0.3)
    await wait(1700)
    assertEquals(arm.state.get().response, "no-response")
    arm.setJoint("arm/joint1", 0.3)
    sendState(JOINTS, [0.1, 0.5, -0.25])
    assertEquals(arm.state.get().response, "moved")
    dispose()
})
