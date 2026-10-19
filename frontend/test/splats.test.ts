// Splat files in a URDF and the hashed mesh names: ?hash= split off for the cache key, splat files told from meshes
// (a .ply by its header), the robot, a scene's meshes and splats, and people each shown by its own toggle, meshes
// untextured, and /people switched with the robot model's people.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { DOMParser } from "https://esm.sh/@xmldom/xmldom@0.8.10"
import * as THREE from "three"
import { parseUrdf } from "../src/core/urdf.ts"
import { splitHash } from "../src/core/meshCache.ts"
import { type SplatAsset, splatFileType } from "../src/core/splats.ts"
import { LayerManager } from "../src/core/layers/manager.ts"
import { registerLayer } from "../src/core/layers/registry.ts"
import { Store } from "../src/core/store.ts"
import type { Connection, Topic } from "../src/core/transport.ts"
import { Kinematics, linkPart, modelPartsOf, RobotModel } from "../src/core/robotDescription.ts"

;(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser

const SPLATS = "package://dim_go2_sim/scenes/home/splats.spz?hash=aa11"
const COLLISION = "package://dim_go2_sim/scenes/home/collision.stl?hash=bb22"
// as dim-go2-sim publishes a scene: splats and collision meshes on their own links, fixed to world; the robot floats
const SCENE = `<robot name="home">
  <link name="world"/>
  <link name="scene_splats"><visual><origin xyz="1 2 0"/><geometry><mesh filename="${SPLATS}" scale="2 2 2"/></geometry></visual></link>
  <link name="scene_mesh"><visual><geometry><mesh filename="${COLLISION}"/></geometry></visual></link>
  <link name="base_link"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
  <joint name="splats" type="fixed"><parent link="world"/><child link="scene_splats"/></joint>
  <joint name="mesh" type="fixed"><parent link="world"/><child link="scene_mesh"/></joint>
  <joint name="base" type="floating"><parent link="world"/><child link="base_link"/></joint>
  <link name="person_0"><visual><geometry><box size="0.3 0.3 1.7"/></geometry></visual></link>
  <joint name="person_0_joint" type="floating"><parent link="world"/><child link="person_0"/></joint>
</robot>`

Deno.test("a hashed name splits into the cache key and its hash", () => {
    assertEquals(splitHash(SPLATS), { base: "package://dim_go2_sim/scenes/home/splats.spz", hash: "aa11" })
    assertEquals(splitHash("package://a/b.stl"), { base: "package://a/b.stl", hash: null })
    assertEquals(splitHash("package://a/b.stl?hash="), { base: "package://a/b.stl", hash: null })
    assertEquals(splitHash("package://a/b.stl?hash=cc&have=dd"), { base: "package://a/b.stl", hash: "cc" })
})

Deno.test("splat files are told from meshes, a .ply by its properties", () => {
    const empty = new Uint8Array()
    assertEquals(splatFileType(SPLATS, empty), "spz")
    assertEquals(splatFileType("package://a/b.sog?hash=1", empty), "pcsogszip")
    assertEquals(splatFileType("package://a/b.ksplat", empty), "ksplat")
    assertEquals(splatFileType(COLLISION, empty), null)
    const ply = (properties: string) => new TextEncoder().encode(`ply\nformat binary_little_endian 1.0\nelement vertex 1\n${properties}end_header\n`)
    assertEquals(splatFileType("package://a/g.ply", ply("property float x\nproperty float f_dc_0\nproperty float scale_0\n")), "ply")
    assertEquals(splatFileType("package://a/m.ply", ply("property float x\nproperty float nx\n")), null)
})

Deno.test("the robot, the scene's meshes, its splats and people each show by their own toggle", () => {
    const cuts: (number | null)[] = []
    const fake: SplatAsset = { count: 3, mesh: () => Object.assign(new THREE.Object3D(), { opacity: 1, setCutAbove: (height: number | null) => cuts.push(height) }), dispose: () => {} }
    const geometries = new Map([[COLLISION, new THREE.BoxGeometry()]])
    const model = new RobotModel(new Kinematics(parseUrdf(SCENE)), geometries, { opacity: 0.5 }, new Map([[SPLATS, fake]]))
    const splat = model.links.get("scene_splats")!.children[0] as THREE.Object3D & { opacity: number }
    const mesh = model.links.get("scene_mesh")!.children[0]
    const robot = model.links.get("base_link")!.children[0]
    const person = model.links.get("person_0")!.children[0]
    assert(model.hasSplats)
    // the URDF origin and scale, and the layer's opacity
    assertEquals(new THREE.Vector3().setFromMatrixPosition(splat.matrix).toArray(), [1, 2, 0])
    assertEquals(new THREE.Vector3().setFromMatrixScale(splat.matrix).toArray(), [2, 2, 2])
    assertEquals(splat.opacity, 0.5)
    const shown = () => [robot.visible, mesh.visible, splat.visible, person.visible]
    const all = { robot: true, meshes: true, splats: true, people: true }
    assertEquals(shown(), [true, true, true, true])
    for (const [index, part] of (["robot", "meshes", "splats", "people"] as const).entries()) {
        model.setParts({ ...all, [part]: false })
        assertEquals(shown(), [0, 1, 2, 3].map((other) => other !== index))
    }
    // textures off doesn't touch what shows
    model.setTextures(false)
    model.setParts({ robot: false, meshes: true, splats: false, people: true })
    assertEquals(shown(), [false, true, false, true])
    model.setTextures(true)
    model.setParts(all)
    model.setDisplay("collision")
    assertEquals(shown(), [false, false, false, false])
    // the ceiling cut reaches every splat object
    model.setSplatCutAbove(2.5)
    assertEquals(cuts, [null, 2.5])
})

Deno.test("links are told apart by name: a scene's, a person's, the robot's", () => {
    assertEquals(["scene_mesh", "go2_scene_splats", "person_0", "sim/person_12", "base_link", "salesperson_1", "FL_calf"].map(linkPart), ["scene", "scene", "person", "person", "robot", "robot", "robot"])
})

Deno.test("textures off draws meshes flat grey at their opacity, on puts their own material back, meshes arriving later too", () => {
    const geometries = new Map<string, THREE.BufferGeometry>()
    const description = parseUrdf(SCENE)
    description.links.find((link) => link.name === "base_link")!.visuals[0].color = [1, 0, 0, 1]
    const model = new RobotModel(new Kinematics(description), geometries, { opacity: 0.5 })
    const box = model.links.get("base_link")!.children[0] as THREE.Mesh
    const own = box.material as THREE.MeshStandardMaterial
    assertEquals(own.color.getHexString(), "ff0000")
    model.setTextures(false)
    const plain = box.material as THREE.MeshStandardMaterial
    assert(plain !== own && plain.flatShading)
    assertEquals(plain.color.getHexString(), new THREE.Color("#9aa0a6").getHexString())
    assertEquals(plain.opacity, 0.5)
    // a mesh that arrives while textures are off comes in plain
    geometries.set(COLLISION, new THREE.BoxGeometry())
    model.fill(geometries)
    const late = model.links.get("scene_mesh")!.children[0] as THREE.Mesh
    assert((late.material as THREE.MeshStandardMaterial).flatShading)
    model.setTextures(true)
    assertEquals(box.material, own)
    assertEquals(late.material, late.userData.textured)
})

Deno.test("the old Splats / Meshes / Both setting seeds the toggles; a toggle once set wins; robot and people default on", () => {
    const parts = (splats: boolean, meshes: boolean) => ({ robot: true, meshes, splats, people: true })
    assertEquals(modelPartsOf({}), parts(true, true))
    assertEquals(modelPartsOf({ splatView: "splats" }), parts(true, false))
    assertEquals(modelPartsOf({ splatView: "meshes" }), parts(false, true))
    assertEquals(modelPartsOf({ splatView: "both" }), parts(true, true))
    assertEquals(modelPartsOf({ splatView: "splats", meshes: true }), parts(true, true))
    assertEquals(modelPartsOf({ splats: false, meshes: false, splatView: "both" }), parts(false, false))
    assertEquals(modelPartsOf({ robot: false, people: false }), { robot: false, meshes: true, splats: true, people: false })
})

Deno.test("a topic a layer absorbs (the robot model's /people) is on just while that layer is and its part is", () => {
    localStorage.clear()
    const make = () => ({ root: new THREE.Object3D(), dispose: () => {} })
    registerLayer<{ people: boolean }>({ id: "test-owner", label: "owner", types: ["test.Owner"], defaults: { people: true }, create: make, absorbs: { names: ["/people"], on: (settings) => settings.people } })
    registerLayer({ id: "test-poses", label: "poses", types: ["test.Poses"], defaults: {}, create: make })
    const status = new Store<{ topics: Topic[] }>({ topics: [] })
    const viewer = { scene: { add: () => {}, remove: () => {} }, onFrame: () => () => {}, requestRender: () => {} }
    const manager = new LayerManager(viewer as never, {} as never, {} as never, { status } as unknown as Connection, {} as never, {} as never)
    const owner: Topic = { key: "owner", name: "/urdf_info", type: "test.Owner" }
    const people: Topic = { key: "people", name: "/people", type: "test.Poses" }
    const enabled = () => manager.entries.get().list.map((entry) => entry.enabled)
    status.set({ topics: [owner] })
    const ownerEntry = manager.entries.get().list[0]
    ownerEntry.settings.update({ people: false })
    manager.setEnabled(owner.key, true)
    // showing up after the owner's people were switched off, it starts off
    status.set({ topics: [owner, people] })
    assertEquals(enabled(), [false, true])
    ownerEntry.settings.update({ people: true })
    manager.setEnabled(owner.key, true)
    assertEquals(enabled(), [true, true])
    manager.setEnabled(owner.key, false)
    assertEquals(enabled(), [false, false])
})
