// The URDF API (dimos's UrdfManager): the XML read into a RobotDescription (origins, geometry, materials, mimic, the
// root), MeshFile replies decoded, STL meshes (binary and ASCII) loaded, joint positions read back from link poses, and
// a model filling in as its meshes arrive.
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "jsr:@std/assert@1"
import { DOMParser } from "https://esm.sh/@xmldom/xmldom@0.8.10"
import * as THREE from "three"
import { decodeMeshFile, meshGeometry, meshUris, parseUrdf } from "dimos-react/three"
import { Kinematics, RobotModel } from "../src/core/robotDescription.ts"

// deno has no DOMParser; the browser's is what the page uses
;(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser

const URDF = `<?xml version="1.0"?>
<robot name="two_link">
  <material name="grey"><color rgba="0.5 0.5 0.5 1"/></material>
  <link name="base_link">
    <visual><origin xyz="0 0 0.1" rpy="0 0 1.5707963"/><geometry><mesh filename="package://two/meshes/base.STL" scale="0.001 0.001 0.001"/></geometry><material name="grey"/></visual>
    <collision><geometry><box size="0.2 0.2 0.1"/></geometry></collision>
  </link>
  <link name="arm">
    <visual><geometry><cylinder radius="0.02" length="0.3"/></geometry><material name="red"><color rgba="1 0 0 0.5"/></material></visual>
    <visual><geometry><mesh filename="package://two/meshes/base.STL"/></geometry></visual>
  </link>
  <link name="finger"/>
  <link name="finger_mirror"/>
  <joint name="shoulder" type="revolute">
    <parent link="base_link"/><child link="arm"/>
    <origin xyz="0 0 0.2" rpy="1.5707963 0 0"/><axis xyz="0 0 1"/>
    <limit lower="-1" upper="1" effort="1" velocity="1"/>
  </joint>
  <joint name="slide" type="prismatic">
    <parent link="arm"/><child link="finger"/><axis xyz="0 1 0"/><limit lower="0" upper="0.04" effort="1" velocity="1"/>
  </joint>
  <joint name="slide_mirror" type="prismatic">
    <parent link="arm"/><child link="finger_mirror"/><mimic joint="slide" multiplier="-1"/>
  </joint>
</robot>`

/** a binary STL of one triangle */
function binaryStl(): Uint8Array {
    const bytes = new Uint8Array(84 + 50)
    const view = new DataView(bytes.buffer)
    view.setUint32(80, 1, true)
    const vertices = [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0]
    vertices.forEach((value, index) => view.setFloat32(84 + index * 4, value, true))
    return bytes
}

const ASCII_STL = `solid t
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid t`

/** files.MeshFile as dimos encodes it */
function meshFile(uri: string, data: Uint8Array): Uint8Array {
    const name = new TextEncoder().encode(uri)
    const bytes = new Uint8Array(12 + name.length + data.length)
    const view = new DataView(bytes.buffer)
    view.setFloat64(0, 1234.5, true)
    view.setUint32(8, name.length, true)
    bytes.set(name, 12)
    bytes.set(data, 12 + name.length)
    return bytes
}

Deno.test("a URDF reads into a description at its root link", () => {
    const description = parseUrdf(URDF)
    assertEquals(description.name, "two_link")
    assertEquals(description.base_link, "base_link")
    assertEquals(description.base_frame, "base_link")
    assertEquals(description.joint_names, ["shoulder", "slide"])
    const base = description.links.find((link) => link.name === "base_link")!
    assertEquals(base.visuals[0].mesh, "package://two/meshes/base.STL")
    assertEquals(base.visuals[0].scale, [0.001, 0.001, 0.001])
    assertEquals(base.visuals[0].color, [0.5, 0.5, 0.5, 1])
    assertAlmostEquals(base.visuals[0].origin.quat[2], Math.SQRT1_2, 1e-6)
    assertEquals(base.collisions[0].size, [0.2, 0.2, 0.1])
    const arm = description.links.find((link) => link.name === "arm")!
    assertEquals(arm.visuals[0].type, "cylinder")
    assertEquals(arm.visuals[0].color, [1, 0, 0, 0.5])
    const shoulder = description.joints.find((joint) => joint.name === "shoulder")!
    assertEquals(shoulder.limit, [-1, 1])
    assertAlmostEquals(shoulder.origin.quat[0], Math.SQRT1_2, 1e-6)
    assertEquals(description.joints.find((joint) => joint.name === "slide_mirror")!.mimic, { joint: "slide", multiplier: -1, offset: 0 })
    assertEquals(meshUris(description), ["package://two/meshes/base.STL"])
    assertThrows(() => parseUrdf("<notarobot/>"))
})

Deno.test("a MeshFile reply decodes to its uri and the file's bytes", () => {
    const decoded = decodeMeshFile(meshFile("package://two/meshes/base.STL", binaryStl()))
    assertEquals(decoded.ts, 1234.5)
    assertEquals(decoded.uri, "package://two/meshes/base.STL")
    assertEquals(decoded.data.length, 134)
    assertThrows(() => decodeMeshFile(new Uint8Array(4)))
})

Deno.test("STL meshes load, binary and ASCII", () => {
    for (const data of [binaryStl(), new TextEncoder().encode(ASCII_STL)]) {
        const geometry = meshGeometry("package://x/a.STL", data)
        assertEquals(geometry.attributes.position.count, 3)
        assert(geometry.attributes.normal)
    }
    assertThrows(() => meshGeometry("package://x/a.3ds", binaryStl()))
})

Deno.test("joint positions read back from link poses (TF)", () => {
    const kinematics = new Kinematics(parseUrdf(URDF))
    const poses = kinematics.linkPoses({ shoulder: 0.7, slide: 0.03 })
    const relative = (child: string, parent: string) => poses.get(parent)!.clone().invert().multiply(poses.get(child)!)
    const positions = kinematics.positionsFrom(relative)
    assertAlmostEquals(positions.shoulder, 0.7, 1e-6)
    assertAlmostEquals(positions.slide, 0.03, 1e-6)
})

Deno.test("a model fills in its meshes as they arrive", () => {
    const description = parseUrdf(URDF)
    const geometries = new Map<string, THREE.BufferGeometry>()
    const model = new RobotModel(new Kinematics(description), geometries)
    const meshes = () => {
        let count = 0
        model.root.traverse((object) => (object as THREE.Mesh).isMesh && count++)
        return count
    }
    // the cylinder and the collision box, no meshes yet
    assertEquals(meshes(), 2)
    assertEquals(model.fill(geometries), false)
    geometries.set("package://two/meshes/base.STL", meshGeometry("package://two/meshes/base.STL", binaryStl()))
    assertEquals(model.fill(geometries), true)
    assertEquals(meshes(), 4)
    const scaled = model.links.get("base_link")!.children.find((object) => (object as THREE.Mesh).geometry.userData.shared) as THREE.Mesh
    assertAlmostEquals(new THREE.Vector3().setFromMatrixScale(scaled.matrix).x, 0.001, 1e-9)
    // collision geometry stays hidden on the visual display
    assertEquals(model.links.get("base_link")!.children.filter((object) => object.visible).length, 1)
})
