// Camera streams, shared: a panel and the 3D projection of the same topic use one bridge subscription (full while a
// panel shows it, a small slow preview while only the 3D view does).
// Color images arrive as the bridge's H.264 track, sized and paced by the viewer's latency/quality preset (core/videoQuality.ts); depth arrives lossless as fields (16UC1 mm / 32FC1 m).
import { Store } from "./store.ts"
import { PRIORITY_TIERS } from "./bandwidth.ts"
import { type Connection, type LiveHandle, parseKey, type SubscribeOptions, type SubscriptionUpdate, type Topic } from "./transport.ts"
import { loadQuality, presetFor, saveQuality, type VideoQuality } from "./videoQuality.ts"
import { VIDEO_LATENCY_WINDOW_MS, type VideoLatency } from "./videoLatency.ts"

export interface VideoState {
    stream: MediaStream | null
    width: number
    height: number
    /** frames per second the bridge is sending */
    fps: number
}

export interface DepthImage {
    width: number
    height: number
    encoding: string
    data: Uint16Array | Float32Array | Uint8Array
}

export const isDepthTopic = (topic: Topic) => /depth/i.test(topic.name)

/**
 * Whether a camera panel holds its stream: only while it's on screen. Collapsed (minimized), off screen (a shut
 * drawer, a rail hidden by focus) or in a hidden browser tab it lets go, so the gateway stops sending it (a 3D
 * projection of the same topic keeps its own preview subscription).
 */
export function panelStreams(slot: { hidden: boolean; collapsed: boolean } | undefined, pageHidden: boolean): boolean {
    return !!slot && !slot.hidden && !slot.collapsed && !pageHidden
}

/** whether the browser tab is hidden (another tab, minimized window), kept current */
export const pageVisibility = new Store<{ hidden: boolean }>({ hidden: typeof document !== "undefined" && document.hidden })
if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => pageVisibility.set({ hidden: document.hidden }))
}

/**
 * Who uses a stream: a camera panel that's on screen ("view": the viewer's quality preset) or only the 3D view's
 * projection ("preview": small and slow, PREVIEW_OPTIONS). One subscription per topic either way: a 3D projection of a
 * camera whose panel is open rides the panel's stream.
 */
export type StreamUse = "view" | "preview"

/** what the 3D view alone subscribes with: a small picture a few times a second */
export const PREVIEW_OPTIONS: SubscribeOptions = { maxResolution: [320, 240], maxHz: 3, qualityToHzTradeoff: 1 }
export const DEPTH_OPTIONS: SubscribeOptions = { maxHz: 15 }
export const DEPTH_PREVIEW_OPTIONS: SubscribeOptions = { maxHz: 3 }

/**
 * The options a stream runs with for its users now: any panel on screen → the full stream, else the 3D preview. The
 * main view's camera keeps the default bandwidth priority, other cameras and depth yield before it (core/bandwidth.ts).
 */
export function streamOptions(depth: boolean, uses: Record<StreamUse, number>, quality: VideoQuality, main = false): SubscribeOptions {
    const viewed = uses.view > 0
    if (depth) {
        return { ...(viewed ? DEPTH_OPTIONS : DEPTH_PREVIEW_OPTIONS), bandwidthPriority: PRIORITY_TIERS.bulk }
    }
    return { ...(viewed ? presetFor(quality).options : PREVIEW_OPTIONS), bandwidthPriority: main ? PRIORITY_TIERS.viewed : PRIORITY_TIERS.background }
}

/** What `Subscription.update` needs to go from one set of options to another (null for what only `from` set). */
export function optionChanges(from: SubscribeOptions, to: SubscribeOptions): SubscriptionUpdate {
    const changes: Record<string, unknown> = {}
    for (const name of Object.keys(from)) {
        changes[name] = null
    }
    return { ...changes, ...to } as SubscriptionUpdate
}

/** Whether options keep the browser in low-latency rendering (playoutDelay min 0, max <= 500 ms; the default [0, 0]). */
export function lowLatencyRendering(options: SubscribeOptions): boolean {
    const [min, max] = options.playoutDelay ?? [0, 0]
    return min === 0 && max <= 500
}

/**
 * Whether a change can't be made in place: back to low-latency rendering from a buffered playout (High quality's
 * playoutDelay [100, 400] → any other preset). Firefox stops showing a receiver's frames for good once their render
 * time drops back to 0 (they decode, the picture stays frozen), so that change takes a new subscription (a fresh
 * receiver); zenoh-gateway >= 0.5.3 never sends it on a running track either (it sends [10, 10] ms there).
 */
