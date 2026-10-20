// The link watch: when driving holds (latency over the max, the link lost) and when it lets go; and the drive while held.
import { assertEquals } from "jsr:@std/assert@1"
import { checkLink, DEFAULT_MAX_LATENCY_MS, maxLatencyOf } from "../src/core/linkWatch.ts"
import { Drive, type DriveHalt } from "../src/core/drive.ts"
import { decode } from "../src/core/lcm/lcm.ts"
import go2 from "../src/profile/dog.ts"
import type { Connection } from "../src/core/transport.ts"

const held = (reason: DriveHalt["reason"], reconnecting = false): DriveHalt => ({ reason, latencyMs: null, maxMs: 1000, reconnecting })

Deno.test("latency over the max holds; under it, connecting or hidden doesn't; a latency hold waits for Reconnect", () => {
    assertEquals(checkLink({ state: "connected", latencyMs: 1200.4, maxMs: 1000, halt: null }), { halt: { reason: "latency", latencyMs: 1200, maxMs: 1000 } })
    assertEquals(checkLink({ state: "connected", latencyMs: 900, maxMs: 1000, halt: null }), null)
    assertEquals(checkLink({ state: "connected", latencyMs: null, maxMs: 1000, halt: null }), null)
    assertEquals(checkLink({ state: "connecting", latencyMs: 5000, maxMs: 1000, halt: null }), null)
    assertEquals(checkLink({ state: "connected", latencyMs: 5000, maxMs: 1000, halt: null, hidden: true }), null)
    assertEquals(checkLink({ state: "connected", latencyMs: 10, maxMs: 1000, halt: held("latency") }), null)
})

Deno.test("a lost link holds, and lets go once it's connected again; nothing changes mid-reconnect", () => {
    assertEquals(checkLink({ state: "lost", latencyMs: null, maxMs: 1000, halt: null }), { halt: { reason: "lost", latencyMs: null, maxMs: 1000 } })
    assertEquals(checkLink({ state: "lost", latencyMs: null, maxMs: 1000, halt: held("latency") }), { halt: { reason: "lost", latencyMs: null, maxMs: 1000 } })
    assertEquals(checkLink({ state: "lost", latencyMs: null, maxMs: 1000, halt: held("lost") }), null)
    assertEquals(checkLink({ state: "connecting", latencyMs: null, maxMs: 1000, halt: held("lost") }), null)
    assertEquals(checkLink({ state: "connected", latencyMs: 10, maxMs: 1000, halt: held("lost") }), { resume: true })
    assertEquals(checkLink({ state: "lost", latencyMs: null, maxMs: 1000, halt: held("latency", true) }), null)
})

Deno.test("max latency: the setting, else 1000 ms", () => {
    assertEquals(maxLatencyOf(1500), 1500)
    assertEquals(maxLatencyOf(undefined), DEFAULT_MAX_LATENCY_MS)
    assertEquals(maxLatencyOf(0), DEFAULT_MAX_LATENCY_MS)
    assertEquals(maxLatencyOf("x"), DEFAULT_MAX_LATENCY_MS)
})

Deno.test("held: a stop goes out, input is ignored and nothing moves; after resume only new input drives", async () => {
    localStorage.clear()
    const puts: { linear: { x: number }; angular: { z: number } }[] = []
    const client = {
        state: "connected",
        publisher: () => ({ state: "open", put: (bytes: Uint8Array) => puts.push(decode("geometry_msgs.Twist", bytes)), setDeadman: () => Promise.resolve(), clearDeadman: () => Promise.resolve(), close() {} }),
    }
    const drive = new Drive({ client, command() {} } as unknown as Connection, go2)
    drive.setRunning({ bp: [{ streams: [{ name: "cmd_vel", type: "dimos.msgs.geometry_msgs.Twist.Twist", direction: "in" }] }] })
    drive.setAxes("keys", { forward: 1 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    drive.halt({ reason: "latency", latencyMs: 1500, maxMs: 1000 })
    const atHalt = puts.length
    assertEquals(puts.at(-1)!.linear.x, 0, "the stop goes out at once")
    drive.setAxes("keys", { forward: 1 })
    await new Promise((resolve) => setTimeout(resolve, 1300))
    assertEquals(puts.slice(atHalt).every((twist) => twist.linear.x === 0 && twist.angular.z === 0), true, "nothing but zeros while held")
    const quiet = puts.length
    drive.resume()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assertEquals(puts.length, quiet, "resume alone sends nothing")
    assertEquals(drive.state.get().halt, null)
    drive.setAxes("keys", { forward: 1 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assertEquals(puts.at(-1)!.linear.x > 0, true, "new input drives")
    drive.stop()
    drive.dispose()
})
