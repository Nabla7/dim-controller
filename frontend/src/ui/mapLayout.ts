// What the 2D map panel remembers per viewer (localStorage: a phone and a desktop each keep their own), checked on load.
// One store: the map's cog and Settings → Map change the same choices. Where the panel is and whether it's folded is
// the workspace's (ui/workspace.ts).
import { DEFAULT_FOLLOW_FRAME, DEFAULT_SLICE, isValidView, type MapBase, type MapView } from "../core/map2d.ts"
import { Store } from "../core/store.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"

export interface MapLayout {
    /** what the base is: the lidar map (the default) or a costmap */
    source: MapBase
    /** the base map: "" = the best on the bus (the global map) */
    topic: string
    /** a costmap drawn over the base: "" = none (the default) */
    overlay: string
    /** the TF frame the view follows (following itself is never remembered: a reload always follows) */
    followFrame: string
    view: MapView | null
    /** the lidar map keeps only points from `below` m under the followed frame to `above` m over it (one floor of a 3D place) */
    slice: { enabled: boolean; below: number; above: number }
}

export const LAYOUT_KEY = "lv.map2d"

/** The remembered choices, every field checked: a broken or stale entry falls back to the defaults. */
export function loadMapLayout(saved: Partial<MapLayout> = readLocal<Partial<MapLayout>>(LAYOUT_KEY, {})): MapLayout {
    const text = (value: unknown) => typeof value === "string" ? value : ""
    const meters = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
    return {
        source: saved?.source === "costmap" ? "costmap" : "lidar",
        topic: text(saved?.topic),
        overlay: text(saved?.overlay),
        followFrame: text(saved?.followFrame) || DEFAULT_FOLLOW_FRAME,
        view: isValidView(saved?.view) ? saved.view : null,
        slice: {
            enabled: typeof saved?.slice?.enabled === "boolean" ? saved.slice.enabled : DEFAULT_SLICE.enabled,
            below: meters(saved?.slice?.below, DEFAULT_SLICE.below),
            above: meters(saved?.slice?.above, DEFAULT_SLICE.above),
        },
    }
}

/** the map's choices in use (the map panel and Settings both read and change this one) */
export const mapLayout = new Store<MapLayout>(loadMapLayout())

export function updateMapLayout(patch: Partial<MapLayout>) {
    mapLayout.update(patch)
    writeLocal(LAYOUT_KEY, mapLayout.get())
}
