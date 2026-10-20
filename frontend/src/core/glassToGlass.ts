// Glass-to-glass latency: this page shows a QR code that changes every screen frame, carrying the time it was drawn;
// held up to one of the robot's cameras, it comes back in that camera's video, and the frame that shows it is timed
// against the code's time. Both times are this page's clock (performance.now), so no clock sync is needed.
import jsQR from "jsqr"
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

/** Draws the moving code into `canvas` every screen frame until the returned function is called. */
export function showCode(canvas: HTMLCanvasElement): () => void {
    const context = canvas.getContext("2d")!
    let frame = 0
    const draw = (now: number) => {
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
 * Watches every camera panel's <video> for the code: each frame it shows is scanned (one at a time per camera, so a
 * slow scan skips frames instead of queueing them) and a code seen for the first time is timed from when it was drawn
 * to when that frame reached the screen. `onChange` gets every camera's results so far. Returns what stops it.
 */
export function watchCameras(onChange: (results: CameraResult[]) => void): () => void {
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d", { willReadFrequently: true })!
    const results = new Map<string, CameraResult>()
    const watching = new Map<HTMLVideoElement, number>()
    let lastCode = new Map<string, number>()
    let stopped = false
    const scan = (video: HTMLVideoElement, panel: string, shownAt: number) => {
        const scale = Math.min(1, SCAN_WIDTH / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        if (!canvas.width || !canvas.height) {
            return
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const image = context.getImageData(0, 0, canvas.width, canvas.height)
        const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })
        const codeMs = found && decodeTime(found.data)
        // the same code in two frames: the later one isn't when it arrived
        if (codeMs === null || codeMs === undefined || lastCode.get(panel) === codeMs) {
            return
        }
        lastCode.set(panel, codeMs)
        const result = results.get(panel) ?? { panel, samples: [] }
        result.samples = [...result.samples, elapsed(codeMs, shownAt)].slice(-KEEP)
        results.set(panel, result)
        onChange([...results.values()])
    }
    const watch = (video: HTMLVideoElement) => {
        const panel = video.closest<HTMLElement>("[data-panel]")?.dataset.panel ?? "camera"
        const next = (_now: number, metadata: VideoFrameCallbackMetadata) => {
            if (stopped || !video.isConnected) {
                watching.delete(video)
                return
            }
            // expectedDisplayTime: when this frame is on the screen (the second glass)
            scan(video, panel, metadata.expectedDisplayTime)
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
        watching.clear()
        lastCode = new Map()
    }
}

/** the q-th quantile (0..1) of `values` */
export function quantile(values: number[], q: number): number {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
}
