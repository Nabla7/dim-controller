// The 2D map panel's model (no DOM): the north-up view transform, a top-down point cloud heatmap or an OccupancyGrid as
// an RGBA image, the robot's pose and trail on the floor plane, and which topics to draw.
import type { Topic } from "./connection.ts"

export type Rgba = [number, number, number, number]

/** What the panel looks at: the world point at its center and the zoom (meters per CSS pixel). +x right, +y up. */
export interface MapView {
    centerX: number
    centerY: number
    metersPerPixel: number
}

export const MIN_METERS_PER_PIXEL = 0.002
export const MAX_METERS_PER_PIXEL = 2

export function worldToScreen(view: MapView, width: number, height: number, x: number, y: number): [number, number] {
    return [width / 2 + (x - view.centerX) / view.metersPerPixel, height / 2 - (y - view.centerY) / view.metersPerPixel]
}

export function screenToWorld(view: MapView, width: number, height: number, sx: number, sy: number): [number, number] {
    return [view.centerX + (sx - width / 2) * view.metersPerPixel, view.centerY - (sy - height / 2) * view.metersPerPixel]
}

/** Zooms by `factor` (>1 = in) keeping the world point under (sx, sy) where it is. */
export function zoomAt(view: MapView, width: number, height: number, sx: number, sy: number, factor: number): MapView {
    const metersPerPixel = Math.min(MAX_METERS_PER_PIXEL, Math.max(MIN_METERS_PER_PIXEL, view.metersPerPixel / factor))
    const [x, y] = screenToWorld(view, width, height, sx, sy)
    return { centerX: x - (sx - width / 2) * metersPerPixel, centerY: y + (sy - height / 2) * metersPerPixel, metersPerPixel }
}

/** Moves the view so the content follows a drag of (dx, dy) CSS pixels. */
export function pan(view: MapView, dx: number, dy: number): MapView {
    return { ...view, centerX: view.centerX - dx * view.metersPerPixel, centerY: view.centerY + dy * view.metersPerPixel }
}

/** the TF frame the map follows unless the viewer picks another */
export const DEFAULT_FOLLOW_FRAME = "base_link"
/** how far (CSS px) a pinch's middle drifts before the pinch counts as a pan, not just a zoom */
export const PINCH_PAN_SLOP_PX = 12

/** A wheel event as a zoom (a mouse wheel, a trackpad pinch, a vertical scroll) or a pan (sideways, or with shift). */
export function wheelGesture(event: { deltaX: number; deltaY: number; ctrlKey: boolean; shiftKey: boolean }): "zoom" | "pan" {
    if (event.ctrlKey) {
        return "zoom"
    }
    return event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) ? "pan" : "zoom"
}

/**
 * Whether the view follows a TF frame. Following is the default (and is never remembered: a reload follows again);
 * any pan (drag, sideways wheel, a pinch whose middle moves) suspends it, a zoom alone keeps it (about the frame), and
 * re-centering resumes it. A frame not in the TF tree yet ("waiting") leaves the view where it is.
 */
export class MapFollow {
    following = true
    #pinchDrift = 0

    constructor(public frame = DEFAULT_FOLLOW_FRAME) {}

    /** a drag, a wheel pan or a fit: true when that stopped following */
    pan(): boolean {
        const was = this.following
        this.following = false
        return was
    }

    /** true when that resumed following */
    recenter(): boolean {
        const was = this.following
        this.following = true
        return !was
    }

    pinchStart() {
        this.#pinchDrift = 0
    }

    /** a pinch step whose middle moved (dx, dy): false while it's still only a zoom (following and within the slop) */
    pinchPans(dx: number, dy: number): boolean {
        if (!this.following) {
            return true
        }
        this.#pinchDrift += Math.hypot(dx, dy)
        if (this.#pinchDrift > PINCH_PAN_SLOP_PX) {
            this.following = false
            return true
        }
        return false
    }

