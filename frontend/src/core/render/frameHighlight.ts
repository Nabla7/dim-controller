// One TF frame picked out in the 3D view (the TF panel's hovered row): big axes drawn over everything, with a halo
// behind them and the frame's name, following the frame as it moves. Works whether or not a TF layer is on.
import * as THREE from "three"
import { FatLines } from "./lines.ts"
import { LabelPool } from "./labels.ts"
import type { Viewer } from "./viewer.ts"
import type { TfTree } from "../tf.ts"
import { Store } from "../store.ts"

/** axes length (m) and line widths (CSS px) of the highlight */
const AXES_METERS = 1.2
const AXES_PX = 7
const HALO_PX = 22

export class FrameHighlight {
    /** the frame shown, and whether it could be placed (null = none) */
    readonly state = new Store<{ frame: string | null; placed: boolean }>({ frame: null, placed: false })
    #axes: FatLines
    #halo: FatLines
    #label = new LabelPool("scene-label frame-highlight")
    #group = new THREE.Group()

    constructor(readonly viewer: Viewer, readonly tf: TfTree) {
        // the glow: the same axes, wide and faint, behind them
        this.#halo = new FatLines(viewer.resolution, { width: HALO_PX, vertexColors: true, opacity: 0.3, capacity: 3 })
        this.#axes = new FatLines(viewer.resolution, { width: AXES_PX, vertexColors: true, capacity: 3 })
        for (const lines of [this.#halo, this.#axes]) {
            // drawn last and through everything, so it's never hidden inside a point cloud
            lines.material.depthTest = false
            lines.material.depthWrite = false
            lines.object.renderOrder = 1000
        }
        this.#halo.object.renderOrder = 999
        this.#group.add(this.#halo.object, this.#axes.object, this.#label.group)
        this.#group.userData.noPick = true
        viewer.scene.add(this.#group)
        viewer.onFrame((frame) => this.#draw(frame.fixedFrame))
    }

    set(frame: string | null) {
        if (frame !== this.state.get().frame) {
            this.state.set({ frame, placed: false })
            this.viewer.requestRender()
        }
    }

    #draw(fixedFrame: string) {
        const { frame, placed } = this.state.get()
        const matrix = frame ? this.tf.lookup(frame, fixedFrame) : null
        this.#axes.clear()
        this.#halo.clear()
        this.#label.begin()
        if (frame && matrix) {
            const origin = new THREE.Vector3().setFromMatrixPosition(matrix)
            const tip = new THREE.Vector3()
            const colors = [new THREE.Color(0xff4d4d), new THREE.Color(0x3ddc6a), new THREE.Color(0x4d8dff)]
            const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
            axes.forEach((axis, index) => {
                tip.copy(axis).multiplyScalar(AXES_METERS).applyMatrix4(matrix)
                this.#axes.push(origin.x, origin.y, origin.z, tip.x, tip.y, tip.z, colors[index])
                this.#halo.push(origin.x, origin.y, origin.z, tip.x, tip.y, tip.z, colors[index])
            })
            this.#label.place(frame, origin)
        }
        this.#axes.commit()
        this.#halo.commit()
        this.#label.end()
        if (frame && placed !== !!matrix) {
            this.state.set({ frame, placed: !!matrix })
        }
        // moving frames move the highlight: keep drawing while one is shown
        if (frame) {
            this.viewer.requestRender()
        }
    }
}
