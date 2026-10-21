// Scans a camera frame for the glass-to-glass code off the main thread (jsQR takes tens of ms a frame; on the main
// thread it would hold up the code's own redraw, and a code left on screen longer reads as latency).
import jsQR from "jsqr"

const canvas = new OffscreenCanvas(1, 1)
const context = canvas.getContext("2d", { willReadFrequently: true })!

self.onmessage = (event: MessageEvent<{ id: number; frame: ImageBitmap }>) => {
    const { id, frame } = event.data
    canvas.width = frame.width
    canvas.height = frame.height
    context.drawImage(frame, 0, 0)
    frame.close()
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    // a frame the browser kept from the page comes back empty (all zero, or one flat colour): say so instead of scanning
    let low = 255, high = 0
    for (let i = 0; i < image.data.length; i += 4 * 97) {
        low = Math.min(low, image.data[i])
        high = Math.max(high, image.data[i])
    }
    if (high - low < 8) {
        self.postMessage({ id, text: null, blank: true })
        return
    }
    const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })
    self.postMessage({ id, text: found?.data ?? null, blank: false })
}
