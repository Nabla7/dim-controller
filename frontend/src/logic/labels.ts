// Location labels (server/src/labels.rs): text pinned to a point in the fixed frame, made from the 3D view's right-click
// menu. The backend keeps them for the session, tells every page (the `labels` event, via AgentLink) and writes them
// into a running recording. The 3D view draws them (dimos-react's labeled-points layer, ui/ScenePanel.tsx); this keeps
// the list and finds the one under the cursor.
import * as THREE from "three"
import { Store } from "./settings.ts"
import type { ControllerApp } from "./controller.ts"

export interface LocationLabel {
    id: string
    label: string
    frame_id: string
    position: [number, number, number]
    /** quaternion x, y, z, w */
    orientation: [number, number, number, number]
    /** ns since the epoch */
    created: number
}

const url = (path: string) => new URL(path, location.href).href

export class LocationLabels {
    readonly list = new Store<{ labels: LocationLabel[] }>({ labels: [] })

    constructor(readonly app: ControllerApp) {
        fetch(url("api/labels"))
            .then((response) => response.json())
            .then((body) => this.apply(body.labels ?? []))
            .catch(() => {})
    }

    /** The backend's list (on load and on every change). */
    apply(labels: LocationLabel[]) {
        this.list.set({ labels })
    }

    /** Where a label is in the current fixed frame, or null without a TF path. */
    position(label: LocationLabel): THREE.Vector3 | null {
        const fixed = this.app.fixedFrame
        const transform = label.frame_id === fixed ? new THREE.Matrix4() : this.app.tf.lookup(label.frame_id, fixed)
        return transform ? new THREE.Vector3(...label.position).applyMatrix4(transform) : null
    }

    /** Adds a label at `point` (fixed frame); resolves to whether a recording took it. */
    async create(text: string, point: { x: number; y: number; z: number }): Promise<{ label: LocationLabel; recorded: boolean }> {
        const response = await fetch(url("api/labels"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ label: text, frame_id: this.app.fixedFrame, position: [point.x, point.y, point.z], orientation: [0, 0, 0, 1] }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
            throw new Error(body.error ?? `${response.status}`)
        }
        return body
    }

    async remove(id: string) {
        const response = await fetch(url(`api/labels/${encodeURIComponent(id)}`), { method: "DELETE" })
        if (!response.ok && response.status !== 404) {
            throw new Error(`${response.status}`)
        }
    }

    /** The label drawn nearest to a screen point (client px), within `radius` px. */
    near(x: number, y: number, radius = 24): LocationLabel | null {
        const viewer = this.app.scene?.viewer
        if (!viewer) {
            return null
        }
        const canvas = viewer.renderer.domElement.getBoundingClientRect()
        let best: { label: LocationLabel; distance: number } | null = null
        for (const label of this.list.get().labels) {
            const position = this.position(label)
            if (!position) {
                continue
            }
            const projected = position.clone().project(viewer.camera)
            if (projected.z > 1) {
                continue
            }
            const screenX = canvas.left + ((projected.x + 1) / 2) * canvas.width
            const screenY = canvas.top + ((1 - projected.y) / 2) * canvas.height
            const distance = Math.hypot(screenX - x, screenY - y)
            if (distance <= radius && (!best || distance < best.distance)) {
                best = { label, distance }
            }
        }
        return best?.label ?? null
    }
}
