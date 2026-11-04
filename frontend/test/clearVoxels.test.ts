// A cloud's "clear" color (core/render/clearVoxels.ts): see-through grey boxes like the MLS planner's map pages, in the
// theme's voxel grey, and leaving it gives the cloud back its own look untouched.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import * as THREE from "three"
import { TfTree } from "dimos-react/three"
import { CLEAR_VOXEL_COLOR, CLEAR_VOXEL_OPACITY, ClearVoxels, clearVoxelColor } from "../src/core/render/clearVoxels.ts"
import { COLOR_MODES, materialLook, type PointLook } from "../src/core/render/rendering.ts"
import { TfHistory } from "../src/core/tfHistory.ts"
import { LayerManager } from "../src/core/layers/manager.ts"
import { FILE_INFO, LEGACY_FILE_INFO, ROBOT_DESCRIPTION } from "../src/core/urdfSource.ts"
import { cloudQualities } from "../src/core/cloudQuality.ts"
import { Store } from "../src/core/store.ts"
import type { Connection, SubscribeOptions, Topic } from "../src/core/transport.ts"
import "../src/layers/pointcloud.tsx"

const hex = (color: THREE.Color) => `#${color.getHexString()}`

Deno.test("clear is a color choice, and the points' own shader is given a real mode under it", () => {
    assert(COLOR_MODES.some(([mode]) => mode === "clear"))
    const look = { style: "voxel", size: 0.1, colorMode: "clear", gradient: "viridis", axis: 2, rangeMin: null, rangeMax: null, solid: "#ff0000", opacity: 1 } as PointLook
    assertEquals(materialLook(look).colorMode, "height")
})

Deno.test("the boxes: 0.96 of the voxel, Lambert, 0.28 opacity, no depth writes, the theme's voxel grey", () => {
    const parent = new THREE.Group()
    const boxes = new ClearVoxels(parent)
    assert(boxes.material instanceof THREE.MeshLambertMaterial)
    assertEquals([boxes.material.opacity, boxes.material.transparent, boxes.material.depthWrite], [CLEAR_VOXEL_OPACITY, true, false])
    boxes.theme(false)
    assertEquals(hex(boxes.material.color), CLEAR_VOXEL_COLOR.light)
    boxes.theme(true)
    assertEquals(hex(boxes.material.color), CLEAR_VOXEL_COLOR.dark)
    assertEquals([clearVoxelColor(false), clearVoxelColor(true)], ["#8fa3b5", "#5f7385"])
    boxes.place([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, 0.5, (index) => index !== 1)
    assertEquals(boxes.mesh.count, 2, "a point left out is no box")
    const matrix = new THREE.Matrix4()
    boxes.mesh.getMatrixAt(1, matrix)
    const position = new THREE.Vector3(), scale = new THREE.Vector3()
    matrix.decompose(position, new THREE.Quaternion(), scale)
    assertEquals(position.toArray(), [7, 8, 9])
    assertAlmostEquals(scale.x, 0.48, 1e-6)
    assertEquals(boxes.mesh.parent, parent)
})

Deno.test("more points than boxes grows the mesh in place under the same parent", () => {
    const parent = new THREE.Group()
    const boxes = new ClearVoxels(parent)
    const xyz = new Float32Array(300 * 3)
    boxes.place(xyz, 300, 0.1)
    assertEquals([boxes.mesh.count, parent.children.length, boxes.mesh.parent], [300, 1, parent])
    assert(boxes.mesh.instanceMatrix.count >= 300)
    boxes.empty()
    assertEquals(boxes.mesh.count, 0)
})

const lidar: Topic = { key: "dimos/lidar/sensor_msgs.PointCloud2", name: "/lidar", type: "sensor_msgs.PointCloud2" }

/** A cloud layer on fake transport (as test/tfHistory.test.ts): `scan` delivers a scan in world. */
function cloudScene() {
    localStorage.clear()
    cloudQualities.set({})
    const tree = new TfTree()
    tree.set("world", "lidar", [0, 0, 0], [0, 0, 0, 1], true)
    const subscriptions: { options: SubscribeOptions; deliver: (message: unknown) => void }[] = []
    const status = new Store<{ topics: Topic[] }>({ topics: [] })
    const connection = {
        status,
        subscribe(key: string, options: SubscribeOptions, onMessage: (message: unknown) => void) {
            if (![FILE_INFO, LEGACY_FILE_INFO, ROBOT_DESCRIPTION].includes(key)) {
                subscriptions.push({ options, deliver: onMessage })
            }
            return () => {}
        },
    } as unknown as Connection
    const added: THREE.Object3D[] = []
    const viewer = { scene: { add: (object: THREE.Object3D) => added.push(object), remove: () => {} }, onFrame: () => () => {}, requestRender: () => {}, noteData: () => {}, pixelsPerMeter: { value: 100 }, fixedFrame: "world" }
    const manager = new LayerManager(viewer as never, tree, new TfHistory(tree), connection, {} as never, {} as never)
    status.set({ topics: [lidar] })
    const entry = manager.entries.get().list.find((item) => item.topic.key === lidar.key)!
    const stream = subscriptions.find((item) => item.options.maxHz === 20)!
    const points = added[0].children[0] as THREE.Points
    const material = points.material as THREE.ShaderMaterial
    return {
        settings: entry.settings as Store<{ look: PointLook }>,
        points,
        boxes: () => points.children.find((child) => (child as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh,
        uniforms: () => Object.fromEntries(Object.entries(material.uniforms).map(([name, uniform]) => [name, JSON.stringify(uniform.value)])),
        material,
        scan: (xyz: number[]) => stream.deliver({ decoded: { positions: new Float32Array(xyz) }, bytes: new Uint8Array(1), timestamp: 100, header: { stamp: 0.1, sec: 0, nanosec: 0, frameId: "lidar" } }),
        close: () => manager.setPaused(true),
    }
}

Deno.test("a cloud in clear: one box per point instead of its points; back to solid restores the look exactly", () => {
    const scene = cloudScene()
    scene.settings.update({ look: { ...scene.settings.get().look, colorMode: "solid", solid: "#ff8800", opacity: 0.6, size: 0.2 } })
    scene.scan([1, 0, 0, 2, 0, 0, 3, 0, 0])
    const before = { uniforms: scene.uniforms(), transparent: scene.material.transparent, depthWrite: scene.material.depthWrite, defines: { ...scene.material.defines } }
    assertEquals([scene.material.visible, scene.boxes().count], [true, 0])

    scene.settings.update({ look: { ...scene.settings.get().look, colorMode: "clear" } })
    assertEquals([scene.material.visible, scene.boxes().count], [false, 3])
    scene.scan([5, 0, 0, 6, 0, 0])
    assertEquals(scene.boxes().count, 2, "follows each new scan")
    const matrix = new THREE.Matrix4()
    scene.boxes().getMatrixAt(0, matrix)
    assertAlmostEquals(new THREE.Vector3().setFromMatrixScale(matrix).x, 0.2 * 0.96, 1e-6)

    scene.settings.update({ look: { ...scene.settings.get().look, colorMode: "solid" } })
    scene.scan([1, 0, 0, 2, 0, 0, 3, 0, 0])
    assertEquals([scene.material.visible, scene.boxes().count], [true, 0])
    assertEquals({ uniforms: scene.uniforms(), transparent: scene.material.transparent, depthWrite: scene.material.depthWrite, defines: { ...scene.material.defines } }, before)
    assertEquals(scene.settings.get().look.solid, "#ff8800", "clear never touched the other modes' settings")
    scene.close()
})
