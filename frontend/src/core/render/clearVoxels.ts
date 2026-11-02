// A cloud's "clear" color: every point a see-through box, as the MLS planner's map pages draw voxels (dimos
// mls_planner/utils/map_pages.py boxes()): 0.96 of the voxel size, Lambert-lit in the theme's voxel grey at 0.28 opacity,
// no depth writes, one InstancedMesh. The cloud's own points stay (hidden), so leaving clear brings its look back as it was.
import * as THREE from "three"

/** map_pages.py's --voxel token, light and dark */
export const CLEAR_VOXEL_COLOR = { light: "#8fa3b5", dark: "#5f7385" }
export const CLEAR_VOXEL_SCALE = 0.96
export const CLEAR_VOXEL_OPACITY = 0.28

/** Desktop's light / dark mode, as dimos-react's theme marks it (html[data-dr-dark]) */
export const darkTheme = () => typeof document === "undefined" || document.documentElement.hasAttribute("data-dr-dark")

export const clearVoxelColor = (dark: boolean) => (dark ? CLEAR_VOXEL_COLOR.dark : CLEAR_VOXEL_COLOR.light)

export class ClearVoxels {
    readonly material = new THREE.MeshLambertMaterial({ transparent: true, opacity: CLEAR_VOXEL_OPACITY, depthWrite: false })
    #box = new THREE.BoxGeometry(1, 1, 1)
    mesh = new THREE.InstancedMesh(this.#box, this.material, 1)

    constructor(readonly parent: THREE.Object3D) {
        this.mesh.count = 0
        this.mesh.frustumCulled = false
        this.mesh.raycast = () => {}
        this.theme()
        parent.add(this.mesh)
    }

    /** Follows the theme's light / dark voxel grey. */
    theme(dark = darkTheme()) {
        this.material.color.set(clearVoxelColor(dark))
    }

    /** One box per kept point (`xyz`, the first `count`), `size` the voxel's edge; `keep(index)` leaves a point out when false. */
    place(xyz: ArrayLike<number>, count: number, size: number, keep: (index: number) => boolean = () => true) {
        if (count > this.mesh.instanceMatrix.count) {
            this.parent.remove(this.mesh)
            this.mesh.dispose()
            this.mesh = new THREE.InstancedMesh(this.#box, this.material, 2 ** Math.ceil(Math.log2(count)))
            this.mesh.frustumCulled = false
            this.mesh.raycast = () => {}
            this.parent.add(this.mesh)
        }
        const matrix = new THREE.Matrix4()
        const edge = size * CLEAR_VOXEL_SCALE
        let shown = 0
        for (let index = 0; index < count; index++) {
            if (keep(index)) {
                matrix.makeScale(edge, edge, edge).setPosition(xyz[index * 3], xyz[index * 3 + 1], xyz[index * 3 + 2])
                this.mesh.setMatrixAt(shown++, matrix)
            }
        }
        this.mesh.count = shown
        this.mesh.instanceMatrix.needsUpdate = true
    }

    /** Draws no boxes (a mode other than clear). */
    empty() {
        this.mesh.count = 0
    }

    dispose() {
        this.parent.remove(this.mesh)
        this.mesh.dispose()
        this.#box.dispose()
        this.material.dispose()
    }
}
