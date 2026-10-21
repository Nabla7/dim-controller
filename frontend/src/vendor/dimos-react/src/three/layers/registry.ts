// deno-lint-ignore-file no-explicit-any -- layers take decoded messages of any shape
// How a message type becomes something in the 3D view. A layer type registers the dimos message types it draws; a
// LayerManager (or a single <Layer>) makes one instance per topic. Apps add their own types with registerLayer (a
// later registration for the same id wins, so an app can override a built-in one).
//
//     registerLayer({
//         id: "my-layer", label: "My layer", types: ["my_msgs.Thing"],
//         defaults: { color: "#ffaa00" },             // per-topic settings (a Store the Settings component edits)
//         create(context, topic, settings) {          // → { root, update?(frame), dispose(), reset?(), setData?() }
//             const root = new THREE.Group()
//             const stop = subscribeDecoded(context, topic, { maxHz: 10 }, (message, timestamp) => { ... })
//             return { root, update: (frame) => placeLayer(context, root, "base_link", frame.fixedFrame), dispose: stop }
//         },
//         Settings: ({ settings, topic }) => h(...),  // optional, built from dimos-react components
//     })
import * as THREE from "three"
import type { ComponentType } from "react"
import { decodeMessage } from "../../data.ts"
import type { DataSource, Message, Topic } from "../../data.ts"
import type { CameraStreams } from "../../components/camera.tsx"
import type { Store } from "../store.ts"
import type { TfTree } from "../tf.ts"
import type { FrameInfo, Viewer } from "../viewer.ts"

export type { Topic }

/** `info`: short live info ("84k pts · 10 Hz"); `problem`: why it isn't drawn as expected; `frame`: its data's frame_id */
export interface LayerStatus {
    info?: string
    problem?: string | null
    frame?: string
}

export interface LayerContext {
    viewer: Viewer
    tf: TfTree
    source: DataSource
    video: CameraStreams
    topics: () => Topic[]
    setStatus: (status: LayerStatus) => void
    robotPose: RobotPose
    options: { baseFrame?: string; cameraInfo?: Record<string, string> }
    /** a pose layer's pose, placed in the fixed frame (a <Layer>'s onPose) */
    onPose?: (matrix: THREE.Matrix4) => void
}

export interface LayerInstance {
    root: THREE.Object3D
    update?: (frame: FrameInfo) => void
    dispose: () => void
    reset?: () => void
    /** props data (a <Layer data>): its shape is up to the layer type */
    setData?: (data: any) => void
}

export interface LayerSettingsProps<S extends object> {
    settings: Store<S>
    topic?: Topic | null
}

/** `S`: the type's per-topic settings (any by default: a registry holds every type's). */
export interface LayerType<S extends object = any> {
    id: string
    label: string
    types: string[]
    defaults: S | ((topic: Topic | null) => S)
    enabledByDefault?: (topic: Topic) => boolean
    /** `topic` null: the data comes through `setData` */
    create: (context: LayerContext, topic: Topic | null, settings: Store<S>) => LayerInstance
    Settings?: ComponentType<LayerSettingsProps<S>>
}

export interface OverlayType {
    id: string
    label: string
    types: string[]
    /** `message`: the decoded message, any shape */
    draw: (context: CanvasRenderingContext2D, message: any, image: { width: number; height: number }) => void
}

/**
 * Settings every layer type takes, beside its own. `onTop`: drawn over everything else (Viewer.setOnTop), instead of
 * depth-tested among the clouds (the default); the Layers panel shows it as each layer's "Draw on top".
 */
export interface LayerCommonSettings {
    onTop?: boolean
}

/** Keeps `root` on top while `settings.onTop` says so; the returned function stops (and puts it back in the scene). */
export function followOnTop(viewer: Viewer, root: THREE.Object3D, settings: Store<LayerCommonSettings>): () => void {
    const apply = () => viewer.setOnTop(root, !!settings.get().onTop)
    apply()
    const off = settings.subscribe(apply)
    return () => {
        off()
        viewer.setOnTop(root, false)
    }
}

const layerTypes: LayerType[] = []

/** Registers a layer type (replacing one with the same id). */
export function registerLayer<S extends object>(type: LayerType<S>) {
    const existing = layerTypes.findIndex((other) => other.id === type.id)
    if (existing >= 0) {
        layerTypes.splice(existing, 1)
    }
    layerTypes.push(type)
}

/** The layer type drawing a message type (the latest registration wins), or undefined. */
export function layerTypeFor(messageType: string): LayerType | undefined {
    for (let index = layerTypes.length - 1; index >= 0; index--) {
        if (layerTypes[index].types.includes(messageType)) {
            return layerTypes[index]
        }
    }
    return undefined
}

