// The page's layout (Settings → Layout), saved like every other setting (`lv.layout`, so every open page follows):
// Classic (the 3D view fills the window and the panels float over it, as before), or one of three arrangements that
// place each region (camera, 3D view, map, drive, status, settings) in a box worked out here, with no React and no DOM,
// so it's unit tested. Whatever the layout, driving is the same: keys and sticks only, the latency hold and Reconnect
// (ui/DriveHud.tsx), and the drive region is never hidden.
import { swapTiles as librarySwapTiles } from "dimos-react"
import { persistentStore, Store, useStore } from "./settings.ts"

export type LayoutMode = "classic" | "cockpit" | "split" | "tiles"
export type Region = "camera" | "scene" | "map" | "drive" | "status" | "settings"

export const LAYOUTS: { id: LayoutMode; label: string; about: string }[] = [
    { id: "classic", label: "Classic", about: "The 3D view fills the window; the camera and map float over it (drag, resize, fold)." },
    { id: "cockpit", label: "Cockpit", about: "The camera fills the window; the map and the 3D view are small insets over it; Settings slides over from the right." },
    { id: "split", label: "Split", about: "Camera and 3D view side by side; the map and drive keys in a rail on the left; Settings in a column on the right." },
    { id: "tiles", label: "Tiles", about: "Equal tiles (camera, 3D, map, drive, status, settings): drag a tile's header onto another to swap them, maximize one with its button." },
]

export const TILE_REGIONS: Region[] = ["camera", "scene", "map", "drive", "status", "settings"]
export interface LayoutSettings {
    mode: LayoutMode
    /** the Tiles layout's order */
    tiles: Region[]
}
export const DEFAULT_LAYOUT: LayoutSettings = { mode: "classic", tiles: TILE_REGIONS }
export const LAYOUT_SETTING = "lv.layout"

/** A saved layout made safe: an unknown mode is Classic, the tile order has every tile once (unknown ones dropped). */
export function normalizeLayout(saved: Partial<LayoutSettings> | null | undefined): LayoutSettings {
    const mode = LAYOUTS.some((layout) => layout.id === saved?.mode) ? saved!.mode! : DEFAULT_LAYOUT.mode
    const known = Array.isArray(saved?.tiles) ? saved.tiles.filter((region, index, all) => TILE_REGIONS.includes(region) && all.indexOf(region) === index) : []
    return { mode, tiles: [...known, ...TILE_REGIONS.filter((region) => !known.includes(region))] }
}

export const layoutSettings = persistentStore<LayoutSettings>(LAYOUT_SETTING, DEFAULT_LAYOUT)
export function useLayout(): LayoutSettings {
    return normalizeLayout(useStore(layoutSettings))
}
export function setLayoutMode(mode: LayoutMode) {
    maximized.set({ region: null })
    layoutSettings.update({ mode })
}

/** the region that fills the page for now (this page only, never saved; null: none) */
export const maximized = new Store<{ region: Region | null }>({ region: null })
export function toggleMaximized(region: Region) {
    maximized.set({ region: maximized.get().region === region ? null : region })
}

/** The tile order with `a` and `b` swapped. */
export const swapTiles = librarySwapTiles as (order: Region[], a: Region, b: Region) => Region[]

export interface Rect {
    x: number
    y: number
    width: number
    height: number
}

/** The window as the layout sees it. */
export interface Frame {
    width: number
    height: number
    /** where the top bar ends */
    top: number
    /** what the host covers at the bottom (Desktop's dock) */
    bottom: number
    /** a phone: the drive sticks fill the bottom `sticks` px and Settings is a bottom sheet */
    mobile: boolean
    sticks: number
    /** a side tab (Settings, TF, Layers) is open: Split gives it a column */
    sidePanel: boolean
    gap: number
}

/** the phone's stick zone (styles.css .drive-hud.mobile): min(40vh, 330px), landscape min(62vh, 260px) */
export function stickHeight(width: number, height: number): number {
    return width > height && height <= 520 ? Math.min(0.62 * height, 260) : Math.min(0.4 * height, 330)
}

const SIDE_COLUMN = 340
const round = (rect: Rect): Rect => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) })
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** The regions the layout shows itself (Classic: none, its panels place themselves). */
export function regionsOf(mode: LayoutMode, mobile: boolean, tiles: Region[] = TILE_REGIONS): Region[] {
    if (mode === "classic") {
        return []
    }
    if (mode === "tiles") {
        // on a phone the sticks are the drive tile and Settings is the bottom sheet
        return mobile ? tiles.filter((region) => region !== "drive" && region !== "settings") : tiles
    }
    // Split's drive keys are in the rail; on a phone (sticks) and in the Cockpit they keep their own spot
    return mode === "split" && !mobile ? ["camera", "scene", "map", "drive"] : ["camera", "scene", "map"]
}

