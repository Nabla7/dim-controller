// Media: a camera / image view (any image topic, or frames you pass) and a playback bar for recordings (play, speed,
// loop, a zoomable scrubber, and a lane per stream with a tick per message).
import { useEffect, useRef, useState } from "react"
import type {
    ComponentProps,
    CSSProperties,
    HTMLAttributes,
    PointerEvent as ReactPointerEvent,
    ReactNode,
    WheelEvent as ReactWheelEvent,
} from "react"
import { cx } from "../cx.ts"
import { Icon } from "./icon.tsx"
import { IconButton, Select } from "./controls.tsx"
import { Menu } from "./nav.tsx"
import { decodeMessage, parseKey, useDataSource } from "../data.ts"
import type { Message } from "../data.ts"
import { sampleGradient } from "../colormaps.ts"
import { themeColors } from "../theme/theme.ts"

// ── ImageView ──

export const DEPTH_COLORMAPS = ["turbo", "magma", "plasma", "memworld", "viridis", "grayscale"]

/** Raw depth units → meters: 32FC1 is meters, 16UC1 (and mono16) millimetres. */
export const depthScale = (encoding: string): number => (encoding === "32FC1" ? 1 : 0.001)

/** raw pixels: an image or a depth image */
export interface RawFrame {
    kind: "image" | "depth"
    width: number
    height: number
    encoding: string
    /** bytes per row (0 / missing: packed) */
    step?: number
    data: Uint8Array
    frame?: string
}

/** a jpeg / png / webp image */
export interface EncodedFrame {
    kind: "encoded"
    format: string
    data: Uint8Array<ArrayBuffer>
    frame?: string
}

export type NormalizedFrame = RawFrame | EncodedFrame

/** what an ImageView reports about what it shows */
export interface ImageInfo {
    width: number
    height: number
    fps: number
    /** "full", or the gateway's quality score for a degraded frame */
    quality: string | number
    depth: boolean
    range: [number, number] | null
}

const RAW_BYTES: Record<string, number> = { mono8: 1, "8uc1": 1, rgb8: 3, bgr8: 3, rgba8: 4, bgra8: 4 }

/**
 * A frame (whatever form it arrives in) → `{ kind: "image" | "depth", width, height, encoding, data }`, or an
 * `{ kind: "encoded", format, data }` for jpeg/png/webp. Takes a pre-decoded frame (a replay's), a decoded
 * sensor_msgs.Image or sensor_msgs.CompressedImage.
 */
// deno-lint-ignore no-explicit-any -- a decoded message or a source's frame: any shape
export function normalizeFrame(value: any): NormalizedFrame | null {
    if (!value) {
        return null
    }
    if (value.kind === "image" || value.kind === "depth") {
        if (["jpeg", "png", "webp"].includes(value.encoding)) {
            return { kind: "encoded", format: value.encoding, data: value.data, frame: value.frame }
        }
        return value
    }
    if (value.format !== undefined && value.data) {
        const format = /png/i.test(value.format) ? "png" : /webp/i.test(value.format) ? "webp" : "jpeg"
        return { kind: "encoded", format, data: value.data, frame: value.header?.frame_id }
    }
    if (value.encoding !== undefined && value.data) {
        const depth = ["16UC1", "32FC1", "mono16"].includes(value.encoding)
        return {
            kind: depth ? "depth" : "image",
            width: value.width,
            height: value.height,
            encoding: value.encoding,
            step: value.step,
            data: value.data,
            frame: value.header?.frame_id,
        }
    }
    return null
}

/** Raw pixels → RGBA ImageData (null for an encoding it can't read). */
export function rawToImageData(frame: RawFrame): ImageData | null {
    const { width, height, data } = frame
    const bpp = RAW_BYTES[frame.encoding] ?? 0
    if (!width || !height || !bpp) {
        return null
    }
    const out = new ImageData(width, height)
    const pixels = out.data
    const stride = frame.step || Math.floor(data.byteLength / height)
    const bgr = frame.encoding.startsWith("bgr")
    for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
            const at = row * stride + column * bpp
            const o = (row * width + column) * 4
            if (bpp === 1) {
                pixels[o] = pixels[o + 1] = pixels[o + 2] = data[at]
            } else {
                pixels[o] = data[at + (bgr ? 2 : 0)]
                pixels[o + 1] = data[at + 1]
                pixels[o + 2] = data[at + (bgr ? 0 : 2)]
            }
            pixels[o + 3] = 255
        }
    }
    return out
}

