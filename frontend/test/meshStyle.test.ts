// Settings → Meshes: wireframe draws each mesh's edges in one color with its faces hidden, and solid puts it back.
import { assert, assertEquals } from "jsr:@std/assert@1"
import * as THREE from "three"
import { applyMeshStyle } from "../src/core/render/meshStyle.ts"

const edgesOf = (mesh: THREE.Mesh) => mesh.userData.wireframe as THREE.LineSegments | undefined

function world() {
    const shared = new THREE.MeshStandardMaterial()
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared)
    const twin = new THREE.Mesh(box.geometry, shared)
    const hidden = new THREE.MeshStandardMaterial({ visible: false })
    const off = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hidden)
    const grass = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 4)
    const root = new THREE.Group().add(box, twin, off, grass)
    return { root, box, twin, off, grass, shared, hidden }
}

Deno.test("wireframe: a box's 12 edges in the color, its faces hidden; instanced meshes left alone", () => {
    const { root, box, twin, grass, shared } = world()
    applyMeshStyle(root, "wireframe", "#ffb84d")
    const edges = edgesOf(box)!
    assertEquals(edges.parent, box, "moves, hides and cuts with its mesh")
    assertEquals(edges.geometry.getAttribute("position").count, 24, "12 edges, not the triangles' diagonals")
    assertEquals(edges.geometry, edgesOf(twin)!.geometry, "one edges geometry per geometry")
    assertEquals(`#${(edges.material as THREE.LineBasicMaterial).color.getHexString()}`, "#ffb84d")
    assertEquals(shared.visible, false)
    assertEquals(edgesOf(grass as unknown as THREE.Mesh), undefined)
    assert((grass.material as THREE.Material).visible)
})

Deno.test("applying it again or in another color reuses the lines", () => {
    const { root, box } = world()
    applyMeshStyle(root, "wireframe", "#ffb84d")
    const edges = edgesOf(box)
    applyMeshStyle(root, "wireframe", "#00ff00")
    assertEquals(edgesOf(box), edges)
    assertEquals(box.children.length, 1)
    assertEquals(`#${(edges!.material as THREE.LineBasicMaterial).color.getHexString()}`, "#00ff00")
})

Deno.test("solid puts the faces back as they were and hides the lines", () => {
    const { root, box, shared, hidden } = world()
    applyMeshStyle(root, "wireframe", "#ffb84d")
    applyMeshStyle(root, "solid", "#ffb84d")
    assertEquals(shared.visible, true)
    assertEquals(hidden.visible, false, "a material that was hidden stays hidden")
    assertEquals(edgesOf(box)!.visible, false)
    assertEquals(shared.userData.solidVisible, undefined)
})

Deno.test("solid on a never-wireframed world changes nothing", () => {
    const { root, box, shared } = world()
    applyMeshStyle(root, "solid", "#ffb84d")
    assertEquals([box.children.length, shared.visible], [0, true])
})
