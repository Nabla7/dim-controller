import { assertEquals } from "jsr:@std/assert@1"
import { TfTree } from "../src/core/tf.ts"
import { checkTf, confirmed, type TfIssue } from "../src/core/tfCheck.ts"

const none: [number, number, number, number] = [0, 0, 0, 1]

function check(tree: TfTree, fixedFrame: string, layers: { name: string; frame: string }[] = [], ages: Record<string, number> = {}): TfIssue[] {
    const snapshot = tree.snapshot(fixedFrame)
    for (const edge of snapshot.edges) {
        edge.ageMs = ages[edge.child] ?? 0
    }
    return checkTf({ snapshot, fixedFrame, layers, placed: (frame) => tree.lookup(frame, fixedFrame) !== null })
}

function go2(): TfTree {
    const tree = new TfTree()
    tree.set("world", "base_link", [0, 0, 0], none, false)
    tree.set("base_link", "camera_link", [0, 0, 0], none, false)
    tree.set("camera_link", "camera_optical", [0, 0, 0], none, true)
    return tree
}

Deno.test("a healthy tree, and no tf at all, have nothing to say", () => {
    assertEquals(check(go2(), "world", [{ name: "/lidar", frame: "world" }, { name: "/color_image", frame: "camera_optical" }]), [])
    assertEquals(check(new TfTree(), "world", [{ name: "/map", frame: "map" }]), [])
})

Deno.test("separate trees: named by root, the fixed frame's first, flagging the frames that can't be drawn", () => {
    const tree = go2()
    tree.set("go2_odom", "go2_base", [0, 0, 0], none, false)
    const [issue] = check(tree, "world")
    assertEquals(issue.kind, "separateTrees")
    assertEquals(issue.summary, "2 separate trees (world, go2_odom)")
    assertEquals(issue.frames, ["go2_base", "go2_odom"])
})

Deno.test("two parents and a cycle", () => {
    const tree = go2()
    tree.set("odom", "base_link", [0, 0, 0], none, false)
    const kinds = check(tree, "world").map((issue) => issue.kind)
    assertEquals(kinds.includes("twoParents"), true)
    const cyclic = new TfTree()
    cyclic.set("world", "base_link", [0, 0, 0], none, false)
    cyclic.set("a", "b", [0, 0, 0], none, false)
    cyclic.set("b", "a", [0, 0, 0], none, false)
    const [first] = check(cyclic, "world")
    assertEquals(first.kind, "cycle")
    assertEquals(first.frames, ["a", "b"])
})

Deno.test("a layer whose frame isn't in the tree, or isn't connected to the fixed frame", () => {
    const tree = go2()
    tree.set("other_root", "lidar_link", [0, 0, 0], none, true)
    const issues = check(tree, "world", [{ name: "/lidar", frame: "lidar_link" }, { name: "/scan", frame: "lidar_link" }, { name: "/cam", frame: "nowhere" }])
    const unplaced = issues.filter((issue) => issue.kind === "unplaced")
    assertEquals(unplaced.map((issue) => issue.summary), ['"lidar_link" isn\'t connected to "world" (/lidar, /scan)', '"nowhere" isn\'t in the tree (/cam)'])
})

Deno.test("a fixed frame that isn't in the tree", () => {
    const [issue] = check(go2(), "map_typo")
    assertEquals(issue.kind, "fixedFrame")
})

Deno.test("stale: a dynamic transform that stopped while others update; static is exempt; all paused is not a problem", () => {
    const tree = go2()
    tree.set("base_link", "lidar", [0, 0, 0], none, false)
    const [issue] = check(tree, "world", [], { lidar: 5000, camera_optical: 60000 })
    assertEquals(issue.kind, "stale")
    assertEquals(issue.frames, ["lidar"])
    assertEquals(issue.summary, "base_link → lidar stopped 5.0 s ago")
    assertEquals(check(tree, "world", [], { base_link: 5000, camera_link: 5000, lidar: 5000 }), [])
})

Deno.test("a problem shows only once two checks in a row see it", () => {
    const tree = go2()
    tree.set("go2_odom", "go2_base", [0, 0, 0], none, false)
    const first = check(tree, "world")
    assertEquals(confirmed([], first), [])
    // the stray tree grew a frame between checks: still the same problem
    tree.set("go2_base", "go2_head", [0, 0, 0], none, false)
    const second = check(tree, "world")
    assertEquals(confirmed(first, second).length, 1)
    assertEquals(confirmed(second, check(go2(), "world")), [])
})