/** The depth values of a depth frame as numbers (meters after `depthScale`). */
function depthValues(frame: RawFrame): Float32Array | Uint16Array {
    const bytes = frame.data
    const copy = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice()
    return frame.encoding === "32FC1"
        ? new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
        : new Uint16Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 2))
}

/**
 * A depth frame → colormapped ImageData (near = the ramp's end, far = its start; no return = transparent), and the
 * range it used: `near`/`far` in meters, or null for automatic (2nd–98th percentile, eased by `previous`).
 */
export function colorizeDepth(
    frame: RawFrame,
    {
        colormap = "turbo",
        near = null,
        far = null,
        previous = null,
    }: {
        colormap?: string
        near?: number | null
        far?: number | null
        previous?: [number, number] | null
    } = {},
): { image: ImageData; range: [number, number] } {
    const values = depthValues(frame)
    const scale = depthScale(frame.encoding)
    let range: [number, number] = [near ?? 0, far ?? 1]
    if (near === null || far === null) {
        const step = Math.max(1, Math.floor(values.length / 4096))
        const samples: number[] = []
        for (let index = 0; index < values.length; index += step) {
            const value = values[index]
            if (value > 0 && Number.isFinite(value)) {
                samples.push(value * scale)
            }
        }
        if (samples.length) {
            samples.sort((a, b) => a - b)
            const low = samples[Math.floor(samples.length * 0.02)]
            const high = samples[Math.floor(samples.length * 0.98)]
            range = previous
                ? [previous[0] + (low - previous[0]) * 0.2, previous[1] + (high - previous[1]) * 0.2]
                : [low, high]
        }
        range = [near ?? range[0], far ?? range[1]]
    }
    const lut = new Uint8Array(256 * 3)
    for (let index = 0; index < 256; index++) {
        const [r, g, b] = sampleGradient(colormap, 1 - index / 255)
        lut[index * 3] = r
        lut[index * 3 + 1] = g
        lut[index * 3 + 2] = b
    }
    const { width, height } = frame
    const out = new ImageData(width, height)
    const pixels = out.data
    const span = Math.max(1e-6, range[1] - range[0])
    const count = Math.min(width * height, values.length)
    for (let index = 0; index < count; index++) {
        const value = values[index]
        if (!(value > 0) || !Number.isFinite(value)) {
            continue
        }
        const slot = Math.round(Math.min(1, Math.max(0, (value * scale - range[0]) / span)) * 255) * 3
        const o = index * 4
        pixels[o] = lut[slot]
        pixels[o + 1] = lut[slot + 1]
        pixels[o + 2] = lut[slot + 2]
        pixels[o + 3] = 255
    }
    return { image: out, range }
}

/** A stable, distinct color per name (HSL), for boxes of one class. */
function nameColor(name: unknown) {
    let hash = 0
    for (const char of String(name)) {
        hash = (hash * 31 + char.charCodeAt(0)) | 0
    }
    return `hsl(${(hash >>> 0) % 360} 75% 60%)`
}

/** vision_msgs.Detection2DArray / Detection2D / BoundingBox2DArray drawn over an image (pixel coordinates). */
// deno-lint-ignore no-explicit-any -- a decoded vision_msgs message
export function drawDetections2D(context: CanvasRenderingContext2D, message: any): void {
    const boxes = message?.detections ?? message?.boxes?.map((bbox: unknown) => ({ bbox })) ?? [message]
    const theme = themeColors()
    context.lineWidth = Math.max(2, context.canvas.width / 400)
    context.font = `${Math.max(12, context.canvas.width / 60)}px ${theme.sans || "sans-serif"}`
    context.textBaseline = "bottom"
    for (const detection of boxes) {
        const box = detection?.bbox ?? {}
        const center = box.center?.position ?? box.center ?? { x: 0, y: 0 }
        const left = center.x - (box.size_x ?? 0) / 2
        const top = center.y - (box.size_y ?? 0) / 2
        const best = [...(detection?.results ?? [])].sort(
            // deno-lint-ignore no-explicit-any -- decoded ObjectHypothesisWithPose
            (a: any, b: any) => (b.hypothesis?.score ?? 0) - (a.hypothesis?.score ?? 0),
        )[0]
        const name = best?.hypothesis?.class_id || detection?.id || ""
        const color = nameColor(name || "box")
        context.strokeStyle = color
        context.strokeRect(left, top, box.size_x ?? 0, box.size_y ?? 0)
        if (name) {
            const text = best?.hypothesis?.score !== undefined
                ? `${name} ${(best.hypothesis.score * 100).toFixed(0)}%`
                : name
            const width = context.measureText(text).width + 8
            const height = parseFloat(context.font) + 4
            context.fillStyle = color
            context.fillRect(left, top - height, width, height)
            context.fillStyle = theme.bg || "black"
            context.fillText(text, left + 4, top - 2)
        }
    }
}

