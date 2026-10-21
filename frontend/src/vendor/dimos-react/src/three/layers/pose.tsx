// nav_msgs.Odometry, geometry_msgs.PoseStamped / PoseWithCovarianceStamped: the pose as axes, and the path it has
// driven, kept in the fixed frame (bounded, configurable length; a jump leaves a gap instead of a streak). When the
// data source knows a topic's whole route up front (a recording: `source.route(key)`), it's drawn faintly ahead of
// the robot, and after a seek the trail is rebuilt from it up to the playhead instead of starting empty.
import * as THREE from "three"
import { useStore } from "../store.ts"
import { themeColors } from "../../theme/theme.ts"
import { FatLines } from "../lines.ts"
import { cssColor } from "../robot_model.ts"
import { registerLayer, subscribeDecoded } from "./registry.ts"
import type { LayerContext, LayerSettingsProps, Topic } from "./registry.ts"
import { Field, Select, Slider, Toggle } from "../../components/controls.tsx"
import { ColorSwatch } from "../../components/input_devices.tsx"
import type { DataSource, Route } from "../../data.ts"
import type { Store } from "../store.ts"
import type { FrameInfo } from "../viewer.ts"

/**
 * `trailLength`: most trail segments kept; `jumpMeters`: a longer step is a teleport (no segment); `onTop`: drawn
 * over everything; `route`: the whole recorded route, faint (when the source knows it); `color`: CSS or a token
 */
export interface PoseSettings {
    trail: boolean
    trailLength: number
    jumpMeters: number
    color: string
    width: number
    axesSize: number
    route: boolean
}

/** A geometry_msgs Pose (`{ position, orientation }`, any field may be missing) or a `{ x, y, z, yaw }` shorthand. */
export interface PoseLike {
    position?: { x?: number; y?: number; z?: number }
    orientation?: { x?: number; y?: number; z?: number; w?: number }
    x?: number
    y?: number
    z?: number
    yaw?: number
    isMatrix4?: undefined
}

export const POSE_DEFAULTS: PoseSettings = {
    trail: true,
    trailLength: 20000,
    jumpMeters: 2.5,
    color: "var(--primary)",
    width: 4,
    axesSize: 0.6,
    route: true,
}

const MIN_STEP = 0.02

/** A geometry_msgs Pose ({ position, orientation }), a `{ x, y, z, yaw }` shorthand or a Matrix4, as a Matrix4. */
export function poseMatrix(
    pose: PoseLike | THREE.Matrix4 | null | undefined,
    out: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 {
    if (pose?.isMatrix4) {
        return out.copy(pose)
    }
    if (pose && pose.position === undefined && (pose.x !== undefined || pose.yaw !== undefined)) {
        const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pose.yaw ?? 0)
        return out.compose(
            new THREE.Vector3(pose.x ?? 0, pose.y ?? 0, pose.z ?? 0),
            quaternion,
            new THREE.Vector3(1, 1, 1),
        )
    }
    const position = pose?.position ?? {}
    const orientation = pose?.orientation ?? {}
    const quaternion = new THREE.Quaternion(
        orientation.x ?? 0,
        orientation.y ?? 0,
        orientation.z ?? 0,
        orientation.w ?? 1,
    )
    if (quaternion.lengthSq() < 1e-12) {
        quaternion.set(0, 0, 0, 1)
    }
    return out.compose(
        new THREE.Vector3(position.x ?? 0, position.y ?? 0, position.z ?? 0),
        quaternion.normalize(),
        new THREE.Vector3(1, 1, 1),
    )
}

/** The pose inside a decoded message (any shape): Odometry / PoseWithCovarianceStamped (.pose.pose), PoseStamped (.pose), Pose. */
// deno-lint-ignore no-explicit-any -- decoded pose messages of any shape
export function poseOf(message: any): PoseLike | THREE.Matrix4 | null | undefined {
    return message?.pose?.pose ?? message?.pose ?? message
}

const routes = new WeakMap<DataSource, Map<string, Promise<Route | null>>>()

/** The source's recorded route of a pose topic, cached per source and topic (null when it has none). */
function routeOf(source: DataSource, key: string): Promise<Route | null> {
    if (typeof source.route !== "function") {
        return Promise.resolve(null)
    }
    let cache = routes.get(source)
    if (!cache) {
        cache = new Map()
        routes.set(source, cache)
    }
    let promise = cache.get(key)
    if (!promise) {
        promise = Promise.resolve(source.route(key)).catch(() => null)
        cache.set(key, promise)
    }
    return promise
}