    /** the view, centered on the target while following; unchanged without a target (waiting for its frame) */
    view(view: MapView, target: { x: number; y: number } | null): MapView {
        return this.following && target ? { ...view, centerX: target.x, centerY: target.y } : view
    }

    /** where a zoom at (sx, sy) is anchored: the target while following one (so it stays centered) */
    zoomAnchor(view: MapView, width: number, height: number, sx: number, sy: number, target: { x: number; y: number } | null): [number, number] {
        return this.following && target ? worldToScreen(view, width, height, target.x, target.y) : [sx, sy]
    }
}

/** The frames to offer for following: the TF tree's, with the chosen one first marked waiting when it's not there yet. */
export function followFrameOptions(frames: string[], chosen: string): { frame: string; waiting: boolean }[] {
    const known = frames.map((frame) => ({ frame, waiting: false }))
    return frames.includes(chosen) ? known : [{ frame: chosen, waiting: true }, ...known]
}

/** a fit never zooms in closer than this many meters across (a lone point or an empty map is not a reason to) */
export const MIN_FIT_SPAN = 4

/** A view that's usable: finite and within the zoom limits. */
export const isValidView = (view: unknown): view is MapView => {
    const { centerX, centerY, metersPerPixel } = (view ?? {}) as Partial<MapView>
    return [centerX, centerY, metersPerPixel].every(Number.isFinite) && metersPerPixel! >= MIN_METERS_PER_PIXEL && metersPerPixel! <= MAX_METERS_PER_PIXEL
}

/** The view that shows a world box (minX, minY, maxX, maxY) with a margin; null when the box isn't finite. */
export function fitView(box: [number, number, number, number], width: number, height: number): MapView | null {
    const [minX, minY, maxX, maxY] = box
    if (!box.every(Number.isFinite) || maxX < minX || maxY < minY) {
        return null
    }
    const spanX = Math.max(MIN_FIT_SPAN, maxX - minX), spanY = Math.max(MIN_FIT_SPAN, maxY - minY)
    const metersPerPixel = Math.min(MAX_METERS_PER_PIXEL, Math.max(MIN_METERS_PER_PIXEL, Math.max(spanX / Math.max(1, width), spanY / Math.max(1, height)) * 1.1))
    return { centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2, metersPerPixel }
}

/** A 4×4 column-major matrix (THREE.Matrix4.elements) seen from above: its position on the floor and its heading. */
export function floorPose(elements: ArrayLike<number>): { x: number; y: number; yaw: number } {
    return { x: elements[12], y: elements[13], yaw: Math.atan2(elements[1], elements[0]) }
}

/** The scale bar's length: the largest 1/2/5 × 10^n meters that fits in `maxMeters`. */
export function niceLength(maxMeters: number): number {
    if (!(maxMeters > 0)) {
        return 1
    }
    const power = 10 ** Math.floor(Math.log10(maxMeters))
    for (const step of [5, 2, 1]) {
        if (step * power <= maxMeters) {
            return step * power
        }
    }
    return power
}

export const formatMeters = (meters: number) => meters >= 1000 ? `${meters / 1000} km` : meters >= 1 ? `${meters} m` : `${Math.round(meters * 100)} cm`

export interface GridPalette {
    free: Rgba
    /** cost 1..99 runs from `low` to `high` */
    low: Rgba
    high: Rgba
    lethal: Rgba
    unknown: Rgba
}

/** a costmap's lethal value (dimos marks obstacles 100) */
const LETHAL = 100

const mix = (a: Rgba, b: Rgba, t: number): Rgba => [0, 1, 2, 3].map((index) => Math.round(a[index] + (b[index] - a[index]) * t)) as Rgba

/** cell value (-1..100, as the byte it arrives as) → rgba */
export function gridLut(palette: GridPalette): Uint8ClampedArray {
    const lut = new Uint8ClampedArray(256 * 4)
    for (let byte = 0; byte < 256; byte++) {
        const value = byte > 127 ? byte - 256 : byte
        const rgba = value < 0 ? palette.unknown : value === 0 ? palette.free : value >= LETHAL ? palette.lethal : mix(palette.low, palette.high, Math.sqrt(value / LETHAL))
        lut.set(rgba, byte * 4)
    }
    return lut
}