/** Message types an ImageView can draw over its image. */
export const IMAGE_OVERLAY_TYPES = [
    "vision_msgs.Detection2DArray",
    "vision_msgs.Detection2D",
    "vision_msgs.BoundingBox2DArray",
]

export interface ImageViewProps extends HTMLAttributes<HTMLDivElement> {
    topic?: string | null
    /** a frame to show instead of a topic's (any form normalizeFrame takes) */
    frame?: unknown
    /** the subscription encoding a source may deliver frames in (e.g. a replay's "dimos_lcm_image") */
    encoding?: string
    maxHz?: number
    /** force depth (default: by encoding) */
    depth?: boolean
    colormap?: string
    near?: number | null
    far?: number | null
    fit?: "contain" | "cover"
    overlayTopic?: string | null
    onInfo?: (info: ImageInfo) => void
    className?: string
    style?: CSSProperties
    /** laid over the image */
    children?: ReactNode
}

/**
 * A camera / image view: the latest frame of an image topic (sensor_msgs.Image, CompressedImage, or a source's
 * pre-decoded frames), or `frame` as a prop. Depth images (16UC1 / 32FC1) are drawn through a colormap.
 */
export function ImageView({
    topic,
    frame,
    encoding,
    maxHz = 30,
    depth,
    colormap = "turbo",
    near = null,
    far = null,
    fit = "contain",
    overlayTopic,
    onInfo,
    className,
    style,
    children,
    ...rest
}: ImageViewProps) {
    const source = useDataSource()
    const canvas = useRef<HTMLCanvasElement>(null)
    const overlay = useRef<HTMLCanvasElement>(null)
    const state = useRef<{
        ticket: number
        newest: number
        frames: number
        since: number
        fps: number
        range: [number, number] | null
        info: string
    }>({ ticket: 0, newest: 0, frames: 0, since: 0, fps: 0, range: null, info: "" })
    const settings = useRef<Pick<ImageViewProps, "depth" | "colormap" | "near" | "far" | "onInfo">>({})
    settings.current = { depth, colormap, near, far, onInfo }
    const lastDepth = useRef<{ frame: RawFrame; quality: string | number } | null>(null)
    const [empty, setEmpty] = useState(true)

    const report = (width: number, height: number, quality: string | number, isDepth: boolean) => {
        const s = state.current
        s.frames++
        const now = performance.now()
        if (!s.since) {
            s.since = now
        } else if (now - s.since > 1000) {
            s.fps = Math.round((s.frames * 1000) / (now - s.since))
            s.frames = 0
            s.since = now
        }
        const info: ImageInfo = { width, height, fps: s.fps, quality, depth: isDepth, range: isDepth ? s.range : null }
        const signature = JSON.stringify(info)
        if (signature !== s.info) {
            s.info = signature
            settings.current.onInfo?.(info)
        }
    }

    const show = async (value: unknown, quality: string | number = "full") => {
        const element = canvas.current
        const normalized = normalizeFrame(value)
        if (!element || !normalized) {
            return
        }
        const s = state.current
        const mine = ++s.ticket
        const { depth: forceDepth, colormap, near, far } = settings.current
        let drawable: ImageBitmap | ImageData | null
        let isDepth = false
        if (normalized.kind === "encoded") {
            try {
                drawable = await createImageBitmap(new Blob([normalized.data], { type: `image/${normalized.format}` }))
            } catch {
                return
            }
        } else if (normalized.kind === "depth" || forceDepth) {
            isDepth = true
            lastDepth.current = { frame: normalized, quality }
            const result = colorizeDepth(normalized, { colormap, near, far, previous: s.range })
            s.range = result.range
            drawable = result.image
        } else {
            drawable = rawToImageData(normalized)
        }
        if (!drawable || mine < s.newest) {
            if (drawable && "close" in drawable) {
                drawable.close?.()
            }
            return
        }
        s.newest = mine
        if (element.width !== drawable.width || element.height !== drawable.height) {
            element.width = drawable.width
            element.height = drawable.height
        }
        const context = element.getContext("2d")!
        if (drawable instanceof ImageData) {
            context.putImageData(drawable, 0, 0)
        } else {
            context.drawImage(drawable, 0, 0)
            drawable.close?.()
        }
        element.dataset.quality = String(quality)
        setEmpty(false)
        report(element.width, element.height, quality, isDepth)
    }

    // a new colormap / range redraws the depth frame on show
    useEffect(() => {
        if (lastDepth.current) {
            show(lastDepth.current.frame, lastDepth.current.quality)
        }
    }, [colormap, near, far])

    useEffect(() => {
        if (frame) {
            show(frame)
        }
    }, [frame])

    useEffect(() => {
        if (!topic) {
            return
        }
        setEmpty(true)
        state.current.range = null
        const type = parseKey(topic)?.type
        const off = source.subscribe(
            topic,
            { delivery: "latest", maxHz, ...(encoding ? { encoding } : {}) },
            (message) => {
                let value
                try {
                    value = decodeMessage(message, "auto", type)
                } catch {
                    return
                }
                show(value, (message as Message & { quality?: number }).quality ?? "full")
            },
        )
        return () => off()
    }, [source, topic, encoding, maxHz])

    useEffect(() => {
        const element = overlay.current
        const clear = () => element?.getContext("2d")?.clearRect(0, 0, element.width, element.height)
        if (!overlayTopic || !element) {
            clear()
            return
        }
        const type = parseKey(overlayTopic)?.type
        const off = source.subscribe(overlayTopic, { delivery: "latest", maxHz: 30 }, (message) => {
            let value
            try {
                value = decodeMessage(message, "auto", type)
            } catch {
                return
            }
            const image = canvas.current
            const width = image?.width || element.width
            const height = image?.height || element.height
            if (element.width !== width || element.height !== height) {
                element.width = width
                element.height = height
            }
            clear()
            drawDetections2D(element.getContext("2d")!, value)
        })
        return () => {
            off()
            clear()
        }
    }, [source, overlayTopic])

    return (
        <div
            className={cx("dr-image", `dr-image--${fit}`, empty && "dr-image--empty", className)}
            style={style}
            {...rest}
        >
            <canvas ref={canvas} className="dr-image__media" />
            <canvas ref={overlay} className="dr-image__media dr-image__overlay" />
            {empty
                ? (
                    <div className="dr-image__waiting">
                        <Icon name="camera" size={22} />
                    </div>
                )
                : null}
            {children}
        </div>
    )
}

