// sensor_msgs.PointCloud2: lidar scans and maps. The gateway's dimos_lcm_pointcloud2 encoding sends quantized xyz (+ u8
// intensity); the points go straight into preallocated GPU buffers (a ring when accumulating) and are colored in
// the shader, so a new scan costs one buffer upload and nothing is allocated per frame.
import * as THREE from "three"
import { registerLayer, type LayerContext } from "../core/layers/registry.ts"
import { headerFrameId } from "../core/lcm/lcm.ts"
import { applyLook, makePointMaterial } from "dimos-react/three"
import { Store } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { PointLookEditor } from "../ui/PointLookEditor.tsx"
import { materialLook, type PointLook, rendering, splatFallback } from "../core/render/rendering.ts"
import { Field, Select, Slider, Toggle } from "dimos-react"
import { useStore } from "../core/store.ts"
import { addCameraColor, CameraDepthPass, type CameraUniforms, setCameraModel } from "../core/render/cameraColor.ts"
import { CameraFeed } from "../core/render/cameraFeed.ts"
import { isImage, pickDefault } from "../core/cameraChoice.ts"
import { isDepthTopic } from "../core/video.ts"
import { CLOUD_PRESETS, cloudQualities, cloudQualityOf, CloudStream, type CloudQuality, formatBytes, formatCount, setCloudQuality, setCloudRate } from "../core/cloudQuality.ts"

export interface CloudSettings {
    look: PointLook
    /** "latest": only the newest scan; "accumulate": scans stay kept. Either way a scan is placed by TF as of when it was seen. */
    mode: "latest" | "accumulate"
    /** accumulate: forget points older than this (0 = never) */
    windowSeconds: number
    /** accumulate: ring capacity */
    maxPoints: number
    /** color the points with a live camera picture where the camera sees them */
    camera?: CameraColorSettings
}

export interface CameraColorSettings {
    on: boolean
    /** image topic key; "" = the profile's preferred color camera */
    topic: string
    /** meters a point may sit behind the nearest one the camera sees and still take its color */
    tolerance: number
}

const CAMERA_DEFAULTS: CameraColorSettings = { on: false, topic: "", tolerance: 0.08 }

/** the color cameras on the bus, for the settings' camera menu (the layers keep it current) */
const colorCameras = new Store<{ topics: Topic[] }>({ topics: [] })

const isMap = (topic: Topic) => /map|global|voxel|terrain|costmap/i.test(topic.name)

const DEFAULTS: CloudSettings = {
    look: { style: "default", size: 0.04, colorMode: "height", gradient: "memworld", axis: 2, rangeMin: null, rangeMax: null, solid: "#7fd4ff", opacity: 1 },
    mode: "latest",
    windowSeconds: 10,
    maxPoints: 2_000_000,
    camera: CAMERA_DEFAULTS,
}

const SPLAT_BUDGET = 3_000_000

/** How often the cloud's frame_id is re-read from one raw message (the encoding's output carries no header). */
const FRAME_RECHECK_MS = 30_000

class CloudLayer {
    readonly root = new THREE.Group()
    #points: THREE.Points
    #geometry = new THREE.BufferGeometry()
    #material: THREE.ShaderMaterial
    #capacity = 0
    #write = 0
    #filled = 0
    #frame: string | null = null
    #range: [number, number] = [0, 2]
    #rangeSeen = false
    #unsubscribe: (() => void)[] = []
    /** the bridge subscription at this viewer's preset (core/cloudQuality.ts) */
    #stream: CloudStream
    #rateSince = performance.now()
    #frameTimer: ReturnType<typeof setInterval>
    #fixedFrame: string
    /** the newest scan's timestamp (gateway ms): its TF is looked up as of then */
    #stamp: number | null = null
    #lastCount = 0
    #settings: Store<CloudSettings>
    #mode: CloudSettings["mode"]
    #camera: CameraUniforms
    #cameraPass: CameraDepthPass
    #feed: CameraFeed | null = null
    /** the camera's picture, pose or the points changed since the depth pass last ran */
    #cameraDirty = true
    #cameraPose = new THREE.Matrix4()

