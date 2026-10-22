// Auto robot type (core/robotType.ts): robots.json's type for a running blueprint, joint topics without cmd_vel → arm,
// Desktop's default robot, the blueprint's name, else dog.
import { assertEquals } from "jsr:@std/assert@1"
import { chosenType, resolveType, robotsAnswer, typeFromName } from "../src/core/robotType.ts"
import go2 from "./fixtures/blueprint_unitree-go2.json" with { type: "json" }

const go2Modules = (go2 as { modules: never[] }).modules
const armModules = [
    { name: "ControlCoordinator", streams: [{ name: "joint_state", type: "dimos.msgs.sensor_msgs.JointState.JointState", direction: "out" }, { name: "joint_command", type: "dimos.msgs.sensor_msgs.JointState.JointState", direction: "in" }] },
]
const robots = {
    defaultRobot: "go2",
    robots: [
        { id: "go2", type: "dog", blueprints: { "unitree-go2": {}, "unitree-go2-basic": {} } },
        { id: "g1", type: "humanoid", blueprints: ["unitree-g1-sim"] },
        { id: "xarm", type: "arm", blueprints: { "xarm-perception-sim": {} } },
        { id: "spot", type: null, blueprints: { spot: {} } },
    ],
}

Deno.test("a pick in Settings; an old profile name (saved by default, not picked) is auto", () => {
    assertEquals(chosenType(""), null)
    assertEquals(chosenType("arm"), "arm")
    assertEquals(chosenType("Unitree Go2"), null)
    assertEquals(chosenType("Galaxea R1 Pro"), null)
    assertEquals(chosenType("nonsense"), null)
})

Deno.test("robots.json's type for the running blueprint wins over Desktop's default robot", () => {
    assertEquals(resolveType({ robots, blueprints: { "xarm-perception-sim": null }, topics: [] }).type, "arm")
    assertEquals(resolveType({ robots, blueprints: { "unitree-g1-sim": null }, topics: [] }).type, "humanoid")
})

Deno.test("joint topics and no cmd_vel → arm, even with a dog as Desktop's default", () => {
    const resolved = resolveType({ robots, blueprints: { "coordinator-mock": armModules }, topics: [] })
    assertEquals(resolved.type, "arm")
    // only topics (no Desktop): /joint_state on the bridge, nothing with cmd_vel
    assertEquals(resolveType({ robots: null, blueprints: {}, topics: ["/joint_state", "/color_image"] }).type, "arm")
    // a robot that has both is not an arm
    assertEquals(resolveType({ robots: null, blueprints: {}, topics: ["/joint_states", "/cmd_vel"] }).type, "dog")
})

Deno.test("a go2 blueprint with velocity inputs isn't an arm; Desktop's default robot comes next", () => {
    assertEquals(resolveType({ robots, blueprints: { "my-go2": go2Modules }, topics: [] }), { type: "dog", reason: "Desktop's default robot is go2 (dog)" })
    assertEquals(resolveType({ robots: { defaultRobot: "g1", robots: robots.robots }, blueprints: {}, topics: [] }).type, "humanoid")
})

Deno.test("else the blueprint's name, else dog", () => {
    assertEquals(typeFromName("drone-agentic"), "drone")
    assertEquals(typeFromName("unitree-g1-basic-sim"), "humanoid")
    assertEquals(typeFromName("r1pro-coordinator"), "wheeled")
    assertEquals(typeFromName("keyboard-teleop-xarm7"), "arm")
    assertEquals(typeFromName("coordinator-mock"), "arm")
    assertEquals(typeFromName("spot-replay"), "dog")
    assertEquals(resolveType({ robots: null, blueprints: { "alfred-keyboard-teleop": null }, topics: [] }).type, "wheeled")
    assertEquals(resolveType({ robots: null, blueprints: {}, topics: [] }), { type: "dog", reason: "nothing says otherwise" })
})

Deno.test("the dimos gateway's catalog/robots and Desktop's settings make the answer; missing ones make none", () => {
    const catalog = { types: { dog: { label: "Dog" } }, robots: { go2: { name: "Go2", type: "dog", blueprints: ["unitree-go2"] }, spot: { type: null, blueprints: ["spot"] } } }
    const answer = robotsAnswer(catalog, { ui: { default_robot: "go2" } })
    assertEquals(answer, { defaultRobot: "go2", robots: [{ id: "go2", type: "dog", blueprints: ["unitree-go2"] }, { id: "spot", type: null, blueprints: ["spot"] }] })
    assertEquals(resolveType({ robots: answer, blueprints: { "unitree-go2": null }, topics: [] }).reason, "unitree-go2 is a go2 blueprint (robots.json: dog)")
    assertEquals(robotsAnswer(catalog, null)?.defaultRobot, null)
    assertEquals(robotsAnswer(null, { ui: { default_robot: "go2" } }), null)
})
