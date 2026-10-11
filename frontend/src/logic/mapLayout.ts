// What the 2D map panel remembers per viewer (localStorage: a phone and a desktop each keep their own), checked on load.
import { clampPanelBox } from "dimos-react"
/** the north-up map view: center (fixed frame, m) and zoom (m per CSS px) */
export interface MapView {
    centerX: number
    centerY: number
    metersPerPixel: number
}
const DEFAULT_FOLLOW_FRAME = "base_link"
const isValidView = (view: unknown): view is MapView => {
    const { centerX, centerY, metersPerPixel } = (view ?? {}) as Partial<MapView>
    return [centerX, centerY, metersPerPixel].every(Number.isFinite) && metersPerPixel! >= 0.002 && metersPerPixel! <= 2
}
import { readLocal } from "./local.ts"

/** what this viewer remembers about the panel (localStorage: a phone and a desktop each keep their own) */
export interface MapLayout {
    collapsed: boolean
    /** fills the area under the top bar */
    full: boolean
    /** -1: the default corner */
    x: number
    y: number
    width: number
    height: number
    /** the base map: "" = the best on the bus (the global map) */
    topic: string
    /** a costmap drawn over the base: "" = none (the default) */
    overlay: string
    /** the TF frame the view follows (following itself is never remembered: a reload always follows) */
    followFrame: string
    view: MapView | null
}

export const LAYOUT_KEY = "lv.map2d"
export const HEAD_PX = 33
export const MIN_WIDTH = 200, MIN_HEIGHT = 150
export const viewport = () => ({ width: globalThis.innerWidth || 0, height: globalThis.innerHeight || 0 })

/**
 * The remembered layout, every field checked: a broken or stale entry never hides the panel. A first-time viewer gets
 * it collapsed (just its header); once they open or close it, that's remembered.
 */
export function loadMapLayout(saved: Partial<MapLayout> = readLocal<Partial<MapLayout>>(LAYOUT_KEY, {}), screen = viewport()): MapLayout {
    const defaults: MapLayout = { collapsed: true, full: false, x: -1, y: -1, width: 320, height: 320 + HEAD_PX, topic: "", overlay: "", followFrame: DEFAULT_FOLLOW_FRAME, view: null }
    const flag = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback
    const text = (value: unknown) => typeof value === "string" ? value : ""
    return {
        ...clampPanelBox(saved ?? {}, defaults, screen, { width: MIN_WIDTH, height: MIN_HEIGHT }),
        collapsed: flag(saved?.collapsed, defaults.collapsed),
        full: flag(saved?.full, false),
        topic: text(saved?.topic),
        overlay: text(saved?.overlay),
        followFrame: text(saved?.followFrame) || DEFAULT_FOLLOW_FRAME,
        view: isValidView(saved?.view) ? saved.view : null,
    }
}
