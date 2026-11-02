// How meshes draw (Settings → the 3D view's cog → Meshes): solid, or wireframe (each mesh's edges as lines in one color,
// its faces hidden), for the simulated world and the robot model. Saved with the other rendering choices (rendering.ts).
import * as THREE from "three"

export type MeshStyle = "solid" | "wireframe"
export const MESH_STYLES: [MeshStyle, string][] = [["solid", "Solid"], ["wireframe", "Wireframe"]]

/** one edges geometry per mesh geometry (a world's repeated boxes share theirs) */
const edgesOf = new WeakMap<THREE.BufferGeometry, THREE.EdgesGeometry>()
const lineMaterials = new Map<string, THREE.LineBasicMaterial>()

const lineMaterial = (color: string) => {
    let material = lineMaterials.get(color)
    if (!material) {
        material = new THREE.LineBasicMaterial({ color })
        lineMaterials.set(color, material)
    }
    return material
}

const materialsOf = (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material])

/** Draws every mesh under `root` in `style`; wireframe edges are a child of their mesh, so they move, hide and cut with it.
 * Instanced meshes (grass, marker lists) stay as they are. */
export function applyMeshStyle(root: THREE.Object3D, style: MeshStyle, color: string) {
    const meshes: THREE.Mesh[] = []
    root.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) {
            meshes.push(mesh)
        }
    })
    for (const mesh of meshes) {
        let edges = mesh.userData.wireframe as THREE.LineSegments | undefined
        if (style === "wireframe" && !edges) {
            let geometry = edgesOf.get(mesh.geometry)
            if (!geometry) {
                geometry = new THREE.EdgesGeometry(mesh.geometry)
                edgesOf.set(mesh.geometry, geometry)
            }
            edges = new THREE.LineSegments(geometry, lineMaterial(color))
            // picking still finds the (hidden) surface, not the lines
            edges.raycast = () => {}
            mesh.add(edges)
            mesh.userData.wireframe = edges
        }
        if (edges) {
            edges.material = lineMaterial(color)
            edges.visible = style === "wireframe"
        }
        for (const material of materialsOf(mesh)) {
            // the faces' own visibility comes back as it was
            if (style === "wireframe" && material.userData.solidVisible === undefined) {
                material.userData.solidVisible = material.visible
                material.visible = false
            } else if (style === "solid" && material.userData.solidVisible !== undefined) {
                material.visible = material.userData.solidVisible
                delete material.userData.solidVisible
            }
        }
    }
}
