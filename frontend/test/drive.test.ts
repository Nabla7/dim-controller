// The drive loop against a fake bridge client: what gets published, when, and with which speeds.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { Drive } from "../src/core/drive.ts"
import { decode } from "../src/core/lcm/lcm.ts"
import { FakeTime } from "jsr:@std/testing@1/time"
import go2 from "../src/profile/dog.ts"
import drone from "../src/profile/drone.ts"
import type { Connection } from "../src/core/transport.ts"

function fakeBridge() {
    const puts: { key: string; twist: { linear: { x: number; y: number; z: number }; angular: { z: number } } }[] = []
    const deadmen: string[] = []
    const cleared: string[] = []
    const opened: string[] = []
    const client = {
        state: "connected",
        publisher(key: string) {
            opened.push(key)
            return {
                state: "open",
                put: (bytes: Uint8Array) => puts.push({ key, twist: decode("geometry_msgs.Twist", bytes) }),
                setDeadman: () => (deadmen.push(key), Promise.resolve()),
                clearDeadman: () => (cleared.push(key), Promise.resolve()),
                close() {},
            }
        },
    }
    return { connection: { client } as unknown as Connection, puts, deadmen, cleared, opened }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

Deno.test("policy state gates input, routes through the movement manager, and forgets keys when state becomes stale", () => {
    using time = new FakeTime()
    const { connection, puts } = fakeBridge()
    const drive = new Drive(connection, go2)
    const settings = drive.settings.get()
    try {
        drive.settings.update({ topics: ["/cmd_vel"] })
        drive.setPolicy("Activate the policy to drive", "/tele_cmd_vel")
        drive.setAxes("keys", { forward: 1 })
        time.tick(100)
        assertEquals(puts.length, 0)
        drive.setPolicy(null, "/tele_cmd_vel")
        time.tick(100)
        assertEquals(puts.length, 0, "blocked input is not queued")
        drive.setAxes("keys", { forward: 1 })
        time.tick(100)
        assertEquals(puts.at(-1)?.key, "dimos/tele_cmd_vel/geometry_msgs.Twist")
        assert(puts.at(-1)!.twist.linear.x > 0)
        drive.setPolicy("Waiting for fresh policy state", "/tele_cmd_vel")
        assertEquals(puts.at(-1)!.twist.linear.x, 0, "stale status stops immediately")
        drive.setPolicy(null, "/tele_cmd_vel")
        time.tick(100)
        assertEquals(puts.at(-1)!.twist.linear.x, 0, "fresh status does not resume old input")
    } finally {
        drive.settings.set(settings)
        drive.dispose()
    }
})

Deno.test("no arming: forward at the linear speed, shift doubles linear and halves turning, a release flushes zeros then goes quiet", async () => {
    localStorage.clear()
    const { connection, puts, deadmen } = fakeBridge()
    const drive = new Drive(connection, go2)
    drive.setRunning({ bp: [{ streams: [{ name: "cmd_vel", type: "dimos.msgs.geometry_msgs.Twist.Twist", direction: "in" }] }] })
    drive.setAxes("keys", { forward: 1, turn: 1 })
    await wait(150)
    const plain = puts.at(-1)!
    assertEquals(plain.key, "dimos/cmd_vel/geometry_msgs.Twist")
    assertAlmostEquals(plain.twist.linear.x, go2.drive.speeds.linear)
    assertAlmostEquals(plain.twist.angular.z, go2.drive.speeds.angular)
    assertEquals(deadmen, ["dimos/cmd_vel/geometry_msgs.Twist"])
    drive.setBoost(true)
    await wait(120)
    const boosted = puts.at(-1)!
    assertAlmostEquals(boosted.twist.linear.x, go2.drive.speeds.linear * 2)
    assertAlmostEquals(boosted.twist.angular.z, go2.drive.speeds.angular * 0.5)
    drive.setBoost(false)
    drive.setAxes("keys", {})
    await wait(1300)
    const count = puts.length
    assert(puts.slice(-5).every((put) => put.twist.linear.x === 0 && put.twist.angular.z === 0))
    await wait(300)
    assertEquals(puts.length, count, "quiet after the stop flush")
    drive.dispose()
})

Deno.test("auto drives every entry point, each with its own deadman; a list in the settings wins", async () => {
    localStorage.clear()
    const { connection, puts, deadmen } = fakeBridge()
    const drive = new Drive(connection, go2)
    // no metadata: the standard set
    assertEquals(drive.state.get().topics.map((topic) => topic.topic), ["/cmd_vel", "/tele_cmd_vel"])
    drive.setAxes("keys", { forward: 1 })
    await wait(150)
    assertEquals(new Set(puts.map((put) => put.key)), new Set(["dimos/cmd_vel/geometry_msgs.Twist", "dimos/tele_cmd_vel/geometry_msgs.Twist"]))
    assertEquals(deadmen.sort(), ["dimos/cmd_vel/geometry_msgs.Twist", "dimos/tele_cmd_vel/geometry_msgs.Twist"])
    drive.settings.update({ topics: ["/mine"] })
    assertEquals(drive.state.get().topic, "/mine")
    puts.length = 0
    await wait(150)
    // the topics left behind get one zero (their stop), then only the new one moves
    assertEquals(new Set(puts.filter((put) => put.twist.linear.x !== 0).map((put) => put.key)), new Set(["dimos/mine/geometry_msgs.Twist"]))
    assertEquals(puts.filter((put) => put.key !== "dimos/mine/geometry_msgs.Twist").every((put) => put.twist.linear.x === 0), true)
    drive.dispose()
})

Deno.test("a drone profile's Q/E-style vertical axis lands in linear.z", async () => {
    localStorage.clear()
    const { connection, puts } = fakeBridge()
    const drive = new Drive(connection, drone)
    drive.setAxes("keys", { vertical: 1 })
    await wait(120)
    assertAlmostEquals(puts.at(-1)!.twist.linear.z, drone.drive.speeds.vertical)
    drive.dispose()
})

Deno.test("the backend's drive events carry the agent's commands; older events with armed: false change nothing", async () => {
    localStorage.clear()
    const { connection, puts } = fakeBridge()
    const drive = new Drive(connection, go2)
    drive.setRunning({ bp: [{ streams: [{ name: "cmd_vel", type: "dimos.msgs.geometry_msgs.Twist.Twist", direction: "in" }] }] })
    const command = { key: "dimos/cmd_vel/geometry_msgs.Twist", linear: [0.3, 0, 0] as [number, number, number], angular: [0, 0, 0] as [number, number, number], seconds: 1, dryRun: true, source: "agent" }
    drive.applyEvent({ command })
    assertEquals(drive.state.get().command, command)
    drive.applyEvent({ armed: false, command: null } as never)
    drive.setAxes("keys", { forward: 1 })
    await wait(150)
    assert(puts.length > 0, "keys always drive")
    drive.dispose()
})

Deno.test("a release sends a zero at once, not at the next tick", async () => {
    localStorage.clear()
    const { connection, puts } = fakeBridge()
    const drive = new Drive(connection, go2)
    drive.setRunning({ bp: [{ streams: [{ name: "cmd_vel", type: "dimos.msgs.geometry_msgs.Twist.Twist", direction: "in" }] }] })
    drive.setAxes("left-stick", { forward: 0.5, strafe: -0.5 })
    await wait(120)
    assert(puts.at(-1)!.twist.linear.x > 0)
    const before = puts.length
    drive.setAxes("left-stick", { forward: 0, strafe: 0 })
    assertEquals(puts.length, before + 1, "published synchronously on release")
    assertEquals(puts.at(-1)!.twist.linear, { x: 0, y: 0, z: 0 })
    drive.setAxes("right-stick", { turn: 1 })
    drive.stop()
    assertEquals(puts.at(-1)!.twist.angular.z, 0, "STOP is heard at once too")
    drive.dispose()
})

// Safety (e2e F9): opening the Controller must not drive. Everything that happens without a drive input (what's running
// changing, a robot type switch, STOP, Space, boost, a stick at rest) publishes nothing and arms no deadman.
Deno.test("idle: nothing is published and no deadman is armed until a drive input, and none after the stop flush", async () => {
    localStorage.clear()
    const { connection, puts, deadmen, cleared, opened } = fakeBridge()
    const drive = new Drive(connection, go2)
    drive.settings.update({ topics: [] }) // auto (an earlier test's list stays in the module's settings store)
    drive.setRunning({ bp: [{ streams: [{ name: "tele_cmd_vel", type: "dimos.msgs.geometry_msgs.Twist.Twist", direction: "in" }] }] })
    drive.stop()
    drive.setBoost(true)
    drive.setBoost(false)
    drive.setAxes("left-stick", { forward: 0, strafe: 0 })
    drive.setProfile(drone)
    drive.setProfile(go2)
    drive.setRunning({ bp: [{ streams: [{ name: "cmd_vel", type: "dimos.msgs.geometry_msgs.Twist.Twist", direction: "in" }] }] })
    await wait(600)
    assertEquals([puts.length, deadmen.length, opened.length], [0, 0, 0])
    drive.setAxes("keys", { forward: 1 })
    await wait(120)
    assert(puts.length > 0)
    assertEquals(deadmen, ["dimos/cmd_vel/geometry_msgs.Twist"])
    drive.setAxes("keys", {})
    await wait(1300)
    assertEquals(cleared, ["dimos/cmd_vel/geometry_msgs.Twist"], "the deadman is cleared once the stop has been heard")
    const count = puts.length
    await wait(500)
    assertEquals(puts.length, count)
    drive.dispose()
})

Deno.test("a missing speed setting (NaN) never counts as moving", async () => {
    localStorage.clear()
    const { connection, puts } = fakeBridge()
    const drive = new Drive(connection, go2)
    const { linear } = drive.settings.get()
    drive.settings.update({ linear: undefined as unknown as number })
    drive.setAxes("keys", { turn: 0 })
    drive.setAxes("stick", { forward: 0 })
    await wait(200)
    assertEquals(puts.length, 0)
    drive.settings.update({ linear })
    drive.dispose()
})