// ── PlaybackBar ──

/** 83.4 → "1:23.4"; over an hour "1:02:03". */
export function playbackClock(seconds: number): string {
    const sign = seconds < 0 ? "-" : ""
    const value = Math.abs(seconds)
    const hours = Math.floor(value / 3600)
    const minutes = Math.floor((value % 3600) / 60)
    const rest = value % 60
    if (hours) {
        return `${sign}${hours}:${String(minutes).padStart(2, "0")}:${String(Math.floor(rest)).padStart(2, "0")}`
    }
    return `${sign}${minutes}:${rest.toFixed(1).padStart(4, "0")}`
}

/** One lane's ticks: exact `times`, or `counts` per slice of the shown window (denser = stronger). */
/** a lane's ticks: exact message `times`, or `counts` per slice of the shown window */
export interface LaneTickData {
    times?: number[]
    counts?: number[]
}

/** the shown window of a recording's time axis (s) */
export interface PlaybackView {
    from: number
    to: number
}

/** a PlaybackBar row: one stream */
export interface PlaybackLane {
    id: string
    label: ReactNode
    title?: string
    meta?: ReactNode
    count?: ReactNode
    leading?: ReactNode
    menu?: ComponentProps<typeof Menu>["items"]
    active?: boolean
    busy?: boolean
    ticks?: LaneTickData | null
}

