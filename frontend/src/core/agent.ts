// The page's side of the agent link (server/src/annotations.rs): draws the live annotations every open viewer shares,
// and answers capture requests only the page can: its rendered 3D view, the robot camera's latest frame, and
// locating an object in 3D from a box around it in that frame (lidar points inside the box, else the floor). The
// backend's events arrive on zenoh (dim-app's appEvents: the frontend topic `events`); this page GETs what they change
// on load and whenever the connection comes back, and reports itself (POST api/pages/<id>) so captures come to it.
import { themeColors } from "../dim-app/source/theme.js"
import * as THREE from "three"
import { decode, headerFrameId } from "./lcm/lcm.ts"
import { LabelPool } from "./render/labels.ts"
import type { Topic } from "./transport.ts"
import type { ViewerApp } from "./app.ts"
import { cameraInfoFor } from "./video.ts"
import { frontObject, groundLevel } from "./locate.ts"
import { appEvents } from "../dim-app/source/events.js"
import type { LocationLabel } from "./labels.ts"
import { applyRemoteSetting, loadSettings } from "./store.ts"
import type { DriveEvent } from "./drive.ts"

export interface Annotation {
    id: string
    label: string
    center: [number, number, number]
    size: [number, number, number]
    yaw: number
    frame: string
    color?: string | null
    note?: string | null
}

interface CameraInfo {
    frame: string
    width: number
    height: number
    fx: number
    fy: number
    cx: number
    cy: number
}

type Bbox = [number, number, number, number]

// optical (x right, y down, z forward) → body (x forward, y left, z up)
const OPTICAL_TO_BODY = new THREE.Matrix4().set(0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1)
const DEFAULT_COLOR = "#ffd166"
const GRID_STEP = 50

function round(value: number, digits = 3): number {
    const scale = 10 ** digits
    return Math.round(value * scale) / scale
}

const pageId = Math.random().toString(36).slice(2, 10)
/** the backend forgets a page it hasn't heard from in 15 s */
const REPORT_MS = 5000

export class AgentLink {
    readonly group = new THREE.Group()
    #labels = new LabelPool("scene-label annotation-label")
    #annotations: Annotation[] = []
    #objects = new Map<string, { root: THREE.Group; key: string }>()
    #camera: { topic: Topic; element: HTMLVideoElement } | null = null
    #info: CameraInfo | null = null
    #infoTopic: string | null = null
    #cloud: { positions: Float32Array; frame: string | null; at: number } | null = null
    #stops: (() => void)[] = []

