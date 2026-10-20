// Glass-to-glass latency: this page shows a QR code that changes every screen frame, carrying the time it was drawn;
// held up to one of the robot's cameras, it comes back in that camera's video, and the frame that shows it is timed
// against the code's time. Both times are this page's clock (performance.now), so no clock sync is needed.
import qrcode from "qrcode-generator"

const PREFIX = "g2g:"
/** the code's time wraps here (ms), so it stays a short code (a small, coarse QR reads from further away) */
const WRAP = 1e7
/** frames are scanned at most this wide (jsQR's time grows with the pixels) */
const SCAN_WIDTH = 640
/** results kept per camera (the stats are over these) */
const KEEP = 200

/** The QR modules for `text`: a square of booleans (true: dark). */
export function qrModules(text: string): boolean[][] {
    const code = qrcode(0, "M")
    code.addData(text)
    code.make()
    const size = code.getModuleCount()
    return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => code.isDark(row, col)))
}

export const encodeTime = (ms: number) => `${PREFIX}${Math.floor(ms % WRAP)}`

/** the code's time back (null: not one of ours) */
export function decodeTime(text: string): number | null {
    if (!text.startsWith(PREFIX)) {
        return null
    }
    const value = Number(text.slice(PREFIX.length))
    return Number.isInteger(value) && value >= 0 ? value : null
}

/** how long ago (ms) a code drawn at `codeMs` (wrapped) was, seen at `shownMs` */
export const elapsed = (codeMs: number, shownMs: number) => ((shownMs - codeMs) % WRAP + WRAP) % WRAP

/** each code stays up this many camera frames, so a whole camera frame (its exposure included) sees it unblended */
const HOLD_FRAMES = 2
/** the slowest watched camera's frame interval (ms), measured from the frames its <video> shows; null before any */
let cameraFrameMs: number | null = null
/** how long each code stays up before one is measured: a 2 Hz camera's two frames, slower than any camera here */
const UNMEASURED_HOLD_MS = 1000

/** How long each code stays up now (ms): HOLD_FRAMES of the slowest camera's frames. */
export const holdMs = () => cameraFrameMs === null ? UNMEASURED_HOLD_MS : HOLD_FRAMES * cameraFrameMs

/**
 * Draws a new code into `canvas` every holdMs() (a camera slower than the screen saw two codes blended into one
 * frame when it changed every screen frame), each carrying the time it first went up, until the returned function is
 * called.
 */
export function showCode(canvas: HTMLCanvasElement): () => void {
    const context = canvas.getContext("2d")!
    let frame = 0
    let shownAt = -Infinity
    const draw = (now: number) => {
        if (now - shownAt < holdMs()) {
            frame = requestAnimationFrame(draw)
            return
        }
        shownAt = now
        const modules = qrModules(encodeTime(now))
        const quiet = 4
        const cells = modules.length + quiet * 2
        const cell = Math.floor(canvas.width / cells)
        const offset = Math.floor((canvas.width - cell * cells) / 2) + quiet * cell
        context.fillStyle = "#fff"
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.fillStyle = "#000"
        modules.forEach((row, y) => row.forEach((dark, x) => dark && context.fillRect(offset + x * cell, offset + y * cell, cell, cell)))
        frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
}

export interface CameraResult {
    /** the camera panel's id */
    panel: string
    samples: number[]
}

/**
 * Watches every camera panel's <video> for the code: each frame it shows is scanned in a worker (one at a time per
 * camera, so a slow scan skips frames instead of queueing them) and a code seen for the first time is timed from when it was drawn
 * to when that frame reached the screen. `onChange` gets every camera's results so far. Returns what stops it.
 */
export function watchCameras(onChange: (results: CameraResult[]) => void): () => void {
    const worker = new Worker(new URL("./glassToGlassWorker.ts", import.meta.url), { type: "module" })
    const results = new Map<string, CameraResult>()
    const watching = new Map<HTMLVideoElement, number>()
    const busy = new Set<string>()
    const lastCode = new Map<string, number>()
    const frameMs = new Map<string, number>()
    /** frames out at the worker: their camera and when they reached the screen */
    const pending = new Map<number, { panel: string; shownAt: number }>()
    let nextId = 0
    let stopped = false
    worker.onmessage = (event: MessageEvent<{ id: number; text: string | null }>) => {
        const frame = pending.get(event.data.id)
        pending.delete(event.data.id)
        if (!frame || stopped) {
            return
        }
        busy.delete(frame.panel)
        const codeMs = event.data.text === null ? null : decodeTime(event.data.text)
        // the same code in two frames: the later one isn't when it arrived
        if (codeMs === null || lastCode.get(frame.panel) === codeMs) {
            return
        }
        lastCode.set(frame.panel, codeMs)
        const result = results.get(frame.panel) ?? { panel: frame.panel, samples: [] }
        result.samples = [...result.samples, elapsed(codeMs, frame.shownAt)].slice(-KEEP)
        results.set(frame.panel, result)
        onChange([...results.values()])
    }
    const scan = async (video: HTMLVideoElement, panel: string, shownAt: number) => {
        const scale = Math.min(1, SCAN_WIDTH / video.videoWidth)
        const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale)
        if (!width || !height || busy.has(panel)) {
            return
        }
        busy.add(panel)
        try {
            const frame = await createImageBitmap(video, { resizeWidth: width, resizeHeight: height })
            const id = nextId++
            pending.set(id, { panel, shownAt })
            worker.postMessage({ id, frame }, [frame])
        } catch {
            busy.delete(panel)
        }
    }
    const watch = (video: HTMLVideoElement) => {
        const panel = video.closest<HTMLElement>("[data-panel]")?.dataset.panel ?? "camera"
        let lastFrameAt: number | null = null
        const next = (_now: number, metadata: VideoFrameCallbackMetadata) => {
            if (stopped || !video.isConnected) {
                watching.delete(video)
                return
            }
            // its frame interval, smoothed; the slowest camera's sets how long each code stays up
            if (lastFrameAt !== null) {
                const interval = metadata.presentationTime - lastFrameAt
                if (interval > 0 && interval < 2000) {
                    frameMs.set(panel, (frameMs.get(panel) ?? interval) * 0.8 + interval * 0.2)
                    cameraFrameMs = Math.max(...frameMs.values())
                }
            }
            lastFrameAt = metadata.presentationTime
            // when this frame is on the screen (the second glass): never before it went to the compositor (a headless
            // Chrome's expectedDisplayTime can come whole vsyncs before that)
            scan(video, panel, Math.max(metadata.expectedDisplayTime, metadata.presentationTime))
            watching.set(video, video.requestVideoFrameCallback(next))
        }
        watching.set(video, video.requestVideoFrameCallback(next))
    }
    // camera panels come and go (and a camera's <video> is remade on a resubscribe): look for new ones each second
    const find = () => {
        for (const video of document.querySelectorAll<HTMLVideoElement>("[data-panel^='camera:'] video")) {
            if (!watching.has(video) && typeof video.requestVideoFrameCallback === "function") {
                watch(video)
            }
        }
    }
    find()
    const finder = setInterval(find, 1000)
    return () => {
        stopped = true
        clearInterval(finder)
        for (const [video, handle] of watching) {
            video.cancelVideoFrameCallback(handle)
        }
        worker.terminate()
    }
}

/** the q-th quantile (0..1) of `values` */
export function quantile(values: number[], q: number): number {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
}