    constructor(readonly context: LayerContext, readonly topic: Topic, settings: Store<CloudSettings>) {
        this.#settings = settings
        this.#mode = settings.get().mode
        this.#fixedFrame = context.viewer.fixedFrame // a scan before the first frame isn't cleared as a fixed frame change
        this.#material = makePointMaterial(context.viewer.pixelsPerMeter)
        this.#camera = addCameraColor(this.#material)
        this.#cameraPass = new CameraDepthPass(this.#camera)
        this.#points = new THREE.Points(this.#geometry, this.#material)
        this.#points.frustumCulled = false
        this.#points.matrixAutoUpdate = false
        this.root.add(this.#points)
        this.#resize(1024)
        this.#readFrame()
        this.#frameTimer = setInterval(() => this.#readFrame(), FRAME_RECHECK_MS)
        this.#stream = new CloudStream(context.connection, topic.key, cloudQualityOf(topic.key), (message) => {
            const decoded = message.decoded as { positions?: Float32Array; intensity?: Uint8Array } | undefined
            if (decoded?.positions) {
                this.#onCloud(decoded.positions, decoded.intensity, message.timestamp)
            }
        })
        this.#unsubscribe.push(settings.subscribe(() => this.#onSettings()))
        this.#unsubscribe.push(rendering.subscribe(() => this.#onSettings()), splatFallback.subscribe(() => this.#onSettings()))
        this.#unsubscribe.push(cloudQualities.subscribe(() => this.#stream.setQuality(cloudQualityOf(topic.key))))
        this.#onSettings()
    }

    #onSettings() {
        const settings = this.#settings.get()
        if (settings.mode !== this.#mode) {
            this.#mode = settings.mode
            this.#clear()
        }
        this.#material.uniforms.uWindow.value = settings.mode === "accumulate" && settings.windowSeconds > 0 ? settings.windowSeconds : -1
        applyLook(this.#material, this.#look(), this.#range)
        this.#syncSplatBudget()
        this.#syncCamera()
        this.context.viewer.requestRender()
    }

    #cameraSettings(): CameraColorSettings {
        return { ...CAMERA_DEFAULTS, ...this.#settings.get().camera }
    }

    /** The camera to color from: the chosen topic while it's on the bus, else the profile's preferred color camera. */
    #cameraTopic(): Topic | null {
        const images = this.context.topics().filter((topic) => isImage(topic) && !isDepthTopic(topic))
        const chosen = this.#cameraSettings().topic
        return images.find((topic) => topic.key === chosen) ?? pickDefault(this.context.profile.cameras.preferred, images)
    }

    /** Opens, swaps or closes the camera feed to match the settings. */
    #syncCamera() {
        const settings = this.#cameraSettings()
        const topic = settings.on ? this.#cameraTopic() : null
        if (this.#feed && this.#feed.topic.key !== topic?.key) {
            this.#feed.dispose()
            this.#feed = null
        }
        if (topic && !this.#feed) {
            this.#feed = new CameraFeed(this.context, topic, () => {
                this.#cameraDirty = true
                this.context.viewer.requestRender()
            })
            this.#camera.uCamImage.value = this.#feed.texture
        }
        this.#camera.uCamTolerance.value = settings.tolerance
        this.#camera.uCamColor.value = 0
        this.#cameraDirty = true
    }

    /** The camera pass for this frame: where the camera is, then which points it sees nearest; off when it can't run. */
    #updateCamera(fixedFrame: string) {
        const feed = this.#feed
        const renderer = this.context.viewer.renderer
        if (!feed || !renderer) {
            return
        }
        const waiting = feed.waitingFor
        const pose = feed.frame ? this.context.tf.lookup(feed.frame, fixedFrame) : null
        if (waiting || !feed.model || !pose) {
            if (this.#camera.uCamColor.value) {
                this.#camera.uCamColor.value = 0
                this.context.viewer.requestRender()
            }
            return
        }
        if (!pose.equals(this.#cameraPose)) {
            this.#cameraPose.copy(pose)
            this.#camera.uCamFromWorld.value.copy(pose).invert()
            this.#cameraDirty = true
        }
        if (!this.#cameraDirty || !this.#points.visible) {
            return
        }
        this.#cameraDirty = false
        setCameraModel(this.#camera, feed.model)
        const look = this.#look()
        this.#points.updateMatrixWorld()
        this.#camera.uCamDepth.value = this.#cameraPass.render(renderer, this.#points, look.size, look.style === "voxel", feed.model)
        this.#camera.uCamColor.value = 1
        this.context.viewer.requestRender()
    }

    /** One raw message for its header's frame_id, then unsubscribe (a raw cloud is big). */
    #readFrame() {
        let stop: (() => void) | null = null
        stop = this.context.connection.subscribe(this.topic.key, { delivery: "latest", maxHz: 1 }, (message) => {
            const frame = headerFrameId(this.topic.type, message.bytes)
            if (frame !== null && frame !== this.#frame) {
                this.#frame = frame
                this.#clear()
            }
            stop?.()
            stop = null
        })
        this.#unsubscribe.push(() => stop?.())
    }

    /** the look with "default" and the splat fallback resolved */
    #look() {
        return materialLook(this.#settings.get().look)
    }

    /** Glow is fill-bound: over SPLAT_BUDGET points a stable random subset is drawn (see the vertex shader). */
    #syncSplatBudget() {
        this.#material.uniforms.uKeep.value = Math.min(1, SPLAT_BUDGET / Math.max(1, this.#filled))
    }

    #resize(capacity: number) {
        this.#capacity = capacity
        const position = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage)
        const time = new THREE.BufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage)
        // u8 like the bridge sends it (the shader reads 0..255 as a float): 17 bytes a point with position and time
        const intensity = new THREE.BufferAttribute(new Uint8Array(capacity), 1).setUsage(THREE.DynamicDrawUsage)
        this.#geometry.dispose()
        this.#geometry = new THREE.BufferGeometry()
        this.#geometry.setAttribute("position", position)
        this.#geometry.setAttribute("aTime", time)
        this.#geometry.setAttribute("aIntensity", intensity)
        this.#geometry.setDrawRange(0, 0)
        this.#points.geometry = this.#geometry
        this.#write = 0
        this.#filled = 0
    }

    #clear() {
        this.#stamp = null
        this.#write = 0
        this.#filled = 0
        this.#rangeSeen = false
        this.#geometry.setDrawRange(0, 0)
        this.context.viewer.requestRender()
    }

    #onCloud(positions: Float32Array, intensity: Uint8Array | undefined, timestamp: number) {
        if (this.#frame === null) {
            return // placed without its frame it would ride the wrong pose; the raw read arrives within a second
        }
        const settings = this.#settings.get()
        const count = positions.length / 3
        this.#lastCount = count
        const accumulate = settings.mode === "accumulate"
        // looked up once, as of the scan's own time, then frozen: odom at 50 Hz must not drag a 10 Hz scan along
        const placement = this.context.tfHistory.lookupAt(this.#frame, this.context.viewer.fixedFrame, timestamp)
        if (!placement) {
            this.#unplaced()
            return
        }
        this.#stamp = timestamp
        const transform = accumulate ? placement : null
        const wanted = accumulate ? Math.max(count, settings.maxPoints) : count
        if (wanted > this.#capacity || (!accumulate && this.#capacity > 4 * Math.max(wanted, 1024))) {
            this.#resize(accumulate ? wanted : Math.max(1024, 2 ** Math.ceil(Math.log2(wanted))))
        }
        const position = this.#geometry.getAttribute("position") as THREE.BufferAttribute
        const time = this.#geometry.getAttribute("aTime") as THREE.BufferAttribute
        const strength = this.#geometry.getAttribute("aIntensity") as THREE.BufferAttribute
        const now = performance.now() / 1000
        const start = accumulate ? this.#write : 0
        const xyz = position.array as Float32Array
        const times = time.array as Float32Array
        const values = strength.array as Uint8Array
        const e = transform?.elements
        for (let index = 0; index < count; index++) {
            const slot = (start + index) % this.#capacity
            const x = positions[index * 3], y = positions[index * 3 + 1], z = positions[index * 3 + 2]
            if (e) {
                xyz[slot * 3] = e[0] * x + e[4] * y + e[8] * z + e[12]
                xyz[slot * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]
                xyz[slot * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]
            } else {
                xyz[slot * 3] = x
                xyz[slot * 3 + 1] = y
                xyz[slot * 3 + 2] = z
            }
            times[slot] = now
            values[slot] = intensity ? intensity[index] : 0
        }
        // upload only what changed (a wrapped write is two ranges)
        for (const attribute of [position, time, strength]) {
            attribute.clearUpdateRanges()
            const size = attribute.itemSize
            const firstLength = Math.min(count, this.#capacity - start)
            attribute.addUpdateRange(start * size, firstLength * size)
            if (firstLength < count) {
                attribute.addUpdateRange(0, (count - firstLength) * size)
            }
            attribute.needsUpdate = true
        }
        if (accumulate) {
            this.#write = (start + count) % this.#capacity
            this.#filled = Math.min(this.#capacity, this.#filled + count)
            this.#place(new THREE.Matrix4())
        } else {
            this.#filled = count
            this.#place(placement)
        }
        this.#material.uniforms.uSensor.value.setFromMatrixPosition(placement)
        this.#geometry.setDrawRange(0, this.#filled)
        this.#syncSplatBudget()
        this.#updateRange(positions, intensity, placement)
        this.#cameraDirty = true
        this.context.viewer.noteData(timestamp)
    }

    #place(matrix: THREE.Matrix4) {
        this.#points.matrix.copy(matrix)
        this.#points.matrixWorldNeedsUpdate = true
        this.#points.visible = true
        this.context.viewer.requestRender()
        this.context.setStatus({ problem: this.#frame === "" ? "no frame_id: drawn in the fixed frame" : null, frame: this.#frame ?? undefined })
    }

    /** No TF path: a latest scan is hidden (it would sit at the wrong pose), kept scans stay where they were placed. */
    #unplaced() {
        if (this.#settings.get().mode === "latest" && this.#points.visible) {
            this.#points.visible = false
            this.context.viewer.requestRender()
        }
        this.context.setStatus({ problem: `no TF path from "${this.#frame}" to "${this.context.viewer.fixedFrame}"`, frame: this.#frame ?? undefined })
    }

    /** Auto color range: 5th-95th percentile (MemWorld's) of a sample, eased so it doesn't flicker scan to scan. */
    #updateRange(positions: Float32Array, intensity: Uint8Array | undefined, transform: THREE.Matrix4 | null) {
        const look = this.#settings.get().look
        const count = positions.length / 3
        if (!count) {
            return
        }
        let low: number, high: number
        if (look.colorMode === "intensity") {
            ;[low, high] = intensity ? [0, 255] : [0, 1]
        } else {
            const e = transform?.elements ?? new THREE.Matrix4().elements
            const step = Math.max(1, Math.floor(count / 2048))
            const samples: number[] = []
            const sensor = [e[12], e[13], e[14]]
            for (let index = 0; index < count; index += step) {
                const x = positions[index * 3], y = positions[index * 3 + 1], z = positions[index * 3 + 2]
                const world = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]
                samples.push(look.colorMode === "range" ? Math.hypot(world[0] - sensor[0], world[1] - sensor[1], world[2] - sensor[2]) : world[look.axis])
            }
            samples.sort((a, b) => a - b)
            low = samples[Math.floor(samples.length * 0.05)]
            high = samples[Math.floor(samples.length * 0.95)]
            if (look.colorMode === "range") {
                low = 0
            }
        }
        if (!this.#rangeSeen) {
            this.#range = [low, high]
            this.#rangeSeen = true
        } else {
            this.#range = [this.#range[0] + (low - this.#range[0]) * 0.2, this.#range[1] + (high - this.#range[1]) * 0.2]
        }
        applyLook(this.#material, this.#look(), this.#range)
    }

    update(frame: { now: number; fixedFrame: string }) {
        if (frame.fixedFrame !== this.#fixedFrame) {
            this.#fixedFrame = frame.fixedFrame
            if (this.#settings.get().mode === "accumulate") {
                this.#clear()
            } else if (this.#frame !== null && this.#stamp !== null) {
                // the shown scan re-placed in the new fixed frame, still as of its own time
                const placement = this.context.tfHistory.lookupAt(this.#frame, frame.fixedFrame, this.#stamp)
                if (placement) {
                    this.#place(placement)
                    this.#material.uniforms.uSensor.value.setFromMatrixPosition(placement)
                } else {
                    this.#unplaced()
                }
            }
        }
        this.#material.uniforms.uNow.value = frame.now / 1000
        if (frame.now - this.#rateSince > 1000) {
            const cameras = this.context.topics().filter((topic) => isImage(topic) && !isDepthTopic(topic))
            if (cameras.map((topic) => topic.key).join() !== colorCameras.get().topics.map((topic) => topic.key).join()) {
                colorCameras.set({ topics: cameras })
            }
        }
        if (this.#cameraSettings().on) {
            if (frame.now - this.#rateSince > 1000) {
                if (this.#feed?.topic.key !== this.#cameraTopic()?.key) {
                    this.#syncCamera() // the camera came onto the bus, or the chosen one left it
                }
                this.#feed?.findInfo()
            }
            this.#updateCamera(frame.fixedFrame)
        }
        if (this.#settings.get().mode === "accumulate" && this.#settings.get().windowSeconds > 0) {
            this.context.viewer.requestRender() // old points fade out by time even with no new scans
        }
        if (frame.now - this.#rateSince > 1000) {
            this.#rateSince = frame.now
            const rate = this.#stream.sample(frame.now)
            setCloudRate(this.topic.key, rate)
            const shown = this.#settings.get().mode === "accumulate" ? `${formatCount(this.#filled)} kept · ` : ""
            const camera = this.#feed ? ` · camera colors: ${this.#camera.uCamColor.value ? this.#feed.topic.name : `waiting for ${this.#feed.waitingFor ?? "a TF path"}`}` : ""
            this.context.setStatus({ info: this.#frame === null ? "waiting for frame_id…" : `${shown}${formatCount(this.#lastCount)} pts · ${rate.hz.toFixed(1)} Hz · ${formatBytes(rate.bytesPerSecond)}/s · ${this.#frame || "no frame"}${camera}` })
        }
    }

    dispose() {
        clearInterval(this.#frameTimer)
        this.#unsubscribe.forEach((stop) => stop())
        this.#stream.close()
        setCloudRate(this.topic.key, null)
        this.#feed?.dispose()
        this.#cameraPass.dispose()
        this.#geometry.dispose()
        this.#material.dispose()
    }
}

/** This viewer's bandwidth preset for a cloud (shared with the 3D panel's cloud menu). */
export function CloudQualitySelect({ topicKey }: { topicKey: string }) {
    useStore(cloudQualities)
    return <Select value={cloudQualityOf(topicKey)} options={CLOUD_PRESETS.map((preset) => [preset.id, preset.label])} onChange={(quality: string) => setCloudQuality(topicKey, quality as CloudQuality)} />
}

function CloudSettingsEditor({ settings, topic }: { settings: Store<CloudSettings>; topic: Topic }) {
    const value = useStore(settings)
    return (
        <>
            <PointLookEditor look={value.look} onChange={(look) => settings.update({ look })} />
            <Field inline label="Keep">
                <Select value={value.mode} options={[["latest", "latest scan"], ["accumulate", "accumulate"]]} onChange={(mode: string) => settings.update({ mode: mode as CloudSettings["mode"] })} />
            </Field>
            {value.mode === "accumulate" && (
                <Field inline label="Window">
                    <Select value={String(value.windowSeconds)} options={[["5", "5 s"], ["10", "10 s"], ["30", "30 s"], ["120", "2 min"], ["0", "forever"]]} onChange={(seconds: string) => settings.update({ windowSeconds: Number(seconds) })} />
                </Field>
            )}
            <Field inline label="Bandwidth" title={`this viewer's: ${CLOUD_PRESETS.map((preset) => `${preset.label}: ${preset.about}`).join("; ")}`}>
                <CloudQualitySelect topicKey={topic.key} />
            </Field>
            <CameraColorEditor settings={settings} />
        </>
    )
}

function CameraColorEditor({ settings }: { settings: Store<CloudSettings> }) {
    const value = useStore(settings)
    const camera = { ...CAMERA_DEFAULTS, ...value.camera }
    const update = (change: Partial<CameraColorSettings>) => settings.update({ camera: { ...camera, ...change } })
    const images = useStore(colorCameras).topics
    return (
        <>
            <Field inline label="Camera colors" title="color the points with the live camera picture where the camera sees them (nearest surface only)">
                <Toggle value={camera.on} onChange={(on: boolean) => update({ on })} />
            </Field>
            {camera.on && (
                <>
                    <Field inline label="Camera">
                        <Select value={camera.topic} options={[["", "auto (main camera)"], ...images.map((topic) => [topic.key, topic.name] as [string, string])]} onChange={(topic: string) => update({ topic })} />
                    </Field>
                    <Field inline label="Occlusion" title="how far behind the nearest surface the camera sees a point may be and still take its color">
                        <Slider min={0.02} max={0.5} step={0.01} value={camera.tolerance} format={(meters: number) => `${Math.round(meters * 100)} cm`} onChange={(tolerance: number) => update({ tolerance })} />
                    </Field>
                </>
            )}
        </>
    )
}

registerLayer<CloudSettings>({
    id: "pointcloud",
    label: "Point cloud",
    types: ["sensor_msgs.PointCloud2"],
    // MemWorld's look: lit spheres (a map's at its 10 cm voxel size), lit cubes as the "voxel" style
    defaults: (topic) => isMap(topic) ? { ...DEFAULTS, look: { ...DEFAULTS.look, size: 0.1 } } : structuredClone(DEFAULTS),
    create: (context, topic, settings) => new CloudLayer(context, topic, settings),
    Settings: CloudSettingsEditor,
})
