// The glass-to-glass code: its time survives a QR round trip (drawn as pixels, read back by jsQR), and the elapsed time
// across the code's wrap.
import { assertEquals } from "jsr:@std/assert"
import jsQR from "jsqr"
import { decodeTime, elapsed, encodeTime, qrModules } from "../src/core/glassToGlass.ts"

Deno.test("a code drawn as pixels reads back as the time it carries", () => {
    const text = encodeTime(1234567.8)
    const modules = qrModules(text)
    const cell = 6, quiet = 4, size = (modules.length + quiet * 2) * cell
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
    modules.forEach((row, y) => row.forEach((dark, x) => {
        for (let dy = 0; dy < cell; dy++) {
            for (let dx = 0; dx < cell; dx++) {
                const at = (((quiet + y) * cell + dy) * size + (quiet + x) * cell + dx) * 4
                pixels[at] = pixels[at + 1] = pixels[at + 2] = dark ? 0 : 255
            }
        }
    }))
    const found = jsQR(pixels, size, size)
    assertEquals(found?.data, "g2g:1234567")
    assertEquals(decodeTime(found!.data), 1234567)
})

Deno.test("only our codes decode; the elapsed time crosses the wrap", () => {
    assertEquals(decodeTime("https://example.com"), null)
    assertEquals(decodeTime("g2g:abc"), null)
    assertEquals(elapsed(1000, 1120), 120)
    assertEquals(elapsed(9_999_950, 70), 120)
})
