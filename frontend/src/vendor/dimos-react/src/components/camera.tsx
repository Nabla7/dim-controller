// Camera streams and views. A color image topic arrives as zenoh-gateway's H.264 video track (sized and paced by a
// latency ↔ quality preset: gateway subscription options), a depth topic losslessly as fields (16UC1 mm / 32FC1 m)
// drawn as a colormap; a panel and a 3D projection of the same topic share one subscription. 2D detections can be drawn
// over any camera. Ported from dim-controller core/video.ts, core/videoQuality.ts, core/cameraChoice.ts.
//
//     h(CameraView, { topic: { key, name, type }, overlay: detectionsTopic, onInfo: (info) => … })
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import type { DepthImage, DepthLook } from "../camera/depth_types.ts"
import { cx } from "../cx.ts"
import { useDataSource } from "../data.ts"
import type { DataSource, Message, Subscription, Topic } from "../data.ts"
import { decode as decodeLcm } from "../lcm.ts"
import { Store, useStore } from "../three/store.ts"
import { drawDetections2D, IMAGE_OVERLAY_TYPES, ImageView, normalizeFrame, rawToImageData } from "./media.tsx"

// ── latency ↔ quality presets (zenoh-gateway's video policy) ──

/**
 * No preset sets maxHz: zenoh-gateway >= 0.5.1 encodes at min(maxHz, the source's rate), and each wants the camera's
 * own rate. playoutDelay is the browser side: how long the receiver may hold frames to play them out evenly.
 */
export interface VideoOptions {
    maxResolution?: [number, number]
    /** 0 drops frames before detail, 1 keeps the rate */
    qualityToHzTradeoff?: number
    minResolutionScale?: number
    /** bits per second */
    maxBitrate?: number
    minQuality?: number
    /** [min, max] ms the browser may hold frames to play them out evenly */
    playoutDelay?: [number, number]
}

/** a latency ↔ quality preset: gateway subscription options */
export interface VideoPreset {
    id: string
    label: string
    about: string
    options: VideoOptions
}

export const VIDEO_PRESETS: VideoPreset[] = [
    {
        id: "latency",
        label: "Low latency",
        about:
            "fits 640×360 at the gateway's default bits per pixel; small frames arrive and decode soonest, the rate kept when the link is squeezed",
        options: { maxResolution: [640, 360], qualityToHzTradeoff: 1 },
    },
    {
        id: "balanced",
        label: "Balanced",
        about: "the gateway picks size and bitrate for the bandwidth, at the camera's rate",
        options: {},
    },
    {
        id: "quality",
        label: "High quality",
        about:
            "full size, never shrunk, up to 6 Mbit/s (at least 30% of it); drops frames before detail when the link is squeezed, and the browser buffers 100-400 ms to play frames out evenly",
        options: {
            minResolutionScale: 1,
            maxBitrate: 6_000_000,
            minQuality: 0.3,
            qualityToHzTradeoff: 0,
            playoutDelay: [100, 400],
        },
    },
]

const RENAMED: Record<string, string> = { auto: "balanced", smooth: "latency", sharp: "quality" }
/** A preset by id (old names map to the nearest one; unknown → Balanced). */
export const videoPreset = (id: string | null | undefined): VideoPreset =>
    VIDEO_PRESETS.find((preset) => preset.id === (RENAMED[id ?? ""] ?? id)) ?? VIDEO_PRESETS[1]

/** What `Subscription.update` needs to go from one preset to another: the new values, null for what only `from` set. */
export function videoPresetChanges(from: VideoPreset, to: VideoPreset): Record<string, unknown> {
    const changes: Record<string, unknown> = {}
    for (const name of Object.keys(from.options)) {
        changes[name] = null
    }
    return { ...changes, ...to.options }
}

/** Whether options keep the browser in low-latency rendering (playoutDelay min 0, max <= 500 ms; default [0, 0]). */
export function lowLatencyRendering(options: VideoOptions): boolean {
    const [min, max] = options.playoutDelay ?? [0, 0]
    return min === 0 && max <= 500
}

/**
 * Whether a change can't be made in place: back to low-latency rendering from a buffered playout. Firefox freezes a
 * receiver for good once its render time drops back to 0, so that takes a fresh subscription (a new receiver).
 */
export const needsNewReceiver = (from: VideoOptions, to: VideoOptions): boolean =>
    !lowLatencyRendering(from) && lowLatencyRendering(to)

// ── which topics are cameras ──

