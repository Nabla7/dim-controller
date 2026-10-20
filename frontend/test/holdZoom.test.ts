// Press and hold to zoom on a camera (core/holdZoom.ts): a phone's long press must not end the zoom.
import { assertEquals } from "jsr:@std/assert@1"
import { createHoldZoom, HOLD_ZOOM_DELAY_MS } from "../src/core/holdZoom.ts"
import { createTripleTap } from "../src/core/zoomDebug.ts"

const BOX = { left: 0, top: 0, width: 200, height: 100 }

function fakeTimers() {
    const pending = new Map<number, () => void>()
    let next = 0
    return {
        setTimer: (run: () => void) => {
            pending.set(++next, run)
            return next
        },
        clearTimer: (id: number) => void pending.delete(id),
        fire: () => {
            const runs = [...pending.values()]
            pending.clear()
            runs.forEach((run) => run())
        },
    }
}

function setup() {
    const timers = fakeTimers()
    const origins: (string | null)[] = []
    const hold = createHoldZoom({ onOrigin: (origin) => origins.push(origin), ...timers })
    return { hold, timers, origins, last: () => origins.at(-1) ?? null }
}

Deno.test("a held press zooms on the pressed spot after the delay, and letting go zooms out", () => {
    const { hold, timers, last } = setup()
    hold.down({ clientX: 50, clientY: 25, button: 0 }, BOX)
    assertEquals(last(), null)
    timers.fire()
    assertEquals(last(), "25.0% 25.0%")
    hold.move({ clientX: 100, clientY: 50 }, BOX)
    assertEquals(last(), "50.0% 50.0%")
    hold.release()
    assertEquals(last(), null)
})

Deno.test("the phone's long press (contextmenu) is refused and doesn't end the zoom", () => {
    const { hold, timers, last } = setup()
    hold.down({ clientX: 50, clientY: 25, button: 0 }, BOX)
    timers.fire()
    let prevented = false
    hold.contextMenu({ preventDefault: () => prevented = true })
    assertEquals(prevented, true)
    assertEquals(last(), "25.0% 25.0%")
})

Deno.test("a quick tap never zooms, and a right button press is ignored", () => {
    const { hold, timers, origins } = setup()
    hold.down({ clientX: 50, clientY: 25, button: 0 }, BOX)
    hold.release()
    timers.fire()
    hold.down({ clientX: 50, clientY: 25, button: 2 }, BOX)
    timers.fire()
    assertEquals(origins, [])
    assertEquals(HOLD_ZOOM_DELAY_MS > 0, true)
})

Deno.test("a browser pointercancel on a held touch keeps the zoom until the touch ends", () => {
    const { hold, timers, last } = setup()
    hold.down({ clientX: 50, clientY: 25, button: 0 }, BOX)
    timers.fire()
    hold.cancel("touch")
    assertEquals(last(), "25.0% 25.0%")
    hold.touchMove({ clientX: 100, clientY: 50 }, BOX)
    assertEquals(last(), "50.0% 50.0%")
    hold.touchEnd()
    assertEquals(last(), null)
})

Deno.test("a pointercancel before the zoom (or from a mouse) ends the hold, and a stray touchend changes nothing", () => {
    const { hold, timers, origins } = setup()
    hold.down({ clientX: 50, clientY: 25, button: 0 }, BOX)
    hold.cancel("touch")
    timers.fire()
    hold.touchEnd()
    hold.touchMove({ clientX: 100, clientY: 50 }, BOX)
    assertEquals(origins, [])
    hold.down({ clientX: 50, clientY: 25, button: 0 }, BOX)
    timers.fire()
    hold.cancel("mouse")
    assertEquals(origins.at(-1), null)
})

Deno.test("three taps within the window toggle the zoom debug log", () => {
    const tap = createTripleTap(600)
    assertEquals([tap(0), tap(200), tap(400)], [false, false, true])
    assertEquals([tap(1000), tap(1700), tap(1800)], [false, false, false])
})
