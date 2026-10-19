// Splat files in a URDF and the hashed mesh names: ?hash= split off for the cache key, splat files told from meshes
// (a .ply by its header); the robot (links in no group) and each <group> shown by its own toggle, a link fixed to a
// grouped one in its group; mesh files and splat files each shown by theirs across them, meshes untextured; old
// settings carried over.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { DOMParser } from "https://esm.sh/@xmldom/xmldom@0.8.10"
import * as THREE from "three"
import { parseUrdf } from "../src/core/urdf.ts"
import { splitHash } from "../src/core/meshCache.ts"
import { type SplatAsset, splatFileType } from "../src/core/splats.ts"
import { groupNames, Kinematics, linkGroups, modelPartsOf, RobotModel } from "../src/core/robotDescription.ts"

;(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser

const SPLATS = "package://dim_go2_sim/scenes/home/splats.spz?hash=aa11"
const COLLISION = "package://dim_go2_sim/scenes/home/collision.stl?hash=bb22"
const BODY = "package://dim_go2_sim/go2/base.stl?hash=cc33"
// as dim-go2-sim publishes a scene: splats and collision meshes on their own links in <group>scene</group>, fixed to
// world (a tile fixed to the meshes, in no group of its own, is the scene's too); people in <group>people</group>; the
// robot floats, in no group. Names don't matter: "person_0" here is the robot's, "visitor" a person.
const SCENE = `<robot name="home">
  <link name="world"/>
  <link name="scene_splats"><group>scene</group><visual><origin xyz="1 2 0"/><geometry><mesh filename="${SPLATS}" scale="2 2 2"/></geometry></visual></link>
  <link name="collision"><group> scene </group><visual><geometry><mesh filename="${COLLISION}"/></geometry></visual></link>
  <link name="tile"><visual><geometry><box size="1 1 0.1"/></geometry></visual></link>
  <link name="base_link"><visual><geometry><mesh filename="${BODY}"/></geometry></visual><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
  <link name="person_0"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
  <joint name="splats" type="fixed"><parent link="world"/><child link="scene_splats"/></joint>
  <joint name="mesh" type="fixed"><parent link="world"/><child link="collision"/></joint>
  <joint name="tile" type="fixed"><parent link="collision"/><child link="tile"/></joint>
  <joint name="base" type="floating"><parent link="world"/><child link="base_link"/></joint>
  <joint name="arm" type="fixed"><parent link="base_link"/><child link="person_0"/></joint>
  <link name="visitor"><group>people</group><visual><geometry><box size="0.3 0.3 1.7"/></geometry></visual></link>
  <joint name="visitor_joint" type="floating"><parent link="world"/><child link="visitor"/></joint>
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

Deno.test("a link's <group> is read; a link fixed below a grouped one is in its group; the rest in none", () => {
    const description = parseUrdf(SCENE)
    assertEquals(groupNames(description), ["scene", "people"])
    assertEquals(Object.fromEntries(linkGroups(description)), { scene_splats: "scene", collision: "scene", tile: "scene", visitor: "people" })
})

Deno.test("the robot and each group show by their own toggle, mesh and splat files by theirs across them", () => {
    const cuts: (number | null)[] = []
    const fake: SplatAsset = { count: 3, mesh: () => Object.assign(new THREE.Object3D(), { opacity: 1, setCutAbove: (height: number | null) => cuts.push(height) }), dispose: () => {} }
    const geometries = new Map([[COLLISION, new THREE.BoxGeometry()], [BODY, new THREE.BoxGeometry()]])
    const model = new RobotModel(new Kinematics(parseUrdf(SCENE)), geometries, { opacity: 0.5 }, new Map([[SPLATS, fake]]))
    const splat = model.links.get("scene_splats")!.children[0] as THREE.Object3D & { opacity: number }
    const collision = model.links.get("collision")!.children[0]
    const tile = model.links.get("tile")!.children[0]
    const [body, box] = [true, false].map((meshFile) => model.links.get("base_link")!.children.find((object) => !!object.userData.meshFile === meshFile)!)
    const arm = model.links.get("person_0")!.children[0]
    const visitor = model.links.get("visitor")!.children[0]
    assert(model.hasSplats)
    // the URDF origin and scale, and the layer's opacity
    assertEquals(new THREE.Vector3().setFromMatrixPosition(splat.matrix).toArray(), [1, 2, 0])
    assertEquals(new THREE.Vector3().setFromMatrixScale(splat.matrix).toArray(), [2, 2, 2])
    assertEquals(splat.opacity, 0.5)
    const shown = () => ({ body: body.visible, box: box.visible, arm: arm.visible, collision: collision.visible, tile: tile.visible, splat: splat.visible, visitor: visitor.visible })
    const all = { robot: true, groups: {}, meshes: true, splats: true }
    const every = { body: true, box: true, arm: true, collision: true, tile: true, splat: true, visitor: true }
    assertEquals(shown(), every)
    model.setParts({ ...all, robot: false })
    assertEquals(shown(), { ...every, body: false, box: false, arm: false })
    model.setParts({ ...all, groups: { scene: false } })
    assertEquals(shown(), { ...every, collision: false, tile: false, splat: false })
    model.setParts({ ...all, groups: { people: false } })
    assertEquals(shown(), { ...every, visitor: false })
    // meshes and splats are files, whoever's: a primitive is neither
    model.setParts({ ...all, meshes: false })
    assertEquals(shown(), { ...every, body: false, collision: false })
    model.setParts({ ...all, splats: false })
    assertEquals(shown(), { ...every, splat: false })
    // textures off doesn't touch what shows
    model.setTextures(false)
    model.setParts({ ...all, robot: false, splats: false })
    assertEquals(shown(), { ...every, body: false, box: false, arm: false, splat: false })
    model.setTextures(true)
    model.setParts(all)
    model.setDisplay("collision")
    assertEquals(Object.values(shown()).some(Boolean), false)
    // the ceiling cut reaches every splat object
    model.setSplatCutAbove(2.5)
    assertEquals(cuts, [null, 2.5])
})

Deno.test("textures off draws meshes flat grey at their opacity, on puts their own material back, meshes arriving later too", () => {
    const geometries = new Map<string, THREE.BufferGeometry>()
    const description = parseUrdf(SCENE)
    description.links.find((link) => link.name === "base_link")!.visuals[1].color = [1, 0, 0, 1]
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
    const late = model.links.get("collision")!.children[0] as THREE.Mesh
    assert((late.material as THREE.MeshStandardMaterial).flatShading)
    model.setTextures(true)
    assertEquals(box.material, own)
    assertEquals(late.material, late.userData.textured)
})

Deno.test("settings from before groups: People becomes the people group, the scene-only Meshes is dropped, the old Splats / Meshes / Both seeds Splats", () => {
    const parts = (splats: boolean, groups: Record<string, boolean> = {}) => ({ robot: true, groups, meshes: true, splats })
    assertEquals(modelPartsOf({}), parts(true))
    assertEquals(modelPartsOf({ splatView: "splats", meshes: false }), parts(true))
    assertEquals(modelPartsOf({ splatView: "meshes" }), parts(false))
    assertEquals(modelPartsOf({ splats: false, splatView: "both" }), parts(false))
    assertEquals(modelPartsOf({ robot: false, people: false }), { ...parts(true, { people: false }), robot: false })
    assertEquals(modelPartsOf({ people: true }), parts(true, { people: true }))
    // once groups are saved, they and Meshes are read as they are, and People isn't
    assertEquals(modelPartsOf({ groups: { scene: false }, meshes: false, people: false }), { robot: true, groups: { scene: false }, meshes: false, splats: true })
})