export const isImageTopic = (topic: Pick<Topic, "type">): boolean =>
    topic.type === "sensor_msgs.Image" || topic.type === "sensor_msgs.CompressedImage"
export const isDepthTopic = (topic: Pick<Topic, "name">): boolean => /depth/i.test(topic.name)

/** The camera to show first: `preferred` topic names in order, else the first color image, else any image. */
export function pickCamera<T extends Topic>(
    preferred: readonly string[] | null | undefined,
    topics: readonly T[],
    exclude: ReadonlySet<string> = new Set(),
): T | null {
    const images = topics.filter((topic) => isImageTopic(topic) && !exclude.has(topic.key))
    for (const name of preferred ?? []) {
        const found = images.find((topic) => topic.name === name)
        if (found) {
            return found
        }
    }
    return images.find((topic) => !isDepthTopic(topic)) ?? images[0] ?? null
}

/**
 * Panels (`{ key, picked? }`) pointed at what the bus has: a panel's picked topic when it's back, else a panel whose
 * topic isn't on the bus moves to a default camera no other panel shows. Null when nothing changes.
 */
export function retargetCameras<P extends { key: string; picked?: string | null }>(
    panels: readonly P[],
    topics: readonly Topic[],
    preferred?: readonly string[] | null,
): P[] | null {
    const onBus = new Set(topics.filter(isImageTopic).map((topic) => topic.key))
    const used = new Set(panels.filter((panel) => onBus.has(panel.key)).map((panel) => panel.key))
    let changed = false
    const next = panels.map((panel) => {
        if (panel.picked && panel.picked !== panel.key && onBus.has(panel.picked)) {
            changed = true
            used.add(panel.picked)
            return { ...panel, key: panel.picked }
        }
        if (onBus.has(panel.key)) {
            return panel
        }
        const fallback = pickCamera(preferred, topics, used)
        if (!fallback) {
            return panel
        }
        changed = true
        used.add(fallback.key)
        return { ...panel, key: fallback.key }
    })
    return changed ? next : null
}

export interface CameraTab<T extends Topic = Topic> {
    topic: T
    label: string
    depth: boolean
}

/** Every image topic as a tab (`{ topic, label, depth }`), color first then depth, labeled by what tells them apart. */
export function cameraTabs<T extends Topic>(topics: readonly T[]): CameraTab<T>[] {
    const images = topics
        .filter(isImageTopic)
        .sort(
            (a, b) =>
                Number(isDepthTopic(a)) - Number(isDepthTopic(b)) ||
                a.name.localeCompare(b.name) ||
                a.type.localeCompare(b.type),
        )
    const split = images.map((topic) => topic.name.split("/").filter(Boolean))
    let shared = 0
    if (split.length > 1) {
        while (split.every((parts) => shared < parts.length - 1 && parts[shared] === split[0][shared])) {
            shared++
        }
    }
    let tail = 0
    if (split.length > 1) {
        const at = (parts: string[]) => parts[parts.length - 1 - tail]
        while (split.every((parts) => parts.length - shared - tail > 1 && at(parts) === at(split[0]))) {
            tail++
        }
    }
    const labels = split.map((parts) => parts.slice(shared, parts.length - tail).join("/"))
    return images.map((topic, index) => {
        const twin = labels.some((label, other) => other !== index && label === labels[index])
        return {
            topic,
            label: twin ? `${labels[index]} (${topic.type.split(".").pop()})` : labels[index],
            depth: isDepthTopic(topic),
        }
    })
}

/** The CameraInfo topic for an image topic: `overrides[name]`, else the one sharing the longest leading part of the name. */
export function cameraInfoFor<T extends Topic>(
    image: Pick<Topic, "name">,
    topics: readonly T[],
    overrides: Record<string, string> = {},
): T | null {
    const infos = topics.filter((topic) => topic.type === "sensor_msgs.CameraInfo")
    const wanted = overrides[image.name]
    if (wanted) {
        return infos.find((topic) => topic.name === wanted) ?? null
    }
    const parts = image.name.split("/")
    let best: T | null = null
    let bestScore = -1
    for (const info of infos) {
        const other = info.name.split("/")
        let shared = 0
        while (shared < Math.min(parts.length, other.length) - 1 && parts[shared] === other[shared]) {
            shared++
        }
        const score = shared * 10 + (/color|rgb/i.test(image.name) === /color|rgb/i.test(info.name) ? 1 : 0)
        if (score > bestScore) {
            best = info
            bestScore = score
        }
    }
    return best
}