export function needsNewReceiver(from: SubscribeOptions, to: SubscribeOptions): boolean {
    return !lowLatencyRendering(from) && lowLatencyRendering(to)
}

interface Source {
    uses: Record<StreamUse, number>
    /** the options the bridge subscription runs with now */
    options: SubscribeOptions
    /** the bridge subscription: calling it stops it, `update` changes its options in place */
    stop: (() => void) & Partial<Pick<LiveHandle, "update" | "watchVideoLatency" | "videoLatency">>
    /** camera panels' <video> elements timing its frames (core/videoLatency.ts), each with what stops it on the running subscription */
    watched: Map<HTMLVideoElement, () => void>
    video: Store<VideoState>
    depth: Store<{ image: DepthImage | null }>
    /** this viewer's latency/quality preset (core/videoQuality.ts): the bridge's size / bitrate / rate while viewed */
    quality: Store<{ quality: VideoQuality }>
    /** a playing element for textures (the 3D projection), made on first use */
    element: HTMLVideoElement | null
}

export class VideoSources {
    #sources = new Map<string, Source>()
    constructor(readonly connection: Connection) {}

    /** A stream of `topic` for a panel on screen ("view") or the 3D view's projection ("preview"); release it the same way. */
    acquire(topic: Topic, use: StreamUse = "view"): Source {
        let source = this.#sources.get(topic.key)
        if (source) {
            source.uses[use]++
            this.#retune(topic, source)
            return source
        }
        const video = new Store<VideoState>({ stream: null, width: 0, height: 0, fps: 0 })
        const depth = new Store<{ image: DepthImage | null }>({ image: null })
        const quality = new Store<{ quality: VideoQuality }>({ quality: isDepthTopic(topic) ? "balanced" : loadQuality(topic.key) })
        source = { uses: { view: 0, preview: 0 }, options: {}, stop: () => {}, watched: new Map(), video, depth, quality, element: null }
        source.uses[use] = 1
        source.options = this.#wanted(topic, source)
        this.#open(topic, source)
        this.#sources.set(topic.key, source)
        return source
    }

    #wanted(topic: Topic, source: Source): SubscribeOptions {
        return streamOptions(isDepthTopic(topic), source.uses, source.quality.get().quality, topic.key === this.#main)
    }

    #main: string | null = null

    /** The camera in the main view (its key, or null): it keeps the default priority, the others yield first. */
    setMain(key: string | null) {
        if (key === this.#main) {
            return
        }
        const before = this.#main
        this.#main = key
        for (const changed of [before, key]) {
            const source = changed === null ? undefined : this.#sources.get(changed)
            const topic = changed === null ? null : parseKey(changed)
            if (source && topic) {
                this.#retune(topic, source)
            }
        }
    }

