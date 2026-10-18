// TF as of a past moment (core/tfHistory.ts) and point clouds placed with it (layers/pointcloud.tsx): a scan is placed
// once, with the transform from its own timestamp, and stays put while odom (50 Hz) keeps moving between scans (10 Hz).
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { Vector3 } from "three"
import type * as THREE from "three"
import { TfTree } from "dimos-react/three"
import { TfHistory } from "../src/core/tfHistory.ts"
import { LayerManager } from "../src/core/layers/manager.ts"
import { cloudQualities } from "../src/core/cloudQuality.ts"
import { Store } from "../src/core/store.ts"
import type { Connection, SubscribeOptions, Topic } from "../src/core/transport.ts"
import { encode } from "../src/core/lcm/lcm.ts"
import "../src/layers/pointcloud.tsx"

const none: [number, number, number, number] = [0, 0, 0, 1]
const yaw90: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]

/** tree + history fed together, the way core/tfFeed.ts does */
function feed() {
    const tree = new TfTree()
    const history = new TfHistory(tree)
    const set = (parent: string, child: string, translation: [number, number, number], rotation: [number, number, number, number], stamp: number, isStatic = false) => {
        tree.set(parent, child, translation, rotation, isStatic)
        history.record(parent, child, translation, rotation, stamp, isStatic)
    }
    return { tree, history, set }
}

const origin = (matrix: THREE.Matrix4 | null) => new Vector3().applyMatrix4(matrix!)

Deno.test("a lookup at a stamp interpolates each edge between the samples around it", () => {
    const { history, set } = feed()
    set("world", "odom", [0, 0, 0], none, 0, true)
    set("odom", "base_link", [0, 0, 0], none, 1000)
    set("odom", "base_link", [2, 0, 0], yaw90, 1100)
    set("base_link", "lidar", [1, 0, 0], none, 0, true)
    const halfway = history.lookupAt("lidar", "world", 1050)!
    // base at x=1 turned 45°: the lidar 1 m ahead of it
    assertAlmostEquals(origin(halfway).x, 1 + Math.SQRT1_2)
    assertAlmostEquals(origin(halfway).y, Math.SQRT1_2)
    assertAlmostEquals(origin(history.lookupAt("lidar", "world", 1000)).x, 1)
    // and the inverse direction
    assertAlmostEquals(origin(history.lookupAt("world", "base_link", 1000)).x, 0)
    assertAlmostEquals(origin(history.lookupAt("world", "base_link", 1100)).y, 2)
})

Deno.test("a stamp outside what's kept gets each edge's newest sample, and an unknown path the live tree's answer", () => {
    const { history, set } = feed()
    set("odom", "base_link", [1, 0, 0], none, 1000)
    set("odom", "base_link", [3, 0, 0], none, 1100)
    assertAlmostEquals(origin(history.lookupAt("base_link", "odom", 5000)).x, 3, "newer than every sample")
    assertAlmostEquals(origin(history.lookupAt("base_link", "odom", 10)).x, 3, "older than every sample")
    assertEquals(history.lookupAt("nowhere", "odom", 1000), null)
    // no tf for world or map: the tree has them stand in for each other
    assert(history.lookupAt("map", "world", 1000))
    // the result is the caller's to keep: a later sample doesn't change it
    const kept = history.lookupAt("base_link", "odom", 1100)!
    set("odom", "base_link", [9, 0, 0], none, 1200)
    assertAlmostEquals(origin(kept).x, 3)
})

Deno.test("history is bounded per edge, keeps samples sorted, and a new parent starts the edge over", () => {
    const { history, set } = feed()
    for (let stamp = 0; stamp <= 10_000; stamp += 20) {
        set("odom", "base_link", [stamp / 1000, 0, 0], none, stamp)
    }
    // 0..4.98 s fell out of the 5 s window: an old stamp gets the newest
    assertAlmostEquals(origin(history.lookupAt("base_link", "odom", 1000)).x, 10)
    assertAlmostEquals(origin(history.lookupAt("base_link", "odom", 7010)).x, 7.01)
    set("odom", "base_link", [100, 0, 0], none, 7015) // late arrival, slotted in by stamp
    assertAlmostEquals(origin(history.lookupAt("base_link", "odom", 7015)).x, 100)
    assertAlmostEquals(origin(history.lookupAt("base_link", "odom", 9990)).x, 9.99)
    set("map", "base_link", [5, 0, 0], none, 11_000)
    assertEquals(history.lookupAt("base_link", "odom", 9990), null)
    assertAlmostEquals(origin(history.lookupAt("base_link", "map", 9990)).x, 5)
})

// ---- the point cloud layer: frozen per scan ----

const lidar: Topic = { key: "dimos/lidar/sensor_msgs.PointCloud2", name: "/lidar", type: "sensor_msgs.PointCloud2" }