// ── shared streams ──

/** a color stream's latest state: a live track (`stream`) or a replay's decoded frame (`image`) */
export interface VideoState {
    stream: MediaStream | null
    image: ImageBitmap | ImageData | null
    width: number
    height: number
    fps: number
}

/** one topic's shared subscription (CameraStreams.acquire) */
export interface CameraStreamHandle {
    users: number
    /** ends the subscription (a source's Subscription once open) */
    stop: (() => void) & Partial<Pick<Subscription, "update">>
    video: Store<VideoState>
    depth: Store<{ image: DepthImage | null }>
    quality: Store<{ quality: string }>
    element: HTMLVideoElement | null
    ticket: number
    newest: number
}

/** a message as zenoh-gateway's video channel delivers it: a live track, or a source's frame */
type CameraMessage = Message & {
    mediaStream?: MediaStream
    video?: { width?: number; height?: number }
}

const readLocal = <T,>(key: string, fallback: T): T => {
    try {
        const raw = globalThis.localStorage?.getItem(key)
        return raw ? JSON.parse(raw) : fallback
    } catch {
        return fallback
    }
}
const writeLocal = (key: string, value: unknown) => {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value))
    } catch {
        // storage unavailable: lasts for this page
    }
}

/**
 * The page's camera subscriptions over a data source, shared and counted: `acquire(topic)` → `{ video, depth, quality }`
 * stores (video: `{ stream, width, height, fps }`, depth: `{ image }`), `release(topic)`, `setQuality(topic, id)`
 * (this viewer's preset per topic, in localStorage under `storageKey`), `element(handle)` (a playing <video> for
 * textures). A source that delivers images itself (a replay) sends `{ width, height, encoding, data }` (depth),
 * `{ bitmap | image, width, height }` (color), a frame (`{ kind, width, height, encoding, data }`, jpeg/png/webp or raw
 * pixels), a decoded sensor_msgs.Image / CompressedImage, or the LCM bytes of one: frames are decoded here (newest wins)
 * into `video.image` (an ImageBitmap or ImageData).
 */
export class CameraStreams {
    #sources = new Map<string, CameraStreamHandle>()
    storageKey: string
    source: DataSource
    constructor(source: DataSource, { storageKey = "dr.video.quality" }: { storageKey?: string } = {}) {
        this.source = source
        this.storageKey = storageKey
    }

    qualityOf(key: string): string {
        return videoPreset(readLocal<Record<string, string>>(this.storageKey, {})[key]).id
    }

    acquire(topic: Topic): CameraStreamHandle {
        let handle = this.#sources.get(topic.key)
        if (handle) {
            handle.users++
            return handle
        }
        handle = {
            users: 1,
            stop: () => {},
            video: new Store<VideoState>({ stream: null, image: null, width: 0, height: 0, fps: 0 }),
            depth: new Store<{ image: DepthImage | null }>({ image: null }),
            quality: new Store({ quality: isDepthTopic(topic) ? "balanced" : this.qualityOf(topic.key) }),
            element: null,
            ticket: 0,
            newest: 0,
        }
        this.#open(topic, handle)
        this.#sources.set(topic.key, handle)
        return handle
    }

