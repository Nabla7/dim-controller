// nav_msgs.Odometry, geometry_msgs.PoseStamped / PoseWithCovarianceStamped: the pose as axes, and the path it
// has driven, kept in the fixed frame (bounded, configurable length; a jump leaves a gap instead of a streak).
import * as THREE from "three"
import { registerLayer, type LayerContext } from "../core/layers/registry.ts"
import { poseMatrix, subscribeDecoded } from "../core/layers/helpers.ts"
import { FatLines } from "../core/render/lines.ts"
import { robotPose } from "../core/robot.ts"
import { useStore, type Store } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { Field, Select, Slider, Toggle } from "../ui/controls.tsx"

export interface PoseSettings {
    trail: boolean
    /** most trail segments kept; the oldest go first */
    trailLength: number
    /** a step longer than this is a teleport/relocalization, not motion: no segment */
    jumpMeters: number
    color: string
    width: number
    axesSize: number
    /** drawn over everything (a path is usually inside the map it was driven through) */
    onTop: boolean
}

const MIN_STEP = 0.02

class PoseLayer {
    readonly root = new THREE.Group()
    #axes: THREE.AxesHelper
    #trail: FatLines
    #stop: () => void
    #pose: THREE.Matrix4 | null = null
    #frame = ""
    #last: THREE.Vector3 | null = null
    #fixedFrame = ""
    #count = 0
    #since = performance.now()

    constructor(readonly context: LayerContext, readonly topic: Topic, readonly settings: Store<PoseSettings>) {
        this.#axes = new THREE.AxesHelper(1)
        this.#axes.matrixAutoUpdate = false
        this.#axes.visible = false
        this.root.add(this.#axes)
        this.#trail = new FatLines(context.viewer.resolution, { width: settings.get().width, color: settings.get().color, capacity: 1024 })
        this.root.add(this.#trail.object)
        settings.subscribe(() => this.#restyle())
        this.#restyle()
        this.#stop = subscribeDecoded(context, topic, { maxHz: 50 }, (message, timestamp) => this.#onMessage(message, timestamp))
    }

    #restyle() {
        const settings = this.settings.get()
        this.#trail.material.color.set(settings.color)
        this.#trail.material.linewidth = settings.width
        this.#trail.object.visible = settings.trail
        this.#trail.material.depthTest = settings.onTop === false
        // three draws every transparent object after every opaque one: on top of blended (glow) clouds needs the
        // trail in the transparent list too, where renderOrder puts it last
        this.#trail.material.transparent = settings.onTop !== false
        this.#trail.object.renderOrder = settings.onTop === false ? 0 : 10
        this.#axes.scale.setScalar(settings.axesSize)
        this.context.viewer.requestRender()
    }

    // deno-lint-ignore no-explicit-any
    #onMessage(message: any, timestamp: number) {
        const pose = this.topic.type === "nav_msgs.Odometry" ? message.pose?.pose : this.topic.type === "geometry_msgs.PoseWithCovarianceStamped" ? message.pose?.pose : message.pose
        this.#frame = message.header?.frame_id ?? ""
        this.#pose = poseMatrix(pose, this.#pose ?? new THREE.Matrix4())
        this.#count++
        const world = this.context.tf.lookup(this.#frame, this.context.viewer.fixedFrame)
        if (!world) {
            this.context.setStatus({ problem: `no TF path from "${this.#frame}" to "${this.context.viewer.fixedFrame}"`, frame: this.#frame })
            return
        }
        const placed = world.clone().multiply(this.#pose)
        robotPose.report(this.topic.key, placed)
        const position = new THREE.Vector3().setFromMatrixPosition(placed)
        const settings = this.settings.get()
        if (this.#last) {
            const step = position.distanceTo(this.#last)
            if (step < MIN_STEP) {
                this.context.viewer.noteData(timestamp)
                return
            }
            if (step <= settings.jumpMeters) {
                this.#trail.push(this.#last.x, this.#last.y, this.#last.z, position.x, position.y, position.z)
                if (this.#trail.count > settings.trailLength) {
                    this.#trail.shift(Math.max(1, Math.floor(settings.trailLength * 0.1)))
                }
                this.#trail.commit()
            }
        }
        this.#last = position
        this.context.viewer.noteData(timestamp)
    }

    update(frame: { now: number; fixedFrame: string }) {
        if (frame.fixedFrame !== this.#fixedFrame) {
            this.#fixedFrame = frame.fixedFrame
            this.#trail.clear()
            this.#trail.commit()
            this.#last = null
        }
        if (this.#pose) {
            const world = this.context.tf.lookup(this.#frame, frame.fixedFrame)
            this.#axes.visible = !!world
            if (world) {
                this.#axes.matrix.multiplyMatrices(world, this.#pose).scale(new THREE.Vector3().setScalar(this.settings.get().axesSize))
                this.context.setStatus({ problem: null, frame: this.#frame })
            }
        }
        if (frame.now - this.#since > 1000) {
            this.context.setStatus({ info: `${(this.#count * 1000 / (frame.now - this.#since)).toFixed(0)} Hz · trail ${this.#trail.count} · ${this.#frame || "no frame"}` })
            this.#count = 0
            this.#since = frame.now
        }
    }

    dispose() {
        this.#stop()
        robotPose.forget(this.topic.key)
        this.#trail.dispose()
        this.#axes.dispose()
    }
}

function PoseSettingsEditor({ settings }: { settings: Store<PoseSettings>; topic: Topic }) {
    const value = useStore(settings)
    return (
        <>
            <Field label="Trail"><Toggle value={value.trail} onChange={(trail) => settings.update({ trail })} /></Field>
            <Field label="Length">
                <Select value={String(value.trailLength)} options={[["500", "500 steps"], ["5000", "5k steps"], ["20000", "20k steps"], ["100000", "100k steps"]]} onChange={(length) => settings.update({ trailLength: Number(length) })} />
            </Field>
            <Field label="On top"><Toggle value={value.onTop !== false} onChange={(onTop) => settings.update({ onTop })} /></Field>
            <Field label="Color"><input type="color" value={value.color} onChange={(event) => settings.update({ color: event.target.value })} /></Field>
            <Field label="Width"><Slider min={1} max={8} step={0.5} value={value.width} format={(width) => `${width}px`} onChange={(width) => settings.update({ width })} /></Field>
            <Field label="Axes"><Slider min={0} max={2} step={0.1} value={value.axesSize} format={(size) => `${size} m`} onChange={(axesSize) => settings.update({ axesSize })} /></Field>
        </>
    )
}

registerLayer<PoseSettings>({
    id: "pose",
    label: "Pose + trail",
    types: ["nav_msgs.Odometry", "geometry_msgs.PoseStamped", "geometry_msgs.PoseWithCovarianceStamped"],
    // magenta: no point-cloud gradient uses it, so the path reads over any map
    defaults: () => ({ trail: true, trailLength: 20000, jumpMeters: 2.5, color: "#7cc8ec", width: 4, axesSize: 0.6, onTop: true }),
    create: (context, topic, settings) => new PoseLayer(context, topic, settings),
    Settings: PoseSettingsEditor,
})
