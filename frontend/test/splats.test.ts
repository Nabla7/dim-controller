// Splat files in a URDF and the hashed mesh names: ?hash= split off for the cache key, splat files told from meshes
// (a .ply by its header), and a scene link's splats and meshes shown by the splat view.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { DOMParser } from "https://esm.sh/@xmldom/xmldom@0.8.10"
import * as THREE from "three"
import { parseUrdf } from "../src/core/urdf.ts"
import { splitHash } from "../src/core/meshCache.ts"
import { type SplatAsset, splatFileType } from "../src/core/splats.ts"
import { Kinematics, RobotModel } from "../src/core/robotDescription.ts"

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

Deno.test("a scene shows its splats or its meshes by the splat view; the robot always shows", () => {
    const cuts: (number | null)[] = []
    const fake: SplatAsset = { count: 3, mesh: () => Object.assign(new THREE.Object3D(), { opacity: 1, setCutAbove: (height: number | null) => cuts.push(height) }), dispose: () => {} }
    const geometries = new Map([[COLLISION, new THREE.BoxGeometry()]])
    const model = new RobotModel(new Kinematics(parseUrdf(SCENE)), geometries, { opacity: 0.5 }, new Map([[SPLATS, fake]]))
    const splat = model.links.get("scene_splats")!.children[0] as THREE.Object3D & { opacity: number }
    const mesh = model.links.get("scene_mesh")!.children[0]
    const lamp = model.links.get("base_link")!.children[0]
    assert(model.hasSplats)
    // the URDF origin and scale, and the layer's opacity
    assertEquals(new THREE.Vector3().setFromMatrixPosition(splat.matrix).toArray(), [1, 2, 0])
    assertEquals(new THREE.Vector3().setFromMatrixScale(splat.matrix).toArray(), [2, 2, 2])
    assertEquals(splat.opacity, 0.5)
    const shown = () => [splat.visible, mesh.visible, lamp.visible]
    assertEquals(shown(), [true, false, true])
    model.setSplatView("meshes")
    assertEquals(shown(), [false, true, true])
    model.setSplatView("both")
    assertEquals(shown(), [true, true, true])
    model.setDisplay("collision")
    assertEquals(shown(), [false, false, false])
    // the ceiling cut reaches every splat object
    model.setSplatCutAbove(2.5)
    assertEquals(cuts, [null, 2.5])
})