    #open(topic: Topic, handle: CameraStreamHandle) {
        const { video, depth } = handle
        const prefix = topic.type === "sensor_msgs.CompressedImage" ? "dimos_lcm_compressed_" : "dimos_lcm_"
        let frames = 0
        let since = performance.now()
        const fpsNow = (state: VideoState) => {
            frames++
            const now = performance.now()
            if (now - since > 1000) {
                const fps = Math.round((frames * 1000) / (now - since))
                frames = 0
                since = now
                return fps
            }
            return state.fps
        }
        if (isDepthTopic(topic)) {
            handle.stop = this.source.subscribe(
                topic.key,
                { delivery: "latest", maxHz: 15, encoding: `${prefix}depth` },
                (message) => {
                    const image = (message.decoded ??
                        message.value ??
                        lcmValue(message, topic.type)) as DepthImage | null
                    if (image?.data) {
                        depth.set({ image })
                    }
                },
            )
            return
        }
        handle.stop = this.source.subscribe(
            topic.key,
            { delivery: "latest", ...videoPreset(handle.quality.get().quality).options, encoding: `${prefix}image` },
            async (received) => {
                const message = received as CameraMessage
                // deno-lint-ignore no-explicit-any -- a source's frame: any of the forms above
                let decoded: any = message.decoded ?? message.value ??
                    (message.mediaStream ? null : lcmValue(message, topic.type))
                if (!message.mediaStream && decoded && !decoded.bitmap && !decoded.image) {
                    // a replay's frame: decoded here, and a slower older one must not replace a newer one
                    const mine = ++handle.ticket
                    const picture = await framePicture(decoded)
                    if (!picture || mine < handle.newest) {
                        return
                    }
                    handle.newest = mine
                    decoded = { image: picture, width: picture.width, height: picture.height }
                }
                const state = video.get()
                const picture = decoded?.bitmap ?? decoded?.image ?? null
                const width = message.video?.width ?? decoded?.width ?? state.width
                const height = message.video?.height ?? decoded?.height ?? state.height
                const fps = fpsNow(state)
                const stream = message.mediaStream ?? state.stream
                if (
                    stream !== state.stream ||
                    picture !== state.image ||
                    width !== state.width ||
                    height !== state.height ||
                    fps !== state.fps
                ) {
                    video.set({ stream, image: picture, width, height, fps })
                }
            },
        )
    }

    /**
     * Another preset for a color topic: saved for this viewer, and the running subscription takes it in place; a
     * gateway that refuses, or a change back to low-latency rendering, gets a fresh subscription instead.
     */
    setQuality(topic: Topic, quality: string): void {
        writeLocal(this.storageKey, { ...readLocal<Record<string, string>>(this.storageKey, {}), [topic.key]: quality })
        const handle = this.#sources.get(topic.key)
        const previous = handle?.quality.get().quality
        if (!handle || isDepthTopic(topic) || previous === quality) {
            return
        }
        handle.quality.set({ quality })
        const subscription = handle.stop
        const reopen = () => {
            if (handle.stop === subscription && handle.quality.get().quality === quality) {
                subscription()
                this.#open(topic, handle)
            }
        }
        const from = videoPreset(previous)
        const to = videoPreset(quality)
        if (!subscription.update || needsNewReceiver(from.options, to.options)) {
            return reopen()
        }
        subscription.update(videoPresetChanges(from, to)).catch((error) => {
            console.warn(
                `[dimos-react] ${topic.name}: the gateway refused a preset update (${error?.message ?? error})`,
            )
            reopen()
        })
    }

    /** A muted, playing <video> of the stream (not in the document), e.g. for a three.js VideoTexture. */
    element(handle: CameraStreamHandle): HTMLVideoElement {
        if (!handle.element) {
            const element = document.createElement("video")
            element.muted = true
            element.playsInline = true
            element.autoplay = true
            element.setAttribute("disablepictureinpicture", "")
            element.setAttribute("disableremoteplayback", "")
            const attach = () => {
                const stream = handle.video.get().stream
                if (stream && element.srcObject !== stream) {
                    element.srcObject = stream
                    element.play().catch(() => {})
                }
            }
            handle.video.subscribe(attach)
            attach()
            handle.element = element
        }
        return handle.element
    }

    release(topic: Topic): void {
        const handle = this.#sources.get(topic.key)
        if (!handle || --handle.users > 0) {
            return
        }
        handle.stop()
        handle.element?.pause()
        if (handle.element) {
            handle.element.srcObject = null
        }
        this.#sources.delete(topic.key)
    }
}

/** A message's LCM payload decoded as `type` (null when it isn't one). */
function lcmValue(message: Message, type: string) {
    if (!message.bytes || !type) {
        return null
    }
    try {
        return decodeLcm(type, message.bytes)
    } catch {
        return null
    }
}

/** A frame → ImageBitmap (jpeg/png/webp) or ImageData (raw pixels), or null. */
async function framePicture(value: unknown): Promise<ImageBitmap | ImageData | null> {
    const frame = normalizeFrame(value)
    if (!frame || frame.kind === "depth") {
        return null
    }
    if (frame.kind === "encoded") {
        try {
            return await createImageBitmap(new Blob([frame.data], { type: `image/${frame.format}` }))
        } catch {
            return null
        }
    }
    return rawToImageData(frame)
}

const StreamsContext = createContext<CameraStreams | null>(null)
const sharedStreams = new WeakMap<DataSource, CameraStreams>()

/** The shared CameraStreams of a data source (what useCameraStreams gives without a provider; the 3D view's too). */
export function cameraStreamsFor(source: DataSource): CameraStreams {
    let streams = sharedStreams.get(source)
    if (!streams) {
        streams = new CameraStreams(source)
        sharedStreams.set(source, streams)
    }
    return streams
}

