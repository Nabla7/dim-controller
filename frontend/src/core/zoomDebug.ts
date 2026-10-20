// A hidden log of what happens around a camera's press-and-hold zoom, for a screenshot from a phone (ui/ZoomDebug.tsx).
// On with ?debug=zoom in the app's (or Desktop's) URL, or a triple tap on a camera; a triple tap again turns it off.

export const ZOOM_DEBUG_KEY = "controller.debug.zoom"
export const ZOOM_DEBUG_LINES = 20
export const TRIPLE_TAP_MS = 600

type Listener = () => void
const listeners = new Set<Listener>()
let lines: string[] = []
let enabled = initialEnabled()
const startedAt = performance.now()

function initialEnabled(): boolean {
    const asked = (search: string) => new URLSearchParams(search).get("debug")?.split(",").includes("zoom")
    try {
        if (asked(location.search) || asked(globalThis.top?.location.search ?? "")) {
            return true
        }
    } catch {
        // the top frame is another origin: only this frame's URL counts
    }
    try {
        return localStorage.getItem(ZOOM_DEBUG_KEY) === "1"
    } catch {
        return false
    }
}

// one object per change: useStore (useSyncExternalStore) needs the same snapshot until something changes
let snapshot = { enabled, lines }
const notify = () => {
    snapshot = { enabled, lines }
    listeners.forEach((listener) => listener())
}

export const zoomDebug = {
    subscribe(listener: Listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
    },
    get: () => snapshot,
    log(line: string) {
        if (!enabled) {
            return
        }
        lines = [...lines, `${((performance.now() - startedAt) / 1000).toFixed(3)} ${line}`].slice(-ZOOM_DEBUG_LINES)
        notify()
    },
    toggle() {
        enabled = !enabled
        lines = []
        try {
            localStorage.setItem(ZOOM_DEBUG_KEY, enabled ? "1" : "0")
        } catch {
            // private mode: on for this page only
        }
        notify()
    },
}

/** Counts taps: true on the third within TRIPLE_TAP_MS of each other. */
export function createTripleTap(windowMs = TRIPLE_TAP_MS) {
    let taps: number[] = []
    return (now: number) => {
        taps = [...taps.filter((at) => now - at < windowMs), now]
        if (taps.length >= 3) {
            taps = []
            return true
        }
        return false
    }
}