export class PoseLayer {
    root = new THREE.Group()
    #axes: THREE.AxesHelper
    #trail: FatLines
    #ghost: FatLines
    #stop: () => void = () => {}
    #pose: THREE.Matrix4 | null = null
    #frame = ""
    #last: THREE.Vector3 | null = null
    #fixedFrame = ""
    #count = 0
    #since = performance.now()
    #route: Route | null = null
    #ghostFrame = ""
    #unsubscribe: () => void
    settings: Store<PoseSettings>
    topic: Topic | null
    context: LayerContext

    /** `topic` null: poses come through setData */
    constructor(context: LayerContext, topic: Topic | null, settings: Store<PoseSettings>) {
        this.context = context
        this.topic = topic
        this.settings = settings
        this.#axes = new THREE.AxesHelper(1)
        this.#axes.matrixAutoUpdate = false
        this.#axes.visible = false
        this.root.add(this.#axes)
        this.#trail = new FatLines(context.viewer.resolution, {
            width: settings.get().width,
            color: 0xffffff,
            capacity: 1024,
        })
        this.#ghost = new FatLines(context.viewer.resolution, {
            width: Math.max(1, settings.get().width - 1.5),
            color: 0xffffff,
            capacity: 1024,
            opacity: 0.28,
        })
        this.root.add(this.#trail.object, this.#ghost.object)
        this.#unsubscribe = settings.subscribe(() => this.#restyle())
        addEventListener("dimos-react-theme", this.#restyle)
        this.#restyle()
        if (topic) {
            routeOf(context.source, topic.key).then((route) => {
                if (route?.points?.length) {
                    this.#route = route
                    this.#drawGhost()
                    this.reset()
                }
            })
            this.#stop = subscribeDecoded(context, topic, { maxHz: 50 }, (message, timestamp) => {
                this.#onPose(poseOf(message), message?.header?.frame_id ?? message?.frame ?? "", timestamp)
            })
        }
    }

    #restyle = () => {
        const settings = this.settings.get()
        const color = cssColor(settings.color, "white")
        const theme = themeColors()
        this.#axes.setColors(
            cssColor(theme.axisX, "red"),
            cssColor(theme.axisY, "green"),
            cssColor(theme.axisZ, "blue"),
        )
        this.#trail.material.color.copy(color)
        this.#trail.material.linewidth = settings.width
        this.#trail.object.visible = settings.trail
        this.#ghost.material.color.copy(color)
        this.#ghost.material.linewidth = Math.max(1, settings.width - 1.5)
        this.#ghost.object.visible = settings.route !== false
        if (!settings.trail) {
            this.#clearTrail()
        }
        this.context.viewer.requestRender()
    }

    /** the whole route, in the fixed frame */
    #drawGhost() {
        this.#ghost.clear()
        const route = this.#route
        const world = route && this.context.tf.lookup(route.frame ?? "", this.context.viewer.fixedFrame)
        this.#ghostFrame = world ? this.context.viewer.fixedFrame : ""
        if (route && world) {
            const jump = this.settings.get().jumpMeters
            const a = new THREE.Vector3(),
                b = new THREE.Vector3()
            for (let index = 1; index < route.points.length; index++) {
                const [, ax, ay, az] = route.points[index - 1]
                const [, bx, by, bz] = route.points[index]
                a.set(ax, ay, az).applyMatrix4(world)
                b.set(bx, by, bz).applyMatrix4(world)
                if (a.distanceTo(b) <= jump) {
                    this.#ghost.push(a.x, a.y, a.z, b.x, b.y, b.z)
                }
            }
        }
        this.#ghost.commit()
        this.context.viewer.requestRender()
    }

    #clearTrail() {
        this.#trail.clear()
        this.#trail.commit()
        this.#last = null
    }

    /** The data jumped (a seek): the trail becomes the recorded route up to the playhead (or starts over). */
    reset() {
        this.#trail.clear()
        this.#last = null
        const route = this.#route
        const world = route && this.context.tf.lookup(route.frame ?? "", this.context.viewer.fixedFrame)
        if (route && world && this.settings.get().trail) {
            const now = this.context.viewer.dataClock() / 1000
            const settings = this.settings.get()
            const position = new THREE.Vector3()
            for (const [t, x, y, z] of route.points) {
                if (t > now) {
                    break
                }
                position.set(x, y, z).applyMatrix4(world)
                if (this.#last && position.distanceTo(this.#last) <= settings.jumpMeters) {
                    this.#trail.push(this.#last.x, this.#last.y, this.#last.z, position.x, position.y, position.z)
                }
                this.#last = (this.#last ?? new THREE.Vector3()).copy(position)
            }
            if (this.#trail.count > settings.trailLength) {
                this.#trail.shift(this.#trail.count - settings.trailLength)
            }
        }
        this.#trail.commit()
        this.context.viewer.requestRender()
    }

    /** Props data: `{ pose, frame?, timestamp? }` (pose: geometry_msgs Pose, `{ x, y, yaw }` or a Matrix4). */
    setData(data: { pose?: PoseLike | THREE.Matrix4; frame?: string; timestamp?: number } | null | undefined) {
        if (data?.pose) {
            this.#onPose(data.pose, data.frame ?? "", data.timestamp ?? Date.now())
        }
    }

    #onPose(pose: PoseLike | THREE.Matrix4 | null | undefined, frame: string, timestamp: number | undefined) {
        this.#frame = frame
        this.#pose = poseMatrix(pose, this.#pose ?? new THREE.Matrix4())
        this.#count++
        const world = this.context.tf.lookup(frame, this.context.viewer.fixedFrame)
        if (!world) {
            this.context.setStatus({
                problem: `no TF path from "${frame}" to "${this.context.viewer.fixedFrame}"`,
                frame,
            })
            return
        }
        const placed = world.clone().multiply(this.#pose)
        this.context.robotPose?.report(this.topic?.key ?? this, placed)
        this.context.onPose?.(placed)
        const position = new THREE.Vector3().setFromMatrixPosition(placed)
        const settings = this.settings.get()
        if (settings.trail && this.#last) {
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

    update(frame: FrameInfo) {
        if (frame.fixedFrame !== this.#fixedFrame) {
            this.#fixedFrame = frame.fixedFrame
            this.reset()
        }
        if (this.#route && this.#ghostFrame !== frame.fixedFrame) {
            this.#drawGhost()
        }
        if (this.#pose) {
            const world = this.context.tf.lookup(this.#frame, frame.fixedFrame)
            const size = this.settings.get().axesSize
            this.#axes.visible = !!world && size > 0
            if (world) {
                this.#axes.matrix.multiplyMatrices(world, this.#pose).scale(new THREE.Vector3().setScalar(size))
                this.#axes.matrixWorldNeedsUpdate = true
                this.context.setStatus({ problem: null, frame: this.#frame })
                this.context.viewer.requestRender()
            }
        }
        if (frame.now - this.#since > 1000) {
            this.context.setStatus({
                info: `${
                    ((this.#count * 1000) / (frame.now - this.#since)).toFixed(
                        0,
                    )
                } Hz · trail ${this.#trail.count} · ${this.#frame || "no frame"}`,
            })
            this.#count = 0
            this.#since = frame.now
        }
    }

    dispose() {
        this.#stop()
        this.#unsubscribe()
        removeEventListener("dimos-react-theme", this.#restyle)
        this.context.robotPose?.forget(this.topic?.key ?? this)
        this.#trail.dispose()
        this.#ghost.dispose()
        this.#axes.dispose()
    }
}

export interface ColorSettingProps {
    /** CSS or a token like var(--primary) */
    value: string
    onChange?: (color: string) => void
}

/** A color setting: a swatch for hex colors (a token like var(--primary) shows as its current color). */
export function ColorSetting({ value, onChange }: ColorSettingProps) {
    const hex = `#${cssColor(value, "white").getHexString()}`
    return <ColorSwatch value={hex} onChange={onChange} />
}

export function PoseSettingsEditor({ settings }: LayerSettingsProps<PoseSettings>) {
    const value = useStore(settings)
    return (
        <div className="dr-layer-settings-grid">
            <Field label="Trail">
                <Toggle value={value.trail} onChange={(trail) => settings.update({ trail })} />
            </Field>
            <Field label="Whole route" hint="when the source knows it (a recording)">
                <Toggle value={value.route !== false} onChange={(route) => settings.update({ route })} />
            </Field>
            <Field label="Length">
                <Select
                    value={value.trailLength}
                    options={[
                        [500, "500 steps"],
                        [5000, "5k steps"],
                        [20000, "20k steps"],
                        [100000, "100k steps"],
                    ]}
                    onChange={(trailLength) => settings.update({ trailLength })}
                />
            </Field>
            <Field label="Color">
                <ColorSetting value={value.color} onChange={(color) => settings.update({ color })} />
            </Field>
            <Field label="Width">
                <Slider
                    min={1}
                    max={8}
                    step={0.5}
                    value={value.width}
                    format={(width) => `${width}px`}
                    onChange={(width) => settings.update({ width })}
                />
            </Field>
            <Field label="Axes">
                <Slider
                    min={0}
                    max={2}
                    step={0.1}
                    value={value.axesSize}
                    format={(size) => `${size} m`}
                    onChange={(axesSize) => settings.update({ axesSize })}
                />
            </Field>
        </div>
    )
}

registerLayer<PoseSettings>({
    id: "pose",
    label: "Pose + trail",
    types: ["nav_msgs.Odometry", "geometry_msgs.PoseStamped", "geometry_msgs.PoseWithCovarianceStamped"],
    defaults: () => ({ ...POSE_DEFAULTS }),
    create: (context, topic, settings) => new PoseLayer(context, topic, settings),
    Settings: PoseSettingsEditor,
})