export interface CameraStreamsProviderProps {
    streams: CameraStreams
    children?: ReactNode
}

/** Makes `streams` (a CameraStreams, e.g. with the app's own storageKey) the one every CameraView below uses. */
export function CameraStreamsProvider({ streams, children }: CameraStreamsProviderProps) {
    return <StreamsContext.Provider value={streams}>{children}</StreamsContext.Provider>
}

/** The page's CameraStreams for the current data source (the nearest CameraStreamsProvider's, else one per source). */
export function useCameraStreams(): CameraStreams {
    const given = useContext(StreamsContext)
    const source = useDataSource()
    return useMemo(() => {
        return given ?? cameraStreamsFor(source)
    }, [given, source])
}

/** A topic's stream handle while mounted (null topic: none). */
export function useCameraStream(topic: Topic | null | undefined): CameraStreamHandle | null {
    const streams = useCameraStreams()
    const [handle, setHandle] = useState<CameraStreamHandle | null>(null)
    useEffect(() => {
        if (!topic) {
            setHandle(null)
            return
        }
        const acquired = streams.acquire(topic)
        setHandle(acquired)
        return () => streams.release(topic)
    }, [streams, topic?.key])
    return handle
}

const idleStore = new Store<{ quality: string }>({ quality: "balanced" })
/** A color topic's preset as the shared stream has it, and a setter (saved for this viewer). */
export function useVideoQuality(topic: Topic | null | undefined): [string, (next: string) => void] {
    const streams = useCameraStreams()
    const handle = useCameraStream(topic && !isDepthTopic(topic) ? topic : null)
    const { quality } = useStore(handle?.quality ?? idleStore)
    return [quality, (next: string) => topic && streams.setQuality(topic, next)]
}

// ── views ──

/** what a CameraView reports about its picture */
export interface CameraViewInfo {
    width: number
    height: number
    fps: number
    range: [number, number] | null
}

export interface CameraViewProps {
    topic: Topic | null
    /** a 2D detection topic drawn over it */
    overlay?: Pick<Topic, "key" | "type"> | null
    /** crops to cover instead of letterboxing */
    fill?: boolean
    /** null near/far = automatic */
    depthLook?: Partial<DepthLook>
    onInfo?: (info: CameraViewInfo) => void
    className?: string
    children?: ReactNode
}

/**
 * A camera topic's live picture filling its positioned parent. On Desktop's zenoh-gateway a color topic is the
 * gateway's video track (this viewer's latency ↔ quality preset, `useVideoQuality`); a depth topic, or any topic from
 * another source (a replay delivering frames), is drawn by ImageView (depth through a colormap). `overlay`: a 2D
 * detection topic drawn over it; `fill` crops to cover instead of letterboxing; `depthLook` `{ colormap, near, far }`
 * (null near/far = automatic); `onInfo({ width, height, fps, range })`.
 */
export function CameraView({
    topic,
    overlay,
    fill = false,
    depthLook = {},
    onInfo,
    className,
    children,
}: CameraViewProps) {
    const source = useDataSource()
    const depth = topic ? isDepthTopic(topic) : false
    const video = source.kind === "zenoh" && topic && !depth
    if (!topic) {
        return (
            <div className={cx("dr-camera", className)}>
                <div className="dr-camera-empty">no camera</div>
                {children}
            </div>
        )
    }
    if (!video) {
        const prefix = topic.type === "sensor_msgs.CompressedImage" ? "dimos_lcm_compressed_" : "dimos_lcm_"
        return (
            <ImageView
                key={topic.key}
                topic={topic.key}
                encoding={source.kind === "zenoh" ? `${prefix}depth` : undefined}
                maxHz={depth ? 15 : 30}
                depth={depth || undefined}
                colormap={depthLook.colormap ?? "turbo"}
                near={depthLook.near ?? null}
                far={depthLook.far ?? null}
                fit={fill ? "cover" : "contain"}
                overlayTopic={overlay && IMAGE_OVERLAY_TYPES.includes(overlay.type) ? overlay.key : null}
                onInfo={onInfo
                    ? (info) => onInfo({ width: info.width, height: info.height, fps: info.fps, range: info.range })
                    : undefined}
                className={cx("dr-camera", className)}
            >
                {children}
            </ImageView>
        )
    }
    return (
        <VideoView topic={topic} overlay={overlay} fill={fill} onInfo={onInfo} className={className}>
            {children}
        </VideoView>
    )
}