/** A layer type by id. */
export const layerTypeById = (id: string): LayerType | undefined => layerTypes.find((type) => type.id === id)

export function allLayerTypes(): readonly LayerType[] {
    return layerTypes
}

/** A type's default settings for a topic (a fresh copy). */
export function defaultSettings<S extends object>(type: LayerType<S>, topic: Topic | null): S {
    return typeof type.defaults === "function" ? type.defaults(topic) : structuredClone(type.defaults ?? {})
}

const overlayTypes: OverlayType[] = []

/** Registers a 2D overlay drawn over camera images (e.g. Detection2DArray boxes). */
export function registerOverlay(type: OverlayType) {
    const existing = overlayTypes.findIndex((other) => other.id === type.id)
    if (existing >= 0) {
        overlayTypes.splice(existing, 1)
    }
    overlayTypes.push(type)
}

export function overlayTypeFor(messageType: string): OverlayType | undefined {
    return [...overlayTypes].reverse().find((type) => type.types.includes(messageType))
}

export function allOverlayTypes(): readonly OverlayType[] {
    return overlayTypes
}

/**
 * Sets `object.matrix` to T_fixed_frame and shows it; with no TF path it hides it and reports why. Returns whether
 * it could be placed. `stamp` (ms): with the tf as it was then (TfTree.lookupAt), not the latest.
 */
export function placeLayer(
    context: LayerContext,
    object: THREE.Object3D,
    frame: string,
    fixedFrame: string,
    stamp?: number,
): boolean {
    const matrix = stamp === undefined
        ? context.tf.lookup(frame, fixedFrame)
        : context.tf.lookupAt(frame, fixedFrame, stamp)
    if (!matrix) {
        if (object.visible) {
            object.visible = false
            context.viewer.requestRender()
        }
        context.setStatus({ problem: `no TF path from "${frame}" to "${fixedFrame}"`, frame })
        return false
    }
    if (!object.visible || !object.matrix.equals(matrix)) {
        object.matrix.copy(matrix)
        object.matrixWorldNeedsUpdate = true
        object.visible = true
        context.viewer.requestRender()
    }
    context.setStatus({ problem: frame === "" ? "no frame_id: drawn in the fixed frame" : null, frame })
    return true
}

/**
 * Subscribes to a topic and hands each decoded message (and its timestamp) to `onMessage`; decode failures are
 * counted into the layer's status. Returns unsubscribe.
 */
export function subscribeDecoded(
    context: LayerContext,
    topic: Topic,
    options: { maxHz?: number; reliable?: boolean; decodeAs?: string },
    // the decoded message is LCM / a published value: any shape
    onMessage: (decoded: any, timestamp: number | undefined, message: Message) => void,
): () => void {
    let failures = 0
    return context.source.subscribe(
        topic.key,
        { delivery: options.reliable ? "reliable" : "latest", maxHz: options.maxHz ?? 30 },
        (message) => {
            let decoded
            try {
                decoded = decodeMessage(message, "auto", options.decodeAs ?? topic.type)
            } catch (error) {
                failures++
                const reason = error instanceof Error ? error.message : error
                context.setStatus({ problem: `cannot decode ${topic.type} (${failures}×): ${reason}` })
                return
            }
            onMessage(decoded, message.timestamp, message)
        },
    )
}

/** std_msgs ColorRGBA (any field may be missing) */
export interface ColorRGBA {
    r?: number
    g?: number
    b?: number
    a?: number
}

/** std_msgs ColorRGBA → THREE.Color + alpha. */
export function rgba(color: ColorRGBA | null | undefined): { color: THREE.Color; alpha: number } {
    return { color: new THREE.Color(color?.r ?? 1, color?.g ?? 1, color?.b ?? 1), alpha: color?.a ?? 1 }
}

/**
 * The robot's latest pose in the fixed frame from any pose/odometry layer, for following it when no TF frame names
 * the robot. The first topic to report keeps it until it goes away. One per Scene3D.
 */
export class RobotPose {
    matrix: THREE.Matrix4 | null = null
    /** who reported it: a topic key, or the layer itself when it has no topic */
    source: unknown = null
    report(source: unknown, matrix: THREE.Matrix4) {
        if (this.source === null || this.source === source) {
            this.source = source
            this.matrix = matrix
        }
    }
    forget(source: unknown) {
        if (this.source === source) {
            this.source = null
            this.matrix = null
        }
    }
}