/** An OccupancyGrid's cells as RGBA, row 0 first (row 0 is the grid's lowest y). Reuses `out` when it's the right size. */
export function gridPixels(data: ArrayLike<number> | Int8Array, width: number, height: number, lut: Uint8ClampedArray, out?: Uint8ClampedArray): Uint8ClampedArray {
    const pixels = out && out.length === width * height * 4 ? out : new Uint8ClampedArray(width * height * 4)
    const bytes = data instanceof Int8Array ? new Uint8Array(data.buffer, data.byteOffset, width * height) : null
    for (let index = 0; index < width * height; index++) {
        const at = (bytes ? bytes[index] : (data[index] & 0xff)) * 4
        const to = index * 4
        pixels[to] = lut[at]
        pixels[to + 1] = lut[at + 1]
        pixels[to + 2] = lut[at + 2]
        pixels[to + 3] = lut[at + 3]
    }
    return pixels
}

export interface ProjectedCloud {
    pixels: Uint8ClampedArray
    width: number
    height: number
    /** world position of pixel (0, 0)'s corner (row 0 is the lowest y) */
    originX: number
    originY: number
    /** meters per pixel */
    cell: number
}

/** the projected image's longest side, at most */
const MAX_CLOUD_PIXELS = 1600

/** a heat ramp (inferno's upper part: no near-black, so the floor still shows on a dark background) */
const HEAT_STOPS: Rgba[] = [[60, 18, 110, 255], [120, 28, 109, 255], [187, 55, 84, 255], [237, 105, 37, 255], [251, 180, 26, 255], [252, 255, 164, 255]]

/** 256 heat colors, cold (0) to hot (255), as RGBA bytes. */
export function heatLut(stops: Rgba[] = HEAT_STOPS): Uint8ClampedArray {
    const lut = new Uint8ClampedArray(256 * 4)
    for (let index = 0; index < 256; index++) {
        const at = (index / 255) * (stops.length - 1), below = Math.min(stops.length - 2, Math.floor(at))
        lut.set(mix(stops[below], stops[below + 1], at - below), index * 4)
    }
    return lut
}

/**
 * A point cloud seen from above, as a heatmap: each point placed by `elements` (cloud frame → fixed frame, column-major
 * 4×4) and binned into `cell`-meter pixels (coarser when the cloud is too big for MAX_CLOUD_PIXELS); a pixel takes
 * the heat of its highest point between the floor (cold) and the tallest (hot), so walls stand out from the floor.
 */
