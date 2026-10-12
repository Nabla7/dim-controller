// Location labels (server/src/labels.rs): text pinned to a point in the fixed frame, made from the 3D view's right-click
// menu. The backend keeps them for the session, tells every page (the `labels` event, via AgentLink) and writes them
// into a running recording. Drawn here as a marker plus its text, placed through TF like the annotations.
import * as THREE from "three"
import { LabelPool } from "./render/labels.ts"
import { Store } from "./store.ts"
import type { ViewerApp } from "./app.ts"

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

const COLOR = "#ffd166"
const url = (path: string) => new URL(path, location.href).href

export class LocationLabels {
    readonly list = new Store<LocationLabel[]>([])
    readonly group = new THREE.Group()
    #text = new LabelPool("scene-label location-label")
    #markers = new Map<string, THREE.Mesh>()
    #geometry = new THREE.SphereGeometry(0.07, 16, 12)
    #material = new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false, transparent: true })

    constructor(readonly app: ViewerApp) {
        this.group.userData.noPick = true
        this.group.add(this.#text.group)
        app.viewer.scene.add(this.group)
        app.viewer.onFrame(() => this.#place())
        fetch(url("api/labels"))
            .then((response) => response.json())
            .then((body) => this.apply(body.labels ?? []))
            .catch(() => {})
    }

    /** The backend's list (on load and on every change). */
    apply(labels: LocationLabel[]) {
        this.list.set(labels)
        const wanted = new Set(labels.map((label) => label.id))
        for (const [id, marker] of this.#markers) {
            if (!wanted.has(id)) {
                marker.removeFromParent()
                this.#markers.delete(id)
            }
        }
        for (const label of labels) {
            if (!this.#markers.has(label.id)) {
                const marker = new THREE.Mesh(this.#geometry, this.#material)
                marker.renderOrder = 11
                this.group.add(marker)
                this.#markers.set(label.id, marker)
            }
        }
        this.app.viewer.requestRender()
    }

    /** Where a label is in the current fixed frame, or null without a TF path. */
    position(label: LocationLabel): THREE.Vector3 | null {
        const fixed = this.app.viewer.fixedFrame
        const transform = label.frame_id === fixed ? new THREE.Matrix4() : this.app.tf.lookup(label.frame_id, fixed)
        return transform ? new THREE.Vector3(...label.position).applyMatrix4(transform) : null
    }

    #place() {
        this.#text.begin()
        for (const label of this.list.get()) {
            const marker = this.#markers.get(label.id)
            const position = this.position(label)
            if (!marker) {
                continue
            }
            marker.visible = !!position
            if (!position) {
                continue
            }
            if (!marker.position.equals(position)) {
                marker.position.copy(position)
                this.app.viewer.requestRender()
            }
            this.#text.place(label.label, position.clone().add(new THREE.Vector3(0, 0, 0.3)), COLOR)
        }
        this.#text.end()
    }

    /** Adds a label at `point` (fixed frame); resolves to whether a recording took it. */
    async create(text: string, point: THREE.Vector3): Promise<{ label: LocationLabel; recorded: boolean }> {
        const response = await fetch(url("api/labels"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ label: text, frame_id: this.app.viewer.fixedFrame, position: point.toArray(), orientation: [0, 0, 0, 1] }),
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

    /** The label drawn nearest to a screen point (CSS px in the canvas), within `radius` px. */
    near(x: number, y: number, radius = 24): LocationLabel | null {
        const canvas = this.app.viewer.canvas.getBoundingClientRect()
        let best: { label: LocationLabel; distance: number } | null = null
        for (const label of this.list.get()) {
            const position = this.position(label)
            if (!position) {
                continue
            }
            const projected = position.clone().project(this.app.viewer.camera)
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