/**
 * Each region's box for this layout and window. A region left out isn't shown (it's maximized away, or the layout has
 * no place for it); the drive region left out keeps its own spot (bottom corner, or the sticks), so it never goes.
 */
export function regionRects(mode: LayoutMode, frame: Frame, tiles: Region[] = TILE_REGIONS, maximizedRegion: Region | null = null): Partial<Record<Region, Rect>> {
    const shown = regionsOf(mode, frame.mobile, tiles)
    if (!shown.length) {
        return {}
    }
    const { width, height, top, gap, mobile } = frame
    const bottom = height - frame.bottom
    const sideColumn = mode === "split" && frame.sidePanel && !mobile ? Math.min(SIDE_COLUMN, width * 0.4) : 0
    // the area the docked regions share (Tiles on a phone stays above the sticks)
    const area: Rect = mode === "cockpit"
        ? { x: 0, y: top, width, height: bottom - top }
        : { x: gap, y: top + gap, width: width - 2 * gap - (sideColumn ? sideColumn + gap : 0), height: bottom - top - 2 * gap - (mode === "tiles" && mobile ? frame.sticks : 0) }
    if (maximizedRegion && shown.includes(maximizedRegion)) {
        return { [maximizedRegion]: round(area) }
    }
    const rects: Partial<Record<Region, Rect>> = {}
    if (mode === "cockpit") {
        // the camera under everything; the map and the 3D view as insets (on a phone: the top corners, above the sticks)
        rects.camera = area
        if (mobile) {
            const size = clamp(width * 0.42, 120, 260)
            rects.map = { x: gap, y: top + gap, width: size, height: size }
            rects.scene = { x: width - gap - size, y: top + gap, width: size, height: size * 0.8 }
        } else {
            const mapSize = clamp(Math.min(width, area.height) * 0.3, 180, 320)
            const sceneWidth = clamp(width * 0.26, 240, 440)
            rects.map = { x: gap, y: bottom - gap - mapSize, width: mapSize, height: mapSize }
            rects.scene = { x: width - gap - sceneWidth, y: bottom - gap - sceneWidth * 0.66, width: sceneWidth, height: sceneWidth * 0.66 }
            // the drive keys: centered between the insets, at the bottom
            rects.drive = { x: rects.map.width + 2 * gap, y: bottom - gap - 120, width: width - rects.map.width - sceneWidth - 4 * gap, height: 120 }
        }
    } else if (mode === "split") {
        if (mobile) {
            // stacked: camera, the map as a strip, the 3D view (under the sticks, like Classic's)
            const cameraHeight = area.height * 0.36, strip = clamp(area.height * 0.16, 80, 160)
            rects.camera = { x: area.x, y: area.y, width: area.width, height: cameraHeight }
            rects.map = { x: area.x, y: area.y + cameraHeight + gap, width: area.width, height: strip }
            rects.scene = { x: area.x, y: area.y + cameraHeight + strip + 2 * gap, width: area.width, height: area.height - cameraHeight - strip - 2 * gap }
        } else {
            const rail = clamp(area.width * 0.2, 200, 320)
            const driveHeight = 112
            rects.map = { x: area.x, y: area.y, width: rail, height: area.height - driveHeight - gap }
            rects.drive = { x: area.x, y: area.y + area.height - driveHeight, width: rail, height: driveHeight }
            const main: Rect = { x: area.x + rail + gap, y: area.y, width: area.width - rail - gap, height: area.height }
            // two equal halves, side by side, or stacked when the space is taller than wide
            if (main.width / main.height >= 1.2) {
                const half = (main.width - gap) / 2
                rects.camera = { ...main, width: half }
                rects.scene = { ...main, x: main.x + half + gap, width: half }
            } else {
                const half = (main.height - gap) / 2
                rects.camera = { ...main, height: half }
                rects.scene = { ...main, y: main.y + half + gap, height: half }
            }
        }
        if (sideColumn) {
            rects.settings = { x: width - gap - sideColumn, y: area.y, width: sideColumn, height: area.height }
        }
    } else {
        // equal tiles in reading order: 3 columns on a wide screen, else 2
        const columns = !mobile && width >= 1200 ? 3 : 2
        const rows = Math.ceil(shown.length / columns)
        const tileWidth = (area.width - (columns - 1) * gap) / columns, tileHeight = (area.height - (rows - 1) * gap) / rows
        shown.forEach((region, index) => {
            const column = index % columns, row = Math.floor(index / columns)
            rects[region] = { x: area.x + column * (tileWidth + gap), y: area.y + row * (tileHeight + gap), width: tileWidth, height: tileHeight }
        })
    }
    return Object.fromEntries(Object.entries(rects).map(([region, rect]) => [region, round(rect)]))
}
