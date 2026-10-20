// Press and hold on a camera to zoom in on that spot (ui/CameraPanels.tsx useHoldZoom): a press longer than the delay
// zooms, moving while held moves the zoom, letting go (or the browser cancelling the pointer) zooms back out.
// A phone's own long press (Android's contextmenu at ~500 ms, iOS's callout) would cancel the pointer mid-zoom, so the
// contextmenu is refused here, styles.css turns the callout, selection, dragging and touch panning off on the camera,
// ui/CameraPanels.tsx refuses its touchstart (a still finger's long press, drag or selection never starts), and if the
// pointer is cancelled anyway the zoom holds until the touch ends.

export const HOLD_ZOOM = 3
/** a press shorter than this is a click, not a zoom */
export const HOLD_ZOOM_DELAY_MS = 180

type Point = { clientX: number; clientY: number }
type Box = { left: number; top: number; width: number; height: number }

/** The CSS transform-origin for a point in a box, in percent. */
export function zoomOrigin(point: Point, box: Box): string {
    return `${(((point.clientX - box.left) / box.width) * 100).toFixed(1)}% ${(((point.clientY - box.top) / box.height) * 100).toFixed(1)}%`
}

export function createHoldZoom({ onOrigin, delayMs = HOLD_ZOOM_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }: {
    onOrigin: (origin: string | null, cause: string) => void
    delayMs?: number
    setTimer?: (run: () => void, ms: number) => unknown
    clearTimer?: (timer: any) => void
}) {
    let timer: unknown = null
    let origin: string | null = null
    // the browser cancelled a held touch's pointer: still zoomed, ended by the touch's own touchend instead
    let orphaned = false
    const set = (next: string | null, cause: string) => {
        origin = next
        onOrigin(next, cause)
    }
    /** `cause`: what ended the hold (pointerup, pointercancel, ...), for ui/ZoomDebug.tsx */
    const release = (cause = "release") => {
        orphaned = false
        if (timer !== null) {
            clearTimer(timer)
            timer = null
        }
        if (origin !== null) {
            set(null, cause)
        }
    }
    return {
        down(point: Point & { button: number }, box: Box) {
            if (point.button !== 0) {
                return
            }
            release("another press")
            const at = zoomOrigin(point, box)
            timer = setTimer(() => {
                timer = null
                set(at, "held")
            }, delayMs)
        },
        move(point: Point, box: Box) {
            if (origin !== null) {
                set(zoomOrigin(point, box), "move")
            }
        },
        release,
        /** a pointercancel: a touch that's already zoomed stays zoomed (until touchEnd); anything else ends the hold */
        cancel(pointerType: string) {
            if (origin !== null && pointerType === "touch") {
                orphaned = true
                return
            }
            release("pointercancel")
        },
        /** a touchmove anywhere: moves the zoom only after the pointer was cancelled (pointermove has stopped) */
        touchMove(point: Point, box: Box) {
            if (orphaned && origin !== null) {
                set(zoomOrigin(point, box), "touchmove after cancel")
            }
        },
        /** a touchend or touchcancel anywhere: ends a hold whose pointer was cancelled */
        touchEnd(type = "touchend") {
            if (orphaned) {
                release(`${type} after pointercancel`)
            }
        },
        /** a phone's long press: refused, so it can't cancel the hold (or open the video's menu) */
        contextMenu(event: { preventDefault: () => void }) {
            event.preventDefault()
        },
    }
}
