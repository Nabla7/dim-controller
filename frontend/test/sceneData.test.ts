// A simulated world's scene_data as three.js objects: bodies placed and named for TF, geoms sized and turned like
// MuJoCo's, height fields the right way up.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import * as THREE from "three"
import { buildScene, type SceneData } from "../src/core/sceneData.ts"

const b64 = (array: Float32Array | Uint32Array) => btoa(String.fromCharCode(...new Uint8Array(array.buffer)))
const I: [number, number, number, number] = [0, 0, 0, 1]

const scene: SceneData = {
    format: "dimos.scene_data.v1",
    id: "test",
    frame: "world",
    bodies: [
        {
            name: "cart",
            label: "Cart",
            pos: [1, 2, 0.3],
            quat: I,
            mocap: true,
            geoms: [
                { name: "cart_g0", type: "box", size: [0.4, 0.3, 0.2], pos: [0, 0, 0], quat: I, rgba: [1, 0.5, 0, 1] },
                { name: "cart_g1", type: "cylinder", size: [0.1, 0.5], pos: [0, 0, 0], quat: I, rgba: [1, 1, 1, 1] },
            ],
            lights: [{ name: "lamp", pos: [0, 0, 1], dir: [0, 0, -1], diffuse: [1, 1, 1], directional: false, castshadow: false, cutoff: 40 }],
        },
        {
            name: "terrain",
            label: "Hill",
            pos: [0, 0, 0],
            quat: I,
            mocap: false,
            geoms: [
                { name: "ground", type: "plane", size: [0, 0, 0.05], pos: [0, 0, 0], quat: I, rgba: [1, 1, 1, 1] },
                { name: "hill", type: "hfield", size: [1, 1, 2, 0.1], pos: [0, 0, 0], quat: I, rgba: [0, 1, 0, 1], hfield: "h" },
                { name: "tri", type: "mesh", size: [0, 0, 0], pos: [0, 0, 0], quat: I, rgba: [1, 1, 1, 1], mesh: "tri" },
            ],
            lights: [],
        },
    ],
    meshes: { tri: { vertices: b64(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])), faces: b64(new Uint32Array([0, 1, 2])) } },
    // 2x2 samples; only row 1, column 0 is up: MuJoCo puts that at (-x, +y)
    hfields: { h: { nrow: 2, ncol: 2, size: [1, 1, 2, 0.1], heights: b64(new Float32Array([0, 0, 1, 0])) } },
    textures: {},
}

Deno.test("bodies are named groups at their pose, the plane left to the view's own grid", () => {
    const { root, bodies, lights } = buildScene(scene)
    assertEquals([...bodies.keys()], ["cart", "terrain"])
    assertEquals(bodies.get("cart")!.position.toArray(), [1, 2, 0.3])
    assertEquals(bodies.get("terrain")!.children.map((child) => child.name), ["hill", "tri"])
    assertEquals(lights.length, 1)
    assert(lights[0] instanceof THREE.SpotLight)
    assert(root.children.length === 2)
})

Deno.test("a box takes MuJoCo's half-sizes; a cylinder stands along z", () => {
    const { bodies } = buildScene(scene)
    const [box, cylinder] = bodies.get("cart")!.children.filter((child) => (child as THREE.Mesh).isMesh) as THREE.Mesh[]
    box.geometry.computeBoundingBox()
    assertEquals(box.geometry.boundingBox!.max.toArray().map((v) => Math.round(v * 100) / 100), [0.4, 0.3, 0.2])
    cylinder.geometry.computeBoundingBox()
    assertAlmostEquals(cylinder.geometry.boundingBox!.max.z, 0.5, 1e-6)
    assertAlmostEquals(cylinder.geometry.boundingBox!.max.y, 0.1, 1e-6)
})

Deno.test("a height field's raised sample lands at (-x, +y), scaled by its top", () => {
    const { bodies } = buildScene(scene)
    const hill = bodies.get("terrain")!.children[0] as THREE.Mesh
    const position = hill.geometry.getAttribute("position")
    let high = 0
    for (let index = 1; index < position.count; index++) {
        if (position.getZ(index) > position.getZ(high)) {
            high = index
        }
    }
    assertEquals([position.getX(high), position.getY(high), position.getZ(high)], [-1, 1, 2])
})
