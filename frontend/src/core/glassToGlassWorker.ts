// Scans a camera frame for the glass-to-glass code off the main thread (jsQR takes tens of ms a frame; on the main
// thread it would hold up the code's own redraw, and a code left on screen longer reads as latency).
import jsQRModule from "jsqr"

type ScanFn = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }) => { data: string } | null
// jsqr is CommonJS: a bundler hands over its function, deno its exports object (whose default is the function)
const loaded = jsQRModule as unknown as ScanFn | { default: ScanFn }
const jsQR: ScanFn = typeof loaded === "function" ? loaded : loaded.default

const canvas = new OffscreenCanvas(1, 1)
const context = canvas.getContext("2d", { willReadFrequently: true })!

self.onmessage = (event: MessageEvent<{ id: number; frame: ImageBitmap }>) => {
    const { id, frame } = event.data
    canvas.width = frame.width
    canvas.height = frame.height
    context.drawImage(frame, 0, 0)
    frame.close()
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    // a frame the browser kept from the page comes back empty: all white, all black, transparent or one flat colour
    // (Firefox on Android hands back no pixels of a hardware-decoded WebRTC video); say which instead of scanning
    let low = 255, high = 0, alpha = 0, samples = 0
    for (let i = 0; i < image.data.length; i += 4 * 97) {
        for (let channel = 0; channel < 3; channel++) {
            low = Math.min(low, image.data[i + channel])
            high = Math.max(high, image.data[i + channel])
        }
        alpha += image.data[i + 3]
        samples++
    }
    if (alpha / samples < 8 || high - low < 8) {
        const blank = alpha / samples < 8 ? "transparent" : low > 240 ? "white" : high < 16 ? "black" : "flat"
        self.postMessage({ id, text: null, blank })
        return
    }
    const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })
    self.postMessage({ id, text: found?.data ?? null, blank: null })
}
