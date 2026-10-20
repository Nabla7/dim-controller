// Press and hold on a camera to zoom in on that spot (ui/CameraPanels.tsx useHoldZoom): a press longer than the delay
// zooms, moving while held moves the zoom, letting go (or the browser cancelling the pointer) zooms back out.
// A phone's own long press (Android's contextmenu at ~500 ms, iOS's callout) would cancel the pointer mid-zoom, so the
// contextmenu is refused here and styles.css turns the callout, selection and touch panning off on .camera-media.

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
    onOrigin: (origin: string | null) => void
    delayMs?: number
    setTimer?: (run: () => void, ms: number) => unknown
    clearTimer?: (timer: any) => void
}) {
    let timer: unknown = null
    let origin: string | null = null
    const set = (next: string | null) => {
        origin = next
        onOrigin(next)
    }
    const release = () => {
        if (timer !== null) {
            clearTimer(timer)
            timer = null
        }
        if (origin !== null) {
            set(null)
        }
    }
    return {
        down(point: Point & { button: number }, box: Box) {
            if (point.button !== 0) {
                return
            }
            release()
            const at = zoomOrigin(point, box)
            timer = setTimer(() => {
                timer = null
                set(at)
            }, delayMs)
        },
        move(point: Point, box: Box) {
            if (origin !== null) {
                set(zoomOrigin(point, box))
            }
        },
        release,
        /** a phone's long press: refused, so it can't cancel the hold (or open the video's menu) */
        contextMenu(event: { preventDefault: () => void }) {
            event.preventDefault()
        },
    }
}