function LaneTicks({ ticks, view }: { ticks?: LaneTickData | null; view: PlaybackView }) {
    const canvas = useRef<HTMLCanvasElement>(null)
    useEffect(() => {
        const element = canvas.current
        if (!element) {
            return
        }
        const draw = () => {
            const ratio = globalThis.devicePixelRatio || 1
            const width = Math.max(1, Math.round(element.clientWidth * ratio))
            const height = Math.max(1, Math.round(element.clientHeight * ratio))
            element.width = width
            element.height = height
            const context = element.getContext("2d")!
            context.clearRect(0, 0, width, height)
            if (!ticks) {
                return
            }
            context.fillStyle = getComputedStyle(element).color
            const range = Math.max(1e-9, view.to - view.from)
            if (ticks.times) {
                context.globalAlpha = 0.9
                for (const t of ticks.times) {
                    if (t >= view.from && t <= view.to) {
                        context.fillRect(
                            Math.round(((t - view.from) / range) * width),
                            height * 0.2,
                            ratio,
                            height * 0.6,
                        )
                    }
                }
            } else if (ticks.counts?.length) {
                const most = Math.max(1, ...ticks.counts)
                const slice = width / ticks.counts.length
                ticks.counts.forEach((count, bin) => {
                    if (count) {
                        context.globalAlpha = 0.35 + 0.65 * Math.min(1, count / most)
                        context.fillRect(
                            Math.floor(bin * slice),
                            height * 0.2,
                            Math.max(ratio, Math.ceil(slice)),
                            height * 0.6,
                        )
                    }
                })
            }
            context.globalAlpha = 1
        }
        draw()
        const observer = new ResizeObserver(draw)
        observer.observe(element)
        return () => observer.disconnect()
    }, [ticks, view.from, view.to])
    return <canvas ref={canvas} className="dr-playback__ticks" />
}

/** PlaybackBar's props; times in seconds */
export interface PlaybackBarProps extends HTMLAttributes<HTMLElement> {
    start: number
    end: number
    value: number
    playing?: boolean
    onPlayPause?: (playing: boolean) => void
    onSeek?: (t: number) => void
    onScrubStart?: () => void
    onScrubEnd?: () => void
    scrubbing?: boolean
    speed?: number
    speeds?: number[]
    onSpeedChange?: (speed: number) => void
    loop?: boolean
    onLoopChange?: (loop: boolean) => void
    format?: (t: number) => string
    lanes?: PlaybackLane[]
    lanesLabel?: string
    expanded?: boolean
    onExpandedChange?: (expanded: boolean) => void
    view?: PlaybackView
    onViewChange?: (view: PlaybackView) => void
    /** space plays / pauses, ← / → step 1 s (shift 10 s), Home / End, page-wide (not while typing) */
    keyboard?: boolean
    /** extra elements after the built-in ones */
    controls?: ReactNode
    className?: string
    style?: CSSProperties
}

/**
 * A recording player's bar: play / pause, the time, speed, loop, a scrubber that zooms (ctrl/⌘ + wheel; any wheel
 * over the lanes) and pans (horizontal scroll), and, expanded, a lane per stream with a tick per message on the same
 * axis. Dragging anywhere on the axis scrubs: `onScrubStart`, `onSeek(t)` per move, `onScrubEnd`.
 */