    /** Subscribes with the source's options: the color track, or the lossless depth encoding. */
    #open(topic: Topic, source: Source) {
        const { video, depth } = source
        const prefix = topic.type === "sensor_msgs.CompressedImage" ? "dimos_lcm_compressed_" : "dimos_lcm_"
        let frames = 0
        let since = performance.now()
        source.stop = isDepthTopic(topic)
            ? this.connection.subscribe(topic.key, { delivery: "latest", ...source.options, encoding: `${prefix}depth` }, (message) => {
                if (message.decoded) {
                    depth.set({ image: message.decoded as DepthImage })
                }
            })
            : this.connection.subscribe(topic.key, { delivery: "latest", ...source.options, encoding: `${prefix}image` }, (message) => {
                frames++
                const now = performance.now()
                const state = video.get()
                const width = message.video?.width ?? state.width
                const height = message.video?.height ?? state.height
                let fps = state.fps
                if (now - since > 1000) {
                    fps = Math.round((frames * 1000) / (now - since))
                    frames = 0
                    since = now
                }
                if (message.mediaStream !== state.stream || width !== state.width || height !== state.height || fps !== state.fps) {
                    video.set({ stream: message.mediaStream ?? state.stream, width, height, fps })
                }
            })
        for (const element of source.watched.keys()) {
            source.watched.set(element, source.stop.watchVideoLatency?.(element) ?? (() => {}))
        }
    }

    /** Times the frames a camera panel's <video> shows of `topic`'s stream (kept across resubscribes); call the result to stop. */
    watchLatency(topic: Topic, element: HTMLVideoElement): () => void {
        const source = this.#sources.get(topic.key)
        if (!source || isDepthTopic(topic)) {
            return () => {}
        }
        source.watched.get(element)?.()
        source.watched.set(element, source.stop.watchVideoLatency?.(element) ?? (() => {}))
        return () => {
            source.watched.get(element)?.()
            source.watched.delete(element)
        }
    }

    /** A camera's latency over the last few seconds of frames its panel showed; null before any (or an older gateway). */
    latency(key: string): VideoLatency | null {
        const source = this.#sources.get(key)
        return source?.watched.size ? source.stop.videoLatency?.(VIDEO_LATENCY_WINDOW_MS) ?? null : null
    }

    /** Every camera a panel is timing, by key. */
    latencies(): Record<string, VideoLatency | null> {
        return Object.fromEntries([...this.#sources.keys()].filter((key) => this.#sources.get(key)!.watched.size).map((key) => [key, this.latency(key)]))
    }

    /**
     * The running subscription takes the options its users want now (a panel opened or closed over a 3D projection, a
     * new preset) in place (zenoh-gateway 0.5.1's update: same track, no resubscribe, so no gap); a gateway that refuses
     * the update, or a change back to low-latency rendering (needsNewReceiver), gets a new subscription instead (closed,
     * then reopened: a fresh transceiver).
     */
    #retune(topic: Topic, source: Source) {
        const previous = source.options
        const wanted = this.#wanted(topic, source)
        if (JSON.stringify(previous) === JSON.stringify(wanted)) {
            return
        }
        source.options = wanted
        const subscription = source.stop
        const reopen = () => {
            if (source.stop === subscription && source.options === wanted) {
                subscription()
                this.#open(topic, source)
            }
        }
        if (!subscription.update || needsNewReceiver(previous, wanted)) {
            return reopen()
        }
        subscription.update(optionChanges(previous, wanted)).catch((error) => {
            console.warn(`[cameras] ${topic.name}: the gateway refused an update (${error?.message ?? error}); resubscribing`)
            reopen()
        })
    }

    /** Another quality preset for a color topic: saved for this viewer; a viewed stream takes it now, a preview when viewed. */
    setQuality(topic: Topic, quality: VideoQuality) {
        saveQuality(topic.key, quality)
        const source = this.#sources.get(topic.key)
        if (!source || isDepthTopic(topic) || source.quality.get().quality === quality) {
            return
        }
        source.quality.set({ quality })
        this.#retune(topic, source)
    }

    /** A muted, playing <video> of the stream (not in the document), for VideoTexture. */
    element(source: Source): HTMLVideoElement {
        if (!source.element) {
            const element = document.createElement("video")
            element.muted = true
            element.playsInline = true
            element.autoplay = true
            // attributes, not properties: Firefox honors the attribute but has no disablePictureInPicture property
            element.setAttribute("disablepictureinpicture", "")
            element.setAttribute("disableremoteplayback", "")
            const attach = () => {
                const stream = source.video.get().stream
                if (stream && element.srcObject !== stream) {
                    element.srcObject = stream
                    element.play().catch(() => {})
                }
            }
            source.video.subscribe(attach)
            attach()
            source.element = element
        }
        return source.element
    }

    release(topic: Topic, use: StreamUse = "view") {
        const source = this.#sources.get(topic.key)
        if (!source || source.uses[use] <= 0) {
            return
        }
        source.uses[use]--
        if (source.uses.view + source.uses.preview > 0) {
            this.#retune(topic, source)
            return
        }
        source.stop()
        source.element?.pause()
        if (source.element) {
            source.element.srcObject = null
        }
        this.#sources.delete(topic.key)
    }
}

/** The CameraInfo topic for an image topic: the one sharing the longest leading part of the name. */
export function cameraInfoFor(image: Topic, topics: Topic[], overrides: Record<string, string> = {}): Topic | null {
    const infos = topics.filter((topic) => topic.type === "sensor_msgs.CameraInfo")
    const wanted = overrides[image.name]
    if (wanted) {
        return infos.find((topic) => topic.name === wanted) ?? null
    }
    const parts = image.name.split("/")
    let best: Topic | null = null
    let bestScore = -1
    for (const info of infos) {
        const other = info.name.split("/")
        let shared = 0
        while (shared < Math.min(parts.length, other.length) - 1 && parts[shared] === other[shared]) {
            shared++
        }
        // "color" in both names breaks ties (color_image ↔ color_camera_info over depth_camera_info)
        const score = shared * 10 + (/color|rgb/i.test(image.name) === /color|rgb/i.test(info.name) ? 1 : 0)
        if (score > bestScore) {
            best = info
            bestScore = score
        }
    }
    return best
}
