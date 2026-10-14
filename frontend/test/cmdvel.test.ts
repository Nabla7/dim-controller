// Which topics auto drives, and whether the running blueprints take velocity commands (core/cmdvel.ts), against
// real metadata from Desktop's GET /dimos-gateway/blueprints/<name> (test/fixtures/blueprint_*.json, 2026-10-05).
import { assertEquals } from "jsr:@std/assert@1"
import { autoTopics, entryPoints, type Module, parseTopics, takesVelocity, TWIST, TWIST_STAMPED, zenohKey } from "../src/core/cmdvel.ts"

const load = (name: string): Module[] => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/blueprint_${name}.json`, import.meta.url))).modules
const go2Basic = load("unitree-go2-basic")
const go2 = load("unitree-go2")
const spotReplay = load("spot-replay")
const topics = (list: { topic: string; type: string }[]) => list.map(({ topic, type }) => `${topic} ${type}`)

Deno.test("unitree-go2-basic: the connection's cmd_vel (the web UIs' tele_cmd_vel outputs don't count as inputs)", () => {
    assertEquals(topics(autoTopics({ "unitree-go2-basic": go2Basic })), [`/cmd_vel ${TWIST}`])
})

Deno.test("unitree-go2: MovementManager's tele_cmd_vel; its own cmd_vel output and the planner's nav_cmd_vel aren't driven too", () => {
    assertEquals(topics(autoTopics({ "unitree-go2": go2 })), [`/tele_cmd_vel ${TWIST}`])
})

Deno.test("a mux's output is internal; one topic per module, tele first; TwistStamped keeps its type", () => {
    const stamped = "dimos.msgs.geometry_msgs.TwistStamped.TwistStamped"
    const twist = "dimos.msgs.geometry_msgs.Twist.Twist"
    const modules: Module[] = [
        { name: "command", streams: [{ name: "cmd_vel_in", type: stamped, direction: "in" }, { name: "tele_cmd_vel", type: twist, direction: "out" }] },
        { name: "mux", streams: [{ name: "nav_cmd_vel", type: twist, direction: "in" }, { name: "tele_cmd_vel", type: twist, direction: "in" }, { name: "cmd_vel", type: twist, direction: "out" }] },
        { name: "robot", streams: [{ name: "cmd_vel", type: twist, direction: "in" }] },
        { name: "camera", streams: [{ name: "image", type: "dimos.msgs.sensor_msgs.Image.Image", direction: "out" }] },
    ]
    assertEquals(entryPoints(modules), [
        { topic: "/cmd_vel_in", type: TWIST_STAMPED, module: "command" },
        { topic: "/nav_cmd_vel", type: TWIST, module: "mux" },
    ])
})

Deno.test("without metadata: the standard set, /cmd_vel and dimos/cmd_vel being one zenoh key", () => {
    assertEquals(zenohKey("/cmd_vel", TWIST), zenohKey("dimos/cmd_vel", TWIST))
    assertEquals(topics(autoTopics({})), [`/cmd_vel ${TWIST}`, `/tele_cmd_vel ${TWIST}`])
    assertEquals(topics(autoTopics({ "mystery": null })), [`/cmd_vel ${TWIST}`, `/tele_cmd_vel ${TWIST}`])
})

Deno.test("the warning: false only when every running blueprint is known and none takes velocity", () => {
    assertEquals(takesVelocity({ "spot-replay": spotReplay }), false)
    assertEquals(takesVelocity({ "unitree-go2-basic": go2Basic }), true)
    assertEquals(takesVelocity({ "spot-replay": spotReplay, "unitree-go2": go2 }), true)
    assertEquals(takesVelocity({ "spot-replay": spotReplay, "mystery": null }), null)
    assertEquals(takesVelocity({}), null)
})

Deno.test("typed topics: a name, a name + TwistStamped, the type from metadata when it names the stream", () => {
    const stamped: Module[] = [{ streams: [{ name: "cmd_vel_in", type: "dimos.msgs.geometry_msgs.TwistStamped.TwistStamped", direction: "in" }] }]
    assertEquals(topics(parseTopics(["mine", "/other TwistStamped", "cmd_vel_in", " ", "/mine"], { x: stamped })), [
        `/mine ${TWIST}`,
        `/other ${TWIST_STAMPED}`,
        `/cmd_vel_in ${TWIST_STAMPED}`,
    ])
})