export function PlaybackBar({
    start,
    end,
    value,
    playing = false,
    onPlayPause,
    onSeek,
    onScrubStart,
    onScrubEnd,
    scrubbing = false,
    speed,
    speeds = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16],
    onSpeedChange,
    loop,
    onLoopChange,
    format,
    lanes,
    lanesLabel = "Streams",
    expanded = false,
    onExpandedChange,
    view: givenView,
    onViewChange,
    keyboard = false,
    controls,
    className,
    style,
    ...rest
}: PlaybackBarProps) {
    const [innerView, setInnerView] = useState<PlaybackView>({ from: start, to: end })
    const view = givenView ?? innerView
    const setView = (next: PlaybackView) => {
        if (!givenView) {
            setInnerView(next)
        }
        onViewChange?.(next)
    }
    useEffect(() => {
        if (!givenView) {
            setInnerView({ from: start, to: end })
        }
    }, [start, end])
    const show = format ?? ((t: number) => playbackClock(t - start))
    const span = Math.max(1e-6, end - start)
    const zoomed = view.from > start + 1e-6 || view.to < end - 1e-6
    const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
    const endScrub = useRef<(() => void) | null>(null)
    const latest = useRef<
        Pick<
            PlaybackBarProps,
            "value" | "playing" | "onSeek" | "onPlayPause" | "onScrubStart" | "onScrubEnd" | "start" | "end"
        >
    >({ value, playing, onSeek, onPlayPause, onScrubStart, onScrubEnd, start, end })
    latest.current = { value, playing, onSeek, onPlayPause, onScrubStart, onScrubEnd, start, end }
    useEffect(() => () => endScrub.current?.(), [])

    useEffect(() => {
        if (!keyboard) {
            return
        }
        const typing = (target: EventTarget | null) =>
            (target as Element | null)?.closest?.("input, select, textarea, [contenteditable]")
        const onKey = (event: KeyboardEvent) => {
            if (typing(event.target) || event.metaKey || event.ctrlKey) {
                return
            }
            const { value, playing, onSeek, onPlayPause, start, end } = latest.current
            if (event.code === "Space") {
                event.preventDefault()
                onPlayPause?.(!playing)
            } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault()
                const step = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1)
                onSeek?.(Math.min(end, Math.max(start, value + step)))
            } else if (event.key === "Home") {
                onSeek?.(start)
            } else if (event.key === "End") {
                onSeek?.(end)
            }
        }
        // a focused button would also take the space as a click (on keyup): space is play / pause only
        const onKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space" && !typing(event.target)) {
                event.preventDefault()
            }
        }
        addEventListener("keydown", onKey)
        addEventListener("keyup", onKeyUp)
        return () => {
            removeEventListener("keydown", onKey)
            removeEventListener("keyup", onKeyUp)
        }
    }, [keyboard])

    const timeAt = (lane: HTMLElement, clientX: number) => {
        const box = lane.getBoundingClientRect()
        const fraction = Math.min(1, Math.max(0, (clientX - box.left) / Math.max(1, box.width)))
        return view.from + fraction * (view.to - view.from)
    }
    const axis = (zoomAlways: boolean) => ({
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.button !== 0 || !onSeek) {
                return
            }
            endScrub.current?.()
            const lane = event.currentTarget
            try {
                lane.setPointerCapture(event.pointerId)
            } catch {
                // a press forwarded from another frame: not this page's pointer; the window listeners below follow it
            }
            latest.current.onScrubStart?.()
            latest.current.onSeek?.(timeAt(lane, event.clientX))
            const move = (moved: PointerEvent) => latest.current.onSeek?.(timeAt(lane, moved.clientX))
            const stop = () => {
                endScrub.current = null
                removeEventListener("pointermove", move)
                removeEventListener("pointerup", stop)
                removeEventListener("pointercancel", stop)
                latest.current.onScrubEnd?.()
            }
            addEventListener("pointermove", move)
            addEventListener("pointerup", stop)
            addEventListener("pointercancel", stop)
            endScrub.current = stop
        },
        onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
            const lane = event.currentTarget
            setHover({ x: event.clientX - lane.getBoundingClientRect().left, t: timeAt(lane, event.clientX) })
        },
        onPointerLeave: () => setHover(null),
        onWheel: (event: ReactWheelEvent<HTMLDivElement>) => {
            if (!zoomAlways && !event.ctrlKey && !event.metaKey) {
                return
            }
            const lane = event.currentTarget
            const width = view.to - view.from
            if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
                const shift = (event.deltaX / Math.max(1, lane.clientWidth)) * width
                const from = Math.min(end - width, Math.max(start, view.from + shift))
                setView({ from, to: from + width })
                return
            }
            const at = timeAt(lane, event.clientX)
            const next = Math.min(span, Math.max(0.05, width * Math.exp(event.deltaY * 0.002)))
            const from = Math.min(end - next, Math.max(start, at - ((at - view.from) / width) * next))
            setView({ from, to: from + next })
        },
    })
    const percent = (t: number) => `${((t - view.from) / Math.max(1e-9, view.to - view.from)) * 100}%`
    const inView = value >= view.from && value <= view.to
    const hasLanes = !!lanes?.length || !!onExpandedChange

    return (
        <section
            className={cx("dr-playback", expanded && "dr-playback--expanded", className)}
            style={style}
            aria-label="Playback"
            {...rest}
        >
            <div className="dr-playback__bar">
                <div className="dr-playback__controls">
                    {onPlayPause
                        ? (
                            <button
                                type="button"
                                className="dr-timeline__play"
                                title={playing ? "Pause (space)" : "Play (space)"}
                                aria-label={playing ? "Pause" : "Play"}
                                data-testid="play"
                                onClick={() => onPlayPause(!playing)}
                            >
                                <Icon name={playing ? "pause" : "play"} size={16} />
                            </button>
                        )
                        : null}
                    <span className="dr-playback__time" data-testid="time" title="position / length">
                        <span className="dr-playback__now">{show(value)}</span>
                        <span className="dr-playback__length">{` / ${show(end)}`}</span>
                    </span>
                    {onSpeedChange
                        ? (
                            <Select
                                size="sm"
                                className="dr-playback__speed"
                                aria-label="Speed"
                                title="Playback speed"
                                value={speed}
                                options={speeds.map((option): [number, string] => [option, `${option}×`])}
                                onChange={onSpeedChange}
                            />
                        )
                        : null}
                    {onLoopChange
                        ? (
                            <IconButton
                                icon="refresh"
                                size="sm"
                                label="Loop: start over at the end"
                                aria-pressed={!!loop}
                                className={cx(loop && "dr-playback__on")}
                                onClick={() => onLoopChange(!loop)}
                            />
                        )
                        : null}
                    {hasLanes && onExpandedChange
                        ? (
                            <button
                                type="button"
                                className={cx("dr-playback__expand", expanded && "dr-playback__on")}
                                aria-expanded={expanded}
                                title={expanded
                                    ? `Hide the ${lanesLabel.toLowerCase()}`
                                    : `Show a row per ${lanesLabel.toLowerCase().replace(/s$/, "")}`}
                                data-testid="expand"
                                onClick={() => onExpandedChange(!expanded)}
                            >
                                <Icon name={expanded ? "chevron-down" : "chevron-up"} size={14} />
                                <span>{lanesLabel}</span>
                            </button>
                        )
                        : null}
                    {zoomed
                        ? (
                            <button
                                type="button"
                                className="dr-playback__expand"
                                title="Show the whole recording"
                                onClick={() => setView({ from: start, to: end })}
                            >
                                Fit
                            </button>
                        )
                        : null}
                    {controls}
                </div>
                <div className="dr-playback__lane dr-playback__track" data-testid="scrubber" {...axis(false)}>
                    <div className="dr-timeline__rail" />
                    {inView ? <div className="dr-timeline__done" style={{ width: percent(value) }} /> : null}
                    {inView
                        ? (
                            <div
                                className={cx("dr-timeline__thumb", scrubbing && "dr-playback__thumb--active")}
                                style={{ left: percent(value) }}
                            />
                        )
                        : null}
                    {hover
                        ? (
                            <span className="dr-playback__hover" style={{ left: hover.x }}>
                                {show(hover.t)}
                            </span>
                        )
                        : null}
                    {zoomed
                        ? <span className="dr-playback__window">{`${show(view.from)} – ${show(view.to)}`}</span>
                        : null}
                </div>
            </div>
            {expanded && lanes?.length
                ? (
                    <div className="dr-playback__rows" data-testid="stream-rows">
                        {lanes.map((lane) => (
                            <div
                                key={lane.id}
                                className={cx(
                                    "dr-playback__row",
                                    lane.active && "dr-playback__row--active",
                                    lane.busy && "dr-playback__row--busy",
                                )}
                                data-lane={lane.id}
                            >
                                <div className="dr-playback__name">
                                    {lane.leading ?? <span className="dr-playback__leading" />}
                                    <span className="dr-playback__label" title={lane.title}>
                                        {lane.label}
                                    </span>
                                    {lane.meta !== undefined
                                        ? <span className="dr-playback__meta">{lane.meta}</span>
                                        : null}
                                    {lane.count !== undefined
                                        ? <span className="dr-playback__count">{lane.count}</span>
                                        : null}
                                    {lane.menu?.length
                                        ? (
                                            <Menu
                                                placement="top-end"
                                                items={lane.menu}
                                                trigger={
                                                    <IconButton
                                                        icon="more-horizontal"
                                                        size="sm"
                                                        label={`${lane.id} actions`}
                                                        data-testid={`stream-menu-${lane.id}`}
                                                    />
                                                }
                                            />
                                        )
                                        : null}
                                </div>
                                <div className="dr-playback__lane" {...axis(true)}>
                                    <LaneTicks ticks={lane.ticks} view={view} />
                                    {inView
                                        ? <div className="dr-playback__cursor" style={{ left: percent(value) }} />
                                        : null}
                                </div>
                            </div>
                        ))}
                    </div>
                )
                : null}
        </section>
    )
}