function rawCloud(frameId: string): Uint8Array {
    return encode("sensor_msgs.PointCloud2", { header: { seq: 0, stamp: { sec: 0, nsec: 0 }, frame_id: frameId }, height: 1, width: 0, fields_length: 0, fields: [], is_bigendian: false, point_step: 0, row_step: 0, data_length: 0, data: new Uint8Array(), is_dense: true })
}

/** A cloud layer on fake transport: `scan(points, stamp)` delivers one compact scan, `drawn()` its first point in the fixed frame. */
function cloudScene(tf: TfTree, history: TfHistory, mode: "latest" | "accumulate") {
    localStorage.clear()
    cloudQualities.set({})
    const subscriptions: { options: SubscribeOptions; deliver: (message: unknown) => void }[] = []
    const status = new Store<{ topics: Topic[] }>({ topics: [] })
    const connection = {
        status,
        subscribe(_key: string, options: SubscribeOptions, onMessage: (message: unknown) => void) {
            subscriptions.push({ options, deliver: onMessage })
            return () => {}
        },
    } as unknown as Connection
    const added: THREE.Object3D[] = []
    const onFrames: ((frame: unknown) => void)[] = []
    const viewer = {
        scene: { add: (object: THREE.Object3D) => added.push(object), remove: () => {} },
        onFrame: (callback: (frame: unknown) => void) => (onFrames.push(callback), () => {}),
        requestRender: () => {},
        noteData: () => {},
        pixelsPerMeter: { value: 100 },
        fixedFrame: "world",
    }
    const manager = new LayerManager(viewer as never, tf, history, connection, {} as never, {} as never)
    status.set({ topics: [lidar] })
    const entry = manager.entries.get().list.find((item) => item.topic.key === lidar.key)!
    entry.settings.update({ mode })
    subscriptions.find((item) => !item.options.encoding)!.deliver({ bytes: rawCloud("lidar") }) // the frame_id read
    const stream = subscriptions.find((item) => item.options.encoding)!
    const points = added[0].children[0] as THREE.Points
    const frame = (now: number) => onFrames.forEach((callback) => callback({ now, fixedFrame: "world" }))
    return {
        scan: (xyz: number[], stamp: number) => stream.deliver({ decoded: { positions: new Float32Array(xyz) }, bytes: new Uint8Array(1), timestamp: stamp }),
        drawn: (index = 0) => {
            const position = points.geometry.getAttribute("position")
            return new Vector3(position.getX(index), position.getY(index), position.getZ(index)).applyMatrix4(points.matrix)
        },
        frame,
        close: () => manager.setPaused(true),
        problem: () => manager.entries.get().list.find((item) => item.topic.key === lidar.key)!.status?.problem,
    }
}

for (const mode of ["latest", "accumulate"] as const) {
    Deno.test(`${mode}: a scan is placed as of its own stamp and doesn't move while odom runs ahead of the next scan`, () => {
        const { tree, history, set } = feed()
        set("world", "base_link", [0, 0, 0], none, 0)
        set("base_link", "lidar", [0, 0, 1], none, 0, true)
        const scene = cloudScene(tree, history, mode)
        // the robot drives +x at 1 m/s, odom at 50 Hz; the scan stamped at 1000 ms arrives after odom reached 1040 ms
        for (let stamp = 0; stamp <= 1040; stamp += 20) {
            set("world", "base_link", [stamp / 1000, 0, 0], none, stamp)
        }
        scene.scan([2, 0, 0], 1000)
        scene.frame(1040)
        assertAlmostEquals(scene.drawn().x, 3, 1e-6, "placed with the 1000 ms pose, not the newest")
        assertAlmostEquals(scene.drawn().z, 1, 1e-6)
        // odom keeps going for the 100 ms until the next scan: the drawn one stays put
        for (let stamp = 1060; stamp <= 1140; stamp += 20) {
            set("world", "base_link", [stamp / 1000, 0, 0], none, stamp)
            scene.frame(stamp)
            assertAlmostEquals(scene.drawn().x, 3, 1e-6, `moved by odom at ${stamp} ms`)
        }
        // the next scan gets its own placement; a kept one keeps its own
        scene.scan([2, 0, 0], 1100)
        scene.frame(1150)
        assertAlmostEquals(scene.drawn(mode === "accumulate" ? 1 : 0).x, 3.1, 1e-6)
        if (mode === "accumulate") {
            assertAlmostEquals(scene.drawn(0).x, 3, 1e-6, "the earlier kept scan")
        }
        assertEquals(scene.problem() ?? null, null)
        scene.close()
    })
}

Deno.test("a scan with no TF path is not drawn, and says why", () => {
    const { tree, history, set } = feed()
    set("world", "base_link", [0, 0, 0], none, 0)
    const scene = cloudScene(tree, history, "latest")
    scene.scan([1, 0, 0], 100)
    assert(scene.problem()?.includes("no TF path"))
    scene.close()
})