function VideoView({
    topic,
    overlay,
    fill,
    onInfo,
    className,
    children,
}: Omit<CameraViewProps, "topic" | "depthLook"> & { topic: Topic }) {
    const source = useDataSource()
    const handle = useCameraStream(topic)
    const video = useRef<HTMLVideoElement>(null)
    const overlayCanvas = useRef<HTMLCanvasElement>(null)
    const info = useRef<CameraViewInfo>({ width: 0, height: 0, fps: 0, range: null })
    const report = useRef(onInfo)
    report.current = onInfo
    useEffect(() => {
        if (!handle) {
            return
        }
        const apply = () => {
            const state = handle.video.get()
            if (video.current && state.stream && video.current.srcObject !== state.stream) {
                video.current.srcObject = state.stream
                video.current.play().catch(() => {})
            }
            const old = info.current
            if (state.width !== old.width || state.height !== old.height || state.fps !== old.fps) {
                info.current = { width: state.width, height: state.height, fps: state.fps, range: null }
                report.current?.(info.current)
            }
        }
        apply()
        const unsubscribe = handle.video.subscribe(apply)
        return () => {
            unsubscribe()
        }
    }, [handle])
    useEffect(() => {
        const canvas = overlayCanvas.current
        const clear = () => canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height)
        if (!overlay || !canvas || !IMAGE_OVERLAY_TYPES.includes(overlay.type)) {
            clear()
            return
        }
        const off = source.subscribe(overlay.key, { delivery: "latest", maxHz: 30 }, (message) => {
            const width = info.current.width || canvas.width
            const height = info.current.height || canvas.height
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width
                canvas.height = height
            }
            clear()
            try {
                drawDetections2D(canvas.getContext("2d")!, message.value ?? decodeLcm(overlay.type, message.bytes))
            } catch {
                // a message it can't read: blank
            }
        })
        return () => {
            off()
            clear()
        }
    }, [source, overlay?.key])
    return (
        <div className={cx("dr-camera", fill && "dr-camera--fill", className)}>
            <video
                ref={video}
                className="dr-camera-media"
                muted={true}
                playsInline={true}
                autoPlay={true}
                disablePictureInPicture={true}
                disableRemotePlayback={true}
            />
            <canvas ref={overlayCanvas} className="dr-camera-overlay" />
            {children}
        </div>
    )
}

export interface CameraTabsProps<T extends Topic = Topic> {
    topics: T[]
    /** the shown topic key */
    value: string
    onChange: (topic: T) => void
    /** a label for a picked topic that isn't on the bus */
    gone?: string | null
    className?: string
}

/**
 * Tabs for the image topics on the bus (a panel header's camera picker). `value`: the shown topic key; `gone`: a
 * label for a picked topic that isn't on the bus.
 */
export function CameraTabs<T extends Topic>({ topics, value, onChange, gone, className }: CameraTabsProps<T>) {
    const tabs = cameraTabs(topics)
    const row = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const tab = row.current?.querySelector<HTMLElement>("[aria-selected=true]")
        const element = row.current
        if (
            tab &&
            element &&
            (tab.offsetLeft < element.scrollLeft ||
                tab.offsetLeft + tab.offsetWidth > element.scrollLeft + element.clientWidth)
        ) {
            element.scrollLeft = tab.offsetLeft - 6
        }
    }, [value, topics.length])
    return (
        <div
            ref={row}
            className={cx("dr-camera-tabs", className)}
            role="tablist"
            aria-label="Cameras"
            onWheel={(event) => (event.currentTarget.scrollLeft += event.deltaY)}
        >
            {gone
                ? (
                    <span className="dr-camera-tab dr-camera-tab--gone" title={gone}>
                        {gone}
                    </span>
                )
                : null}
            {tabs.map((tab) => (
                <button
                    key={tab.topic.key}
                    type="button"
                    role="tab"
                    aria-selected={tab.topic.key === value}
                    className={cx("dr-camera-tab", tab.depth && "dr-camera-tab--depth")}
                    title={`${tab.topic.name} (${tab.topic.type})`}
                    onClick={() => onChange(tab.topic)}
                >
                    {tab.label}
                </button>
            ))}
            {!tabs.length && !gone
                ? <span className="dr-camera-tab dr-camera-tab--gone">no camera on the bus</span>
                : null}
        </div>
    )
}
