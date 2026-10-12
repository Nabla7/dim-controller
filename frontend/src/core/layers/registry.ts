// How a message type becomes something on screen. A layer type is one file under src/layers (or a forker's own
// file) that calls registerLayer; the LayerManager makes one instance per matching topic while it's switched on.
import type { ComponentType } from "react"
import type * as THREE from "three"
import type { Connection, Topic } from "../transport.ts"
import type { FrameInfo, TfTree, Viewer } from "dimos-react/three"
import type { Store } from "../store.ts"
import type { VideoSources } from "../video.ts"
import type { RobotProfile } from "../../profile/types.ts"

/** What a layer instance can use. */
export interface LayerContext {
    viewer: Viewer
    tf: TfTree
    connection: Connection
    /** shared camera streams */
    video: VideoSources
    /** every topic on the bridge right now */
    topics(): Topic[]
    /** the active robot profile (fork-specific defaults) */
    profile: RobotProfile
    /** reports a problem the UI shows next to the layer (null clears it) */
    setStatus(status: LayerStatus): void
}

export interface LayerStatus {
    /** short live info, e.g. "84k pts · 10 Hz" */
    info?: string
    /** why it isn't drawn as expected, e.g. "no TF from lidar_link to world" */
    problem?: string | null
    /** the frame_id its data is in (for the TF check: a frame with no path to the fixed frame is flagged) */
    frame?: string
}

export interface LayerInstance {
    /** added to the scene by the manager, removed on dispose */
    root: THREE.Object3D
    /** every frame before rendering: re-place by TF, animate, prune */
    update?(frame: FrameInfo): void
    dispose(): void
}

export interface LayerType<Settings extends object = object> {
    /** unique, e.g. "pointcloud" */
    id: string
    /** shown in the layer list */
    label: string
    /** dimos message types it draws, e.g. ["sensor_msgs.PointCloud2"] */
    types: string[]
    /** only these topic names (e.g. ["/scene_info"]): for a generic type like std_msgs.String */
    names?: string[]
    /** per-topic settings, persisted; the Settings component edits them (a function picks them per topic) */
    defaults: Settings | ((topic: Topic) => Settings)
    /** on when first seen (default true) */
    enabledByDefault?: (topic: Topic) => boolean
    create(context: LayerContext, topic: Topic, settings: Store<Settings>): LayerInstance
    Settings?: ComponentType<{ settings: Store<Settings>; topic: Topic }>
}

const layerTypes: LayerType<object>[] = []

/** Registers a layer type; a later registration for the same message type wins (so forks can override). */
export function registerLayer<Settings extends object>(type: LayerType<Settings>) {
    const existing = layerTypes.findIndex((other) => other.id === type.id)
    if (existing >= 0) {
        layerTypes.splice(existing, 1)
    }
    layerTypes.push(type as unknown as LayerType<object>)
}

export function layerTypeFor(messageType: string, topicName?: string): LayerType<object> | undefined {
    for (let index = layerTypes.length - 1; index >= 0; index--) {
        const type = layerTypes[index]
        if (type.names && (topicName === undefined || !type.names.includes(topicName))) {
            continue
        }
        if (type.types.includes(messageType)) {
            return layerTypes[index]
        }
    }
    return undefined
}

export function allLayerTypes(): readonly LayerType<object>[] {
    return layerTypes
}

// ── camera-panel overlays (2D things drawn over an image, e.g. Detection2DArray) ──

export interface OverlayType {
    id: string
    label: string
    types: string[]
    /** draws the latest message (decoded with the LCM schemas) in image pixel coordinates */
    draw(context: CanvasRenderingContext2D, message: unknown, image: { width: number; height: number }): void
}

const overlayTypes: OverlayType[] = []

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