export function projectCloud(positions: Float32Array, elements: ArrayLike<number>, lut: Uint8ClampedArray, cell = 0.05): ProjectedCloud | null {
    const count = Math.floor(positions.length / 3)
    if (!count) {
        return null
    }
    const e = elements
    const xs = new Float32Array(count), ys = new Float32Array(count), zs = new Float32Array(count)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let kept = 0
    for (let index = 0; index < count; index++) {
        const px = positions[index * 3], py = positions[index * 3 + 1], pz = positions[index * 3 + 2]
        if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
            continue
        }
        const x = e[0] * px + e[4] * py + e[8] * pz + e[12]
        const y = e[1] * px + e[5] * py + e[9] * pz + e[13]
        const z = e[2] * px + e[6] * py + e[10] * pz + e[14]
        xs[kept] = x
        ys[kept] = y
        zs[kept] = z
        kept++
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
    }
    if (!kept) {
        return null
    }
    cell = Math.max(cell, (maxX - minX) / MAX_CLOUD_PIXELS, (maxY - minY) / MAX_CLOUD_PIXELS)
    const width = Math.floor((maxX - minX) / cell) + 1, height = Math.floor((maxY - minY) / cell) + 1
    // the height range from the 2nd..98th percentile, so a few stray points don't wash the colors out
    const sorted = zs.slice(0, kept).sort()
    const zLow = sorted[Math.floor(kept * 0.02)], zHigh = sorted[Math.min(kept - 1, Math.floor(kept * 0.98))]
    const top = new Float32Array(width * height).fill(-Infinity)
    for (let index = 0; index < kept; index++) {
        const column = Math.floor((xs[index] - minX) / cell), row = Math.floor((ys[index] - minY) / cell)
        const at = row * width + column
        if (zs[index] > top[at]) {
            top[at] = zs[index]
        }
    }
    const pixels = new Uint8ClampedArray(width * height * 4)
    const span = Math.max(1e-3, zHigh - zLow)
    for (let at = 0; at < width * height; at++) {
        if (top[at] === -Infinity) {
            continue
        }
        const heat = Math.round(255 * Math.min(1, Math.max(0, (top[at] - zLow) / span))) * 4
        pixels[at * 4] = lut[heat]
        pixels[at * 4 + 1] = lut[heat + 1]
        pixels[at * 4 + 2] = lut[heat + 2]
        pixels[at * 4 + 3] = lut[heat + 3]
    }
    return { pixels, width, height, originX: minX, originY: minY, cell }
}

/** Where the robot has been: a polyline on the floor, broken (NaN) at a jump, at most `capacity` points. */
export class Trail {
    points: number[] = []
    #last: [number, number] | null = null
    constructor(readonly minStep = 0.05, readonly jump = 2.5, readonly capacity = 20000) {}

    /** Adds a pose; true when the trail changed. */
    push(x: number, y: number): boolean {
        if (this.#last) {
            const step = Math.hypot(x - this.#last[0], y - this.#last[1])
            if (step < this.minStep) {
                return false
            }
            if (step > this.jump) {
                this.points.push(NaN, NaN)
            }
        }
        this.points.push(x, y)
        this.#last = [x, y]
        if (this.points.length > this.capacity * 2) {
            this.points.splice(0, Math.floor(this.capacity * 0.2) * 2)
        }
        return true
    }

    clear() {
        this.points = []
        this.#last = null
    }
}

export const isGridTopic = (topic: Topic) => topic.type === "nav_msgs.OccupancyGrid"
export const isCloudTopic = (topic: Topic) => topic.type === "sensor_msgs.PointCloud2"

/** an accumulated cloud map (the 3D view's global map) first, other map clouds, single scans, then occupancy grids */
const rank = (topic: Topic) =>
    isCloudTopic(topic)
        ? (/^\/global_map$/.test(topic.name) ? 0 : /map|global|voxel/i.test(topic.name) ? 1 : 2)
        : 10 + (/^\/map$/.test(topic.name) ? 0 : /global/.test(topic.name) ? 1 : /map/.test(topic.name) ? 2 : 3)

/** The topics the panel can draw as its base, best first: point clouds (as a top-down heatmap), then occupancy grids. */
export function mapCandidates(topics: Topic[]): Topic[] {
    return topics.filter((topic) => isGridTopic(topic) || isCloudTopic(topic)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** The picked topic when it's on the bus, else the best candidate ("" picks automatically). */
export function chooseMapTopic(topics: Topic[], picked: string): Topic | null {
    const candidates = mapCandidates(topics)
    return candidates.find((topic) => topic.key === picked) ?? candidates[0] ?? null
}

/** The occupancy grids (costmaps) the panel can lay over its base, best first. */
export const overlayCandidates = (topics: Topic[]): Topic[] => mapCandidates(topics).filter(isGridTopic)

/** The overlay grid: the picked one when it's on the bus and isn't the base; "" (the default) is none. */
export function chooseOverlay(topics: Topic[], picked: string, base: Topic | null): Topic | null {
    return picked && picked !== base?.key ? overlayCandidates(topics).find((topic) => topic.key === picked) ?? null : null
}
