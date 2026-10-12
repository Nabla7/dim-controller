import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { Vector3 } from "three"
import { TfTree } from "../src/core/tf.ts"

const yaw90: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]
const none: [number, number, number, number] = [0, 0, 0, 1]
const placed = (tree: TfTree, frame: string, fixed: string, point = new Vector3()) => point.applyMatrix4(tree.lookup(frame, fixed)!)

Deno.test("a chain composes parent to child, and works from the other end too", () => {
    const tree = new TfTree()
    tree.set("world", "odom", [1, 0, 0], none, true)
    tree.set("odom", "base_link", [0, 2, 0], yaw90, false)
    tree.set("base_link", "lidar", [1, 0, 0.5], none, true)
    // lidar's origin: base is at (1,2,0) facing +y, so 1 m forward is +y
    const lidar = placed(tree, "lidar", "world")
    assertAlmostEquals(lidar.x, 1)
    assertAlmostEquals(lidar.y, 3)
    assertAlmostEquals(lidar.z, 0.5)
    // and the world origin seen from the lidar frame
    const origin = placed(tree, "world", "lidar")
    assertAlmostEquals(origin.length(), Math.hypot(1, 3, 0.5))
    assertEquals(tree.lookup("", "world")?.equals(tree.lookup("world", "world")!), true)
})

Deno.test("frames in different trees, or unknown ones, have no placement", () => {
    const tree = new TfTree()
    tree.set("world", "base_link", [0, 0, 0], none, false)
    tree.set("camera_root", "camera", [0, 0, 0], none, false)
    assertEquals(tree.lookup("camera", "world"), null)
    assertEquals(tree.lookup("nope", "world"), null)
    const problems = tree.snapshot("world").problems
    assertEquals(problems.roots, ["camera_root", "world"])
})

Deno.test("problems: double parents and staleness (static exempt)", async () => {
    const tree = new TfTree()
    tree.set("map", "base_link", [0, 0, 0], none, false)
    tree.set("odom", "base_link", [0, 0, 0], none, false)
    tree.set("map", "static_thing", [0, 0, 0], none, true)
    const snapshot = tree.snapshot("map")
    assertEquals(snapshot.problems.doubleParent, [["base_link", ["map", "odom"]]])
    await new Promise((resolve) => setTimeout(resolve, 2100))
    const later = tree.snapshot("map").problems
    assertEquals(later.stale, ["base_link"])
})

Deno.test("the default fixed frame prefers world-ish roots", () => {
    const tree = new TfTree()
    tree.set("map", "odom", [0, 0, 0], none, true)
    tree.set("odom", "base_link", [0, 0, 0], none, false)
    assertEquals(tree.defaultFixedFrame(), "map")
    const empty = new TfTree()
    assertEquals(empty.defaultFixedFrame(), "world")
    // no tf at all: world and map stand in for each other
    assert(empty.lookup("map", "world"))
})
