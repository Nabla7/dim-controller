// Location labels (server/src/labels.rs): text pinned to a point in the fixed frame, made from the 3D view's right-click
// menu. The backend keeps them for the session, tells every page (the `labels` event, via AgentLink) and writes them
// into a running recording. Drawn here as a marker plus its text, placed through TF like the annotations. With dimos's
// NamedLocations module running (core/namedLocations.ts) the labels are its locations instead, and edits go to it.
import * as THREE from "three"
import { LabelPool } from "dimos-react/three"
import { Store } from "./store.ts"
import type { ViewerApp } from "./app.ts"
import { MAP_FRAME, type NamedLocations, renamedLocation, withLocation, withoutLocation } from "./namedLocations.ts"

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
    /** what's drawn: the module's locations once it's there, else the backend's labels */
    readonly list = new Store<LocationLabel[]>([])
    #rest: LocationLabel[] = []
    readonly group = new THREE.Group()
    #text = new LabelPool("dr-scene-label dr-note")
    #markers = new Map<string, THREE.Mesh>()
    #geometry = new THREE.SphereGeometry(0.07, 16, 12)
    #material = new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false, transparent: true })

    constructor(readonly app: ViewerApp, readonly named: NamedLocations) {
        named.state.subscribe(() => this.#show())
        this.group.userData.noPick = true
        this.group.add(this.#text.group)
        app.viewer.scene.add(this.group)
        app.viewer.onFrame(() => this.#place())
        fetch(url("api/labels"))
            .then((response) => response.json())
            .then((body) => this.apply(body.labels ?? []))
            .catch(() => {})
    }

    /** whether edits go to the NamedLocations module (it has sent its locations) */
    get toModule(): boolean {
        return this.named.state.get().locations !== null
    }

    /** The backend's list (on load and on every change). */
    apply(labels: LocationLabel[]) {
        this.#rest = labels
        this.#show()
    }

    #show() {
        const labels = this.named.state.get().locations ?? this.#rest
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

    /** `point` in `frame`, re-expressed in map (the frame the module's list is in) through TF. */
    #toMap(point: THREE.Vector3, frame: string): [number, number, number] {
        if (frame === MAP_FRAME) {
            return point.toArray()
        }
        const transform = this.app.tf.lookup(frame, MAP_FRAME)
        if (!transform) {
            throw new Error(`no transform from ${frame} to ${MAP_FRAME} yet`)
        }
        return point.clone().applyMatrix4(transform).toArray()
    }

    #taken(name: string) {
        if (this.list.get().some((label) => label.id === name)) {
            throw new Error(`there's already a location named “${name}”`)
        }
    }

    /** Adds a label at `point` (in `frame`); resolves to whether a recording took it (the module's go out on its topic). */
    async create(text: string, point: THREE.Vector3, frame = this.app.viewer.fixedFrame): Promise<{ recorded: boolean }> {
        if (this.toModule) {
            this.#taken(text)
            await this.named.publish(withLocation(this.named.current, { label: text, frame_id: MAP_FRAME, position: this.#toMap(point, frame), orientation: [0, 0, 0, 1] }))
            return { recorded: false }
        }
        const response = await fetch(url("api/labels"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ label: text, frame_id: frame, position: point.toArray(), orientation: [0, 0, 0, 1] }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
            throw new Error(body.error ?? `${response.status}`)
        }
        return body
    }

    /** Gives a label new text, where it is. */
    async rename(label: LocationLabel, text: string) {
        if (this.toModule) {
            if (text !== label.id) {
                this.#taken(text)
            }
            return await this.named.publish(renamedLocation(this.named.current, label.id, text))
        }
        const response = await fetch(url(`api/labels/${encodeURIComponent(label.id)}`), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ label: text }),
        })
        if (!response.ok) {
            throw new Error((await response.json().catch(() => ({}))).error ?? `${response.status}`)
        }
    }

    async remove(id: string) {
        if (this.toModule) {
            return await this.named.publish(withoutLocation(this.named.current, id))
        }
        const response = await fetch(url(`api/labels/${encodeURIComponent(id)}`), { method: "DELETE" })
        if (!response.ok && response.status !== 404) {
            throw new Error(`${response.status}`)
        }
    }

    /** POST api/view/label (server/src/labels.rs through_page): an edit as the menu makes it, asked of this page. */
    async fromAgent({ action = "add", id, label, position, frame_id }: { action?: string; id?: string; label?: string; position?: number[]; frame_id?: string }) {
        const found = this.list.get().find((one) => one.id === id)
        if ((action === "rename" || action === "remove") && !found) {
            throw new Error(`no label ${id}`)
        }
        if (action === "add") {
            const [x, y, z = 0] = position!
            await this.create(label!.trim(), new THREE.Vector3(x, y, z), frame_id || undefined)
        } else if (action === "rename") {
            await this.rename(found!, label!.trim())
        } else if (action === "remove") {
            await this.remove(found!.id)
        }
        return { ok: true, via: this.toModule ? "named_locations" : "session", labels: this.list.get() }
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