    constructor(readonly app: ViewerApp) {
        this.group.add(this.#labels.group)
        app.viewer.scene.add(this.group)
        app.viewer.onFrame(() => this.#place())
        this.#listen()
        this.#reportActivity()
    }

    get annotations(): Annotation[] {
        return this.#annotations
    }

    #url(path: string): string {
        return new URL(path, location.href).href
    }

    #listen() {
        const stop = appEvents((raw) => {
            // deno-lint-ignore no-explicit-any
            const event = raw as { type: string; page?: string; annotations?: Annotation[]; labels?: LocationLabel[]; request?: string; kind?: string; args?: unknown; key?: string; value?: unknown; action?: string; target?: any; distance?: any }
            if (event.type === "annotations" && event.annotations) {
                this.#annotations = event.annotations
                this.#rebuild()
            } else if (event.type === "labels" && event.labels) {
                this.app.labels.apply(event.labels)
            } else if (event.type === "settings" && event.key) {
                applyRemoteSetting(event.key, event.value)
            } else if (event.type === "drive") {
                this.app.drive.applyEvent(event as unknown as DriveEvent)
            } else if (event.type === "camera" && event.action) {
                this.app.applyCamera({ action: event.action, target: event.target, distance: event.distance })
            } else if (event.type === "capture" && event.request && event.page === pageId) {
                this.#answer(event.request, event.kind ?? "", event.args)
            }
        }, { onOpen: () => this.#resync() })
        this.#stops.push(stop)
    }

    /** Snapshot + live: what the events change, read again on connect and reconnect (events sent meanwhile are gone). */
    #resync() {
        fetch(this.#url("api/annotations"))
            .then((response) => response.json())
            .then((body) => {
                this.#annotations = body.annotations ?? []
                this.#rebuild()
            })
            .catch(() => {})
        fetch(this.#url("api/labels"))
            .then((response) => response.json())
            .then((body) => this.app.labels.apply(body.labels ?? []))
            .catch(() => {})
        loadSettings()
    }

    /** Tells the server this page is open (every REPORT_MS) and when it's the one the user is looking at (it answers
     * the agent's captures); the page's going away is a beacon. */
    #reportActivity() {
        const report = (active: boolean) => {
            fetch(this.#url(`api/pages/${pageId}`), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ visible: document.visibilityState === "visible", active }),
            }).catch(() => {})
        }
        addEventListener("pointerdown", () => report(true))
        addEventListener("focus", () => report(true))
        document.addEventListener("visibilitychange", () => report(document.visibilityState === "visible"))
        setInterval(() => report(document.hasFocus()), REPORT_MS)
        addEventListener("pagehide", () => navigator.sendBeacon(this.#url(`api/pages/${pageId}/close`)))
        report(true)
    }

    #rebuild() {
        const wanted = new Set(this.#annotations.map((annotation) => annotation.id))
        for (const [id, object] of this.#objects) {
            if (!wanted.has(id)) {
                object.root.removeFromParent()
                object.root.traverse((child) => {
                    const mesh = child as THREE.Mesh
                    mesh.geometry?.dispose()
                    ;(mesh.material as THREE.Material | undefined)?.dispose?.()
                })
                this.#objects.delete(id)
            }
        }
        for (const annotation of this.#annotations) {
            const key = JSON.stringify([annotation.size, annotation.color])
            const existing = this.#objects.get(annotation.id)
            if (existing && existing.key === key) {
                continue
            }
            existing?.root.removeFromParent()
            const color = new THREE.Color(annotation.color || DEFAULT_COLOR)
            const geometry = new THREE.BoxGeometry(...annotation.size)
            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }))
            edges.renderOrder = 10
            const fill = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, depthWrite: false }))
            const root = new THREE.Group()
            root.matrixAutoUpdate = false
            root.add(fill, edges)
            this.group.add(root)
            this.#objects.set(annotation.id, { root, key })
        }
        this.app.viewer.requestRender()
    }

    /** The annotation's pose in the fixed frame, or null without a TF path. */
    #pose(annotation: Annotation): THREE.Matrix4 | null {
        const transform = this.app.tf.lookup(annotation.frame || this.app.viewer.fixedFrame, this.app.viewer.fixedFrame)
        if (!transform) {
            return null
        }
        const local = new THREE.Matrix4().makeRotationZ(annotation.yaw || 0).setPosition(...annotation.center)
        return transform.clone().multiply(local)
    }

    #place() {
        this.#labels.begin()
        for (const annotation of this.#annotations) {
            const object = this.#objects.get(annotation.id)
            const pose = this.#pose(annotation)
            if (!object) {
                continue
            }
            object.root.visible = !!pose
            if (!pose) {
                continue
            }
            if (!object.root.matrix.equals(pose)) {
                object.root.matrix.copy(pose)
                object.root.matrixWorldNeedsUpdate = true
                this.app.viewer.requestRender()
            }
            const top = new THREE.Vector3(0, 0, annotation.size[2] / 2 + 0.12).applyMatrix4(pose)
            const text = [annotation.label || annotation.id, annotation.note].filter(Boolean).join("\n")
            this.#labels.place(text, top, annotation.color || DEFAULT_COLOR)
        }
        this.#labels.end()
    }

    async #answer(request: string, kind: string, args: unknown) {
        let body: unknown
        try {
            body = kind === "view" ? await this.view() : kind === "locate" ? await this.locate(args as { bbox: Bbox }) : { error: `unknown capture ${kind}` }
        } catch (error) {
            body = { error: String(error instanceof Error ? error.message : error) }
        }
        await fetch(this.#url(`api/captures/${request}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {})
    }

    // ---- the robot camera, its CameraInfo, the lidar ----

    #topics(): Topic[] {
        return this.app.connection.status.get().topics
    }

    #ensureSources() {
        const topics = this.#topics()
        if (!this.#camera) {
            const images = topics.filter((topic) => topic.type === "sensor_msgs.Image" || topic.type === "sensor_msgs.CompressedImage").filter((topic) => !/depth/i.test(topic.name))
            const topic = this.app.profile.cameras.preferred.map((name) => images.find((image) => image.name === name)).find(Boolean) ?? images[0]
            if (topic) {
                const source = this.app.video.acquire(topic)
                this.#camera = { topic, element: this.app.video.element(source) }
            }
        }
        // its CameraInfo may show up on the bridge after the image does: keep looking until it has
        if (this.#camera && !this.#infoTopic) {
            const info = cameraInfoFor(this.#camera.topic, topics, this.app.profile.cameras.cameraInfo)
            if (info) {
                this.#infoTopic = info.key
                this.#stops.push(this.app.connection.subscribe(info.key, { delivery: "latest", maxHz: 1 }, (message) => {
                    const value = decode("sensor_msgs.CameraInfo", message.bytes) as { header: { frame_id: string }; width: number; height: number; K: number[] }
                    this.#info = { frame: value.header.frame_id, width: value.width, height: value.height, fx: value.K[0], fy: value.K[4], cx: value.K[2], cy: value.K[5] }
                }))
            }
        }
        if (!this.#cloud) {
            const clouds = topics.filter((topic) => topic.type === "sensor_msgs.PointCloud2" && !/map|global|accum/i.test(topic.name))
            const topic = clouds.find((cloud) => /lidar|scan|points|registered/i.test(cloud.name)) ?? clouds[0]
            if (topic) {
                this.#cloud = { positions: new Float32Array(), frame: null, at: 0 }
                const cloud = this.#cloud
                this.#stops.push(this.app.connection.subscribe(topic.key, { delivery: "latest", maxHz: 2, encoding: "dimos_lcm_pointcloud2", minQuality: 1 }, (message) => {
                    const decoded = message.decoded as { positions?: Float32Array } | undefined
                    if (decoded?.positions) {
                        cloud.positions = decoded.positions
                        cloud.at = performance.now()
                    }
                }))
                const stopFrame = this.app.connection.subscribe(topic.key, { delivery: "latest", maxHz: 1 }, (message) => {
                    cloud.frame = headerFrameId(topic.type, message.bytes)
                    if (cloud.frame !== null) {
                        stopFrame()
                    }
                })
            }
        }
    }

    async #until(ready: () => boolean, ms: number) {
        const started = performance.now()
        while (!ready() && performance.now() - started < ms) {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }

    /** The camera frame's pose in the fixed frame, in optical convention (z forward, x right, y down). */
    #cameraPose(info: CameraInfo): THREE.Matrix4 | null {
        const transform = this.app.tf.lookup(info.frame, this.app.viewer.fixedFrame)
        if (!transform) {
            return null
        }
        return /optical/i.test(info.frame) ? transform.clone() : transform.clone().multiply(OPTICAL_TO_BODY)
    }

    /** The latest camera frame with a labelled pixel grid, and where the camera is. */
    async cameraImage() {
        this.#ensureSources()
        const camera = this.#camera
        if (!camera) {
            return { error: "no camera topic on the gateway" }
        }
        await this.#until(() => {
            this.#ensureSources()
            return camera.element.readyState >= 2 && camera.element.videoWidth > 0 && !!this.#info
        }, 5000)
        if (!camera.element.videoWidth) {
            return { topic: camera.topic.name, error: "no camera frame yet" }
        }
        // the stream may be scaled for video; draw it at CameraInfo's size so pixels match the intrinsics
        const width = this.#info?.width || camera.element.videoWidth
        const height = this.#info?.height || camera.element.videoHeight
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext("2d")!
        context.drawImage(camera.element, 0, 0, width, height)
        context.strokeStyle = "rgba(255,255,255,0.35)"
        context.fillStyle = "rgba(255,255,255,0.9)"
        context.font = "10px sans-serif"
        context.lineWidth = 1
        for (let x = GRID_STEP; x < width; x += GRID_STEP) {
            context.beginPath()
            context.moveTo(x + 0.5, 0)
            context.lineTo(x + 0.5, height)
            context.stroke()
            if (x % 100 === 0) {
                context.fillText(String(x), x + 2, 10)
            }
        }
        for (let y = GRID_STEP; y < height; y += GRID_STEP) {
            context.beginPath()
            context.moveTo(0, y + 0.5)
            context.lineTo(width, y + 0.5)
            context.stroke()
            if (y % 100 === 0) {
                context.fillText(String(y), 2, y - 2)
            }
        }
        const info = this.#info
        const pose = info ? this.#cameraPose(info) : null
        const position = pose ? new THREE.Vector3().setFromMatrixPosition(pose) : null
        const quaternion = pose ? new THREE.Quaternion().setFromRotationMatrix(pose) : null
        return {
            topic: camera.topic.name,
            width,
            height,
            grid: `faint lines every ${GRID_STEP} px, labelled every 100 px (x along the top, y down the left)`,
            cameraInfo: info,
            pose: position && quaternion ? { frame: this.app.viewer.fixedFrame, position: position.toArray().map((v) => round(v)), quaternion: quaternion.toArray().map((v) => round(v, 4)), convention: "optical: z forward, x right, y down" } : null,
            image: { mimeType: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.85).split(",")[1] },
        }
    }

    /** What the user sees: the 3D view (labels drawn in), the 3D camera, the robot camera image, the annotations. */
    async view() {
        const viewer = this.app.viewer
        viewer.renderer?.render(viewer.scene, viewer.camera)
        const gl = viewer.canvas
        const scale = Math.min(1, 1280 / gl.width)
        const canvas = document.createElement("canvas")
        canvas.width = Math.round(gl.width * scale)
        canvas.height = Math.round(gl.height * scale)
        const context = canvas.getContext("2d")!
        context.fillStyle = themeColors().sceneBg || (document.body.classList.contains("dark") ? "#05070d" : "#f5f4ef")
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(gl, 0, 0, canvas.width, canvas.height)
        context.font = "bold 14px sans-serif"
        for (const annotation of this.#annotations) {
            const pose = this.#pose(annotation)
            if (!pose) {
                continue
            }
            const top = new THREE.Vector3(0, 0, annotation.size[2] / 2 + 0.12).applyMatrix4(pose).project(viewer.camera)
            if (top.z > 1) {
                continue
            }
            const x = (top.x + 1) / 2 * canvas.width
            const y = (1 - top.y) / 2 * canvas.height
            const text = [annotation.label || annotation.id, annotation.note].filter(Boolean).join(" · ")
            const width = context.measureText(text).width
            context.fillStyle = "rgba(0,0,0,0.6)"
            context.fillRect(x - width / 2 - 4, y - 16, width + 8, 20)
            context.fillStyle = annotation.color || DEFAULT_COLOR
            context.fillText(text, x - width / 2, y)
        }
        const camera = viewer.camera
        const fx = (canvas.height / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
        return {
            fixedFrame: viewer.fixedFrame,
            camera: {
                position: camera.position.toArray().map((v) => round(v)),
                target: viewer.controls.target.toArray().map((v) => round(v)),
                quaternion: camera.quaternion.toArray().map((v) => round(v, 4)),
                verticalFovDeg: camera.fov,
                width: canvas.width,
                height: canvas.height,
                intrinsics: { fx: round(fx, 1), fy: round(fx, 1), cx: canvas.width / 2, cy: canvas.height / 2 },
                convention: "three.js camera: looks along its -z, +y up; the world is +z up",
            },
            view: { mimeType: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.85).split(",")[1] },
            cameraImage: await this.cameraImage(),
            robot: this.#robot(),
            annotations: this.#annotations,
        }
    }

    /** The robot's pose in the fixed frame (TF base frame, else a pose/odometry topic), or null. */
    #robot() {
        const matrix = this.app.robotMatrix
        if (!matrix) {
            return null
        }
        const position = new THREE.Vector3().setFromMatrixPosition(matrix)
        const forward = new THREE.Vector3(1, 0, 0).transformDirection(matrix)
        return { frame: this.app.viewer.fixedFrame, position: position.toArray().map((v) => round(v)), yaw: round(Math.atan2(forward.y, forward.x), 3), convention: "yaw: radians about +z, 0 = +x" }
    }

    /** An object's 3D box from a box around it in the camera image: lidar points inside, else the floor under it. */
    async locate({ bbox }: { bbox: Bbox }) {
        this.#ensureSources()
        await this.#until(() => {
            this.#ensureSources()
            return !!this.#info && !!this.#cloud?.positions.length && this.#cloud.frame !== null
        }, 5000)
        const info = this.#info
        if (!info) {
            return { error: "no CameraInfo for the camera yet" }
        }
        const pose = this.#cameraPose(info)
        if (!pose) {
            return { error: `no TF from ${info.frame} to ${this.app.viewer.fixedFrame}` }
        }
        const [x1, y1, x2, y2] = [Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3]), Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3])]
        // a box edge at the image's edge means the object goes on past it: don't cut the points there
        const edge = 3
        const open = { left: x1 <= edge, top: y1 <= edge, right: x2 >= info.width - edge, bottom: y2 >= info.height - edge }
        const inverse = pose.clone().invert()
        const points = this.#cloudInFixedFrame()
        const ground = groundLevel(points, new THREE.Vector3().setFromMatrixPosition(pose))
        const hits: { point: THREE.Vector3; depth: number }[] = []
        const local = new THREE.Vector3()
        for (const point of points) {
            local.copy(point).applyMatrix4(inverse)
            if (local.z < 0.2) {
                continue
            }
            const u = info.fx * local.x / local.z + info.cx
            const v = info.fy * local.y / local.z + info.cy
            const inside = (open.left || u >= x1) && (open.right || u <= x2) && (open.top || v >= y1) && (open.bottom || v <= y2)
            if (inside && point.z > ground + 0.08) {
                hits.push({ point: point.clone(), depth: local.z })
            }
        }
        const cluster = frontObject(hits)
        if (cluster.length >= 8) {
            const low = new THREE.Vector3(Infinity, Infinity, Infinity)
            const high = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
            for (const hit of cluster) {
                low.min(hit.point)
                high.max(hit.point)
            }
            // standing on the floor: the box goes down to it
            const bottom = low.z - ground < 0.3 ? ground : low.z
            const size: [number, number, number] = [round(high.x - low.x + 0.1), round(high.y - low.y + 0.1), round(high.z - bottom)]
            const center: [number, number, number] = [round((low.x + high.x) / 2), round((low.y + high.y) / 2), round((bottom + high.z) / 2)]
            const depth = cluster.reduce((sum, hit) => sum + hit.depth, 0) / cluster.length
            return {
                method: "lidar",
                points: cluster.length,
                depth: round(depth, 2),
                height: round(high.z - bottom, 2),
                imageHeight: open.top || open.bottom ? null : round((y2 - y1) * depth / info.fy, 2),
                ground: round(ground),
                box: { center, size, yaw: 0, frame: this.app.viewer.fixedFrame },
                note: open.top ? "the box reaches the top of the image, so the object may continue above it: the height comes from the lidar points" : "",
            }
        }
        // no lidar on it: the box's bottom is where it touches the floor
        if (open.bottom) {
            return { error: "no lidar points in that box and its bottom is cut off by the image edge, so the floor contact is unknown" }
        }
        const camera = new THREE.Vector3().setFromMatrixPosition(pose)
        const rayAt = (u: number, v: number) => new THREE.Vector3((u - info.cx) / info.fx, (v - info.cy) / info.fy, 1).transformDirection(pose)
        const foot = rayAt((x1 + x2) / 2, y2)
        if (foot.z >= -1e-3) {
            return { error: "the box's bottom is above the horizon, so it can't be on the floor" }
        }
        const distance = (ground - camera.z) / foot.z
        const base = camera.clone().addScaledVector(foot, distance)
        const depth = new THREE.Vector3().subVectors(base, camera).applyMatrix4(new THREE.Matrix4().extractRotation(inverse)).z
        const height = (y2 - y1) * depth / info.fy
        const width = (x2 - x1) * depth / info.fx
        return {
            method: "floor contact (no lidar points in the box)",
            points: 0,
            depth: round(depth, 2),
            height: open.top ? null : round(height, 2),
            ground: round(ground),
            box: { center: [round(base.x), round(base.y), round(ground + height / 2)], size: [round(width), round(width), round(height)], yaw: 0, frame: this.app.viewer.fixedFrame },
            note: open.top ? "the box reaches the top of the image: the object is taller than what is visible" : "",
        }
    }

    #cloudInFixedFrame(): THREE.Vector3[] {
        const cloud = this.#cloud
        if (!cloud || cloud.frame === null) {
            return []
        }
        const transform = this.app.tf.lookup(cloud.frame, this.app.viewer.fixedFrame)
        if (!transform) {
            return []
        }
        const points: THREE.Vector3[] = []
        for (let index = 0; index + 2 < cloud.positions.length; index += 3) {
            points.push(new THREE.Vector3(cloud.positions[index], cloud.positions[index + 1], cloud.positions[index + 2]).applyMatrix4(transform))
        }
        return points
    }

    dispose() {
        this.#stops.forEach((stop) => stop())
        this.#labels.dispose()
        this.group.removeFromParent()
    }
}
