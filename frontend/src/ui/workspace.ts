// The page's one panel system: a main view (the stage) between a left and a right rail, plus panels floating over the
// stage. Every panel (each camera, the map, the 3D view, status, network, settings, TF) sits in exactly one place: the
// stage, a rail (stacked top to bottom) or floating; any panel can go to any place, and a rail or floating panel folds
// to its header (its rail's other panels take the height). Dragging a header snaps it
// into a rail (near or over it), onto the stage (its middle: swap), or leaves it floating, its edges snapping to the
// stage, the rails and the other floating panels. The arrangement is this viewer's (localStorage `lv.workspace`: a
// phone and a desktop each keep their own). On a phone the rails are drawers over the stage.
// Pure (no React, no DOM): the boxes are worked out here and unit tested (test/workspace.test.ts).
import { Store } from "../core/store.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"

export type Side = "left" | "right"
export type Zone = Side | "stage" | "float"

export interface Rect {
    x: number
    y: number
    width: number
    height: number
}

export interface Arrangement {
    /** the panel in the main view (null: empty) */
    stage: string | null
    /** the one that was in the main view before it (minimize brings it back) */
    previousStage?: string | null
    left: string[]
    right: string[]
    floating: (Rect & { id: string })[]
    /** folded to their header (a stage panel is never folded) */
    collapsed: string[]
    leftWidth: number
    rightWidth: number
    /** a rail panel's share of its rail's height (the splitter between two panels moves it) */
    weights: Record<string, number>
    /** where a panel last floated, so popping it out again puts it back there */
    floatMemory: Record<string, Rect>
}

/** every panel's header height (styles.css .lv-panel > .panel-head) */
export const PANEL_HEAD = 34
export const RAIL_MIN = 220
export const RAIL_MAX = 640
export const FLOAT_MIN = { width: 220, height: 140 }
/** a header dropped within this many px of the window's side goes into that rail, even an empty (hidden) one */
export const EDGE_SNAP = 56
/** a floating panel's edge this close to another edge lands on it */
export const SNAP_PX = 14
const MIN_BODY = 72

/** Where each panel lives until it's moved, and its share of a rail. */
const HOMES: Record<string, { side: Side; collapsed?: boolean; weight: number; float: { width: number; height: number } }> = {
    map: { side: "left", weight: 1, float: { width: 340, height: 340 } },
    scene: { side: "left", weight: 1.15, float: { width: 420, height: 320 } },
    status: { side: "right", weight: 0.75, float: { width: 320, height: 300 } },
    settings: { side: "right", weight: 1.5, float: { width: 360, height: 520 } },
    arms: { side: "right", weight: 1.5, float: { width: 360, height: 560 } },
    tf: { side: "right", collapsed: true, weight: 1, float: { width: 340, height: 420 } },
}
const CAMERA_HOME = { side: "left" as Side, weight: 1, float: { width: 480, height: 270 + PANEL_HEAD } }
export const isCamera = (id: string) => id.startsWith("camera:")
export const cameraId = (n: number) => `camera:${n}`
export const homeOf = (id: string) => HOMES[id] ?? CAMERA_HOME
/** shown only while there are arms to control (ui/ArmsPanel.tsx) */
export const ARMS_PANEL = "arms"
/** the panels that always exist (cameras come and go: camera:<n>, and so do the arms) */
export const FIXED_PANELS = Object.keys(HOMES).filter((id) => id !== ARMS_PANEL)

export function defaultArrangement(ids: string[]): Arrangement {
    return normalizeArrangement(null, ids)
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/**
 * A saved arrangement made safe for the panels there are now: each known panel exactly once (an unknown or repeated one
 * dropped), a panel it doesn't mention placed at home (the first camera on the stage when it's free), sizes finite.
 */
export function normalizeArrangement(saved: Partial<Arrangement> | null | undefined, ids: string[]): Arrangement {
    const known = new Set(ids)
    const seen = new Set<string>()
    const take = (id: unknown): id is string => {
        if (typeof id !== "string" || !known.has(id) || seen.has(id)) {
            return false
        }
        seen.add(id)
        return true
    }
    const list = (value: unknown) => Array.isArray(value) ? value.filter(take) : []
    let stage = take(saved?.stage) ? saved!.stage! : null
    const left = list(saved?.left)
    const right = list(saved?.right)
    const floating = (Array.isArray(saved?.floating) ? saved.floating : [])
        .filter((box) => box && [box.x, box.y, box.width, box.height].every(finite) && take(box.id))
        .map((box) => ({ id: box.id, x: box.x, y: box.y, width: Math.max(FLOAT_MIN.width, box.width), height: Math.max(PANEL_HEAD, box.height) }))
    const collapsed = new Set(Array.isArray(saved?.collapsed) ? saved.collapsed.filter((id) => known.has(id)) : [])
    for (const id of ids) {
        if (seen.has(id)) {
            continue
        }
        const home = homeOf(id)
        if (stage === null && isCamera(id)) {
            stage = id
        } else if (isCamera(id)) {
            // a camera added later: top of the left rail
            left.unshift(id)
        } else {
            ;(home.side === "left" ? left : right).push(id)
            if (home.collapsed) {
                collapsed.add(id)
            }
        }
        seen.add(id)
    }
    if (stage) {
        collapsed.delete(stage)
    }
    const weights: Record<string, number> = {}
    for (const [id, weight] of Object.entries(saved?.weights ?? {})) {
        if (known.has(id) && finite(weight) && weight > 0) {
            weights[id] = clamp(weight, 0.1, 10)
        }
    }
    const floatMemory: Record<string, Rect> = {}
    for (const [id, box] of Object.entries(saved?.floatMemory ?? {})) {
        if (known.has(id) && box && [box.x, box.y, box.width, box.height].every(finite)) {
            floatMemory[id] = { x: box.x, y: box.y, width: box.width, height: box.height }
        }
    }
    const previousStage = typeof saved?.previousStage === "string" && known.has(saved.previousStage) &&
            saved.previousStage !== stage
        ? saved.previousStage
        : null
    return {
        stage,
        previousStage,
        left,
        right,
        floating,
        collapsed: [...collapsed],
        leftWidth: finite(saved?.leftWidth) ? clamp(saved.leftWidth, RAIL_MIN, RAIL_MAX) : 320,
        rightWidth: finite(saved?.rightWidth) ? clamp(saved.rightWidth, RAIL_MIN, RAIL_MAX) : 340,
        weights,
        floatMemory,
    }
}

// ---- where a panel is, and moving it ----

export function locate(arrangement: Arrangement, id: string): { zone: Zone; index: number } | null {
    if (arrangement.stage === id) {
        return { zone: "stage", index: 0 }
    }
    for (const zone of ["left", "right"] as const) {
        const index = arrangement[zone].indexOf(id)
        if (index >= 0) {
            return { zone, index }
        }
    }
    const floating = arrangement.floating.findIndex((box) => box.id === id)
    return floating >= 0 ? { zone: "float", index: floating } : null
}

/** The arrangement without `id` anywhere (a floating panel's box is remembered for its next pop-out). */
function without(arrangement: Arrangement, id: string): Arrangement {
    const box = arrangement.floating.find((other) => other.id === id)
    return {
        ...arrangement,
        stage: arrangement.stage === id ? null : arrangement.stage,
        left: arrangement.left.filter((other) => other !== id),
        right: arrangement.right.filter((other) => other !== id),
        floating: arrangement.floating.filter((other) => other.id !== id),
        floatMemory: box ? { ...arrangement.floatMemory, [id]: { x: box.x, y: box.y, width: box.width, height: box.height } } : arrangement.floatMemory,
    }
}

export type Placement = { zone: Side; index: number } | { zone: "stage" } | { zone: "float"; box: Rect }

const expand = (arrangement: Arrangement, id: string): Arrangement => ({ ...arrangement, collapsed: arrangement.collapsed.filter((other) => other !== id) })

/**
 * `id` moved to `to`. Onto the stage it swaps: the panel there takes the moved one's old place (its rail slot, its
 * floating box; from nowhere, its home rail). A rail index counts the rail without the moved panel.
 */
export function movePanel(arrangement: Arrangement, id: string, to: Placement): Arrangement {
    const from = locate(arrangement, id)
    const fromBox = arrangement.floating.find((box) => box.id === id)
    let next = without(arrangement, id)
    if (to.zone === "stage") {
        const previous = arrangement.stage
        next = { ...expand(next, id), stage: id, previousStage: previous && previous !== id ? previous : null }
        if (previous && previous !== id) {
            if (from?.zone === "left" || from?.zone === "right") {
                const rail = next[from.zone].slice()
                rail.splice(from.index, 0, previous)
                next = { ...next, [from.zone]: rail }
            } else if (from?.zone === "float" && fromBox) {
                next = { ...next, floating: [...next.floating, { ...fromBox, id: previous }] }
            } else {
                const side = homeOf(previous).side
                next = { ...next, [side]: [...next[side], previous] }
            }
        }
        return next
    }
    if (to.zone === "float") {
        return { ...next, floating: [...next.floating, { id, ...to.box }] }
    }
    const rail = next[to.zone].slice()
    rail.splice(clamp(Math.round(to.index), 0, rail.length), 0, id)
    return { ...next, [to.zone]: rail }
}

/**
 * The main view's panel goes back to a rail: the one that was main before it takes its place again (a swap, so it lands
 * where that one was), or else the top of its home rail, or any rail panel. Unchanged when there's nothing to swap in.
 */
export function minimizeStage(arrangement: Arrangement): Arrangement {
    const id = arrangement.stage
    if (!id) {
        return arrangement
    }
    const inRail = (other: string | null | undefined): other is string =>
        !!other && other !== id && (arrangement.left.includes(other) || arrangement.right.includes(other) || arrangement.floating.some((box) => box.id === other))
    const home = homeOf(id).side
    const replacement = [arrangement.previousStage, arrangement[home][0], ...arrangement.left, ...arrangement.right].find(inRail)
    return replacement ? movePanel(arrangement, replacement, { zone: "stage" }) : arrangement
}

export function toggleCollapsed(arrangement: Arrangement, id: string): Arrangement {
    if (arrangement.stage === id) {
        return arrangement
    }
    return arrangement.collapsed.includes(id) ? expand(arrangement, id) : { ...arrangement, collapsed: [...arrangement.collapsed, id] }
}

/** Unfolded where it is (somewhere new, e.g. a camera just added: at home). */
export function showPanel(arrangement: Arrangement, id: string): Arrangement {
    let next = expand(arrangement, id)
    if (!locate(arrangement, id)) {
        const side = homeOf(id).side
        next = next.stage === null && isCamera(id) ? movePanel(next, id, { zone: "stage" }) : movePanel(next, id, { zone: side, index: next[side].length })
    }
    return next
}

/** The pop-out button: a floating panel docks into the rail on its side of the window; anything else floats. */
export function popOut(arrangement: Arrangement, id: string, layout: WorkspaceLayout): Arrangement {
    const box = arrangement.floating.find((other) => other.id === id)
    if (box) {
        const side: Side = box.x + box.width / 2 < layout.area.x + layout.area.width / 2 ? "left" : "right"
        return movePanel(arrangement, id, { zone: side, index: arrangement[side].length })
    }
    return expand(movePanel(arrangement, id, { zone: "float", box: floatBoxFor(arrangement, id, layout) }), id)
}

/** Where a panel floats: where it last floated, else its own size in the stage's top-right corner (staggered). */
export function floatBoxFor(arrangement: Arrangement, id: string, layout: WorkspaceLayout): Rect {
    const remembered = arrangement.floatMemory[id]
    const size = remembered ?? { ...homeOf(id).float, x: 0, y: 0 }
    const width = Math.min(Math.max(FLOAT_MIN.width, size.width), layout.area.width - 16)
    const height = Math.min(Math.max(FLOAT_MIN.height, size.height), layout.area.height)
    if (remembered) {
        return clampFloat({ ...remembered, width, height }, layout.area)
    }
    const step = 28 * arrangement.floating.length
    return clampFloat({ x: layout.stage.x + layout.stage.width - width - 16 - step, y: layout.stage.y + 16 + step, width, height }, layout.area)
}

/** A floating box kept reachable inside `area`: its header always on screen. */
export function clampFloat(box: Rect, area: Rect): Rect {
    const width = clamp(box.width, FLOAT_MIN.width, Math.max(FLOAT_MIN.width, area.width))
    const height = clamp(box.height, PANEL_HEAD, Math.max(PANEL_HEAD, area.height))
    return {
        x: Math.round(clamp(box.x, area.x, area.x + area.width - Math.min(width, 120))),
        y: Math.round(clamp(box.y, area.y, area.y + area.height - PANEL_HEAD)),
        width: Math.round(width),
        height: Math.round(height),
    }
}

/** The splitter between two neighbours in a rail moved `delta` px: the pair's shares change, their total doesn't. */
export function resizeSplit(arrangement: Arrangement, above: string, below: string, delta: number, layout: WorkspaceLayout): Arrangement {
    const a = layout.slots[above]?.rect, b = layout.slots[below]?.rect
    if (!a || !b) {
        return arrangement
    }
    const total = a.height + b.height
    const minimum = PANEL_HEAD + MIN_BODY
    const top = clamp(a.height + delta, minimum, total - minimum)
    const share = weightOf(arrangement, above) + weightOf(arrangement, below)
    return { ...arrangement, weights: { ...arrangement.weights, [above]: share * top / total, [below]: share * (total - top) / total } }
}

export function resizeRail(arrangement: Arrangement, side: Side, width: number): Arrangement {
    return { ...arrangement, [side === "left" ? "leftWidth" : "rightWidth"]: Math.round(clamp(width, RAIL_MIN, RAIL_MAX)) }
}

const weightOf = (arrangement: Arrangement, id: string) => arrangement.weights[id] ?? homeOf(id).weight

// ---- the boxes ----

/** The window as the workspace sees it. */
export interface Frame {
    width: number
    height: number
    /** where the panels start (the window's top: nothing across it) */
    top: number
    /** where the action dock (or, on a phone, Desktop's dock) starts */
    bottom: number
    mobile: boolean
}

/** This page's view state (not saved): the phone drawer that's open, and the rails hidden for now (both: focus). */
export interface View {
    drawer: Side | null
    hide: Side[]
}
export const SHOWN: View = { drawer: null, hide: [] }

export interface Slot {
    rect: Rect
    zone: Zone
    collapsed: boolean
    /** not on screen (in a shut drawer, a rail hidden by focus): kept mounted, never drawn */
    hidden: boolean
}

export interface WorkspaceLayout {
    /** everything above the bar */
    area: Rect
    stage: Rect
    rails: Partial<Record<Side, Rect>>
    /** phone: the open drawer's box */
    drawer: Rect | null
    slots: Record<string, Slot>
}

const NOWHERE: Rect = { x: 0, y: 0, width: 0, height: 0 }
const round = (rect: Rect): Rect => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) })

/**
 * The panels of one rail (or drawer) stacked edge to edge in `box`: folded ones their header, the open ones share the
 * rest by weight (fold one and its neighbours take its height).
 */
function stack(arrangement: Arrangement, ids: string[], box: Rect): Record<string, Rect> {
    const rects: Record<string, Rect> = {}
    const open = ids.filter((id) => !arrangement.collapsed.includes(id))
    const free = box.height - PANEL_HEAD * (ids.length - open.length)
    const total = open.reduce((sum, id) => sum + weightOf(arrangement, id), 0) || 1
    let y = box.y
    for (const id of ids) {
        const height = arrangement.collapsed.includes(id) ? PANEL_HEAD : Math.max(PANEL_HEAD + MIN_BODY, free * weightOf(arrangement, id) / total)
        rects[id] = { x: box.x, y, width: box.width, height }
        y += height
    }
    return rects
}

export function layoutWorkspace(arrangement: Arrangement, frame: Frame, view: View = SHOWN): WorkspaceLayout {
    const { width } = frame
    const slots: Record<string, Slot> = {}
    const place = (id: string, rect: Rect, zone: Zone, hidden = false) => {
        slots[id] = { rect: round(rect), zone, collapsed: zone !== "stage" && arrangement.collapsed.includes(id), hidden }
    }
    if (frame.mobile) {
        // the stage fills the screen above the thumb sticks; the rails are drawers over it (never over
        // the sticks: STOP stays in reach)
        const area: Rect = { x: 0, y: frame.top, width, height: frame.bottom - frame.top }
        const drawerWidth = Math.min(width - 40, 380)
        // the right drawer (Status, Settings, TF) is a full screen page under a back bar where the top buttons were
        const drawer = view.drawer === "right"
            ? { x: 0, y: frame.top, width, height: frame.height - frame.top }
            : view.drawer ? { x: 0, y: frame.top, width: drawerWidth, height: area.height } : null
        if (arrangement.stage) {
            place(arrangement.stage, area, "stage")
        }
        for (const side of ["left", "right"] as const) {
            const shown = drawer && view.drawer === side
            const rects = stack(arrangement, arrangement[side], shown ? drawer : NOWHERE)
            for (const id of arrangement[side]) {
                place(id, shown ? rects[id] : NOWHERE, side, !shown)
            }
        }
        // floating panels float over the stage here too, never wider than the screen
        for (const box of arrangement.floating) {
            const clamped = clampFloat({ ...box, width: Math.min(box.width, width - 16) }, area)
            place(box.id, { ...clamped, height: arrangement.collapsed.includes(box.id) ? PANEL_HEAD : clamped.height }, "float")
        }
        return { area, stage: area, rails: {}, drawer: drawer && round(drawer), slots }
    }

    // every panel edge to edge: the rails against the window's sides, the main view between them
    const area: Rect = { x: 0, y: frame.top, width, height: frame.bottom - frame.top }
    // the rails never take more than 60% of the width between them
    const railBudget = Math.max(0, area.width * 0.6)
    let leftWidth = arrangement.left.length && !view.hide.includes("left") ? arrangement.leftWidth : 0
    let rightWidth = arrangement.right.length && !view.hide.includes("right") ? arrangement.rightWidth : 0
    if (leftWidth + rightWidth > railBudget) {
        const scale = railBudget / (leftWidth + rightWidth)
        leftWidth *= scale
        rightWidth *= scale
    }
    const rails: Partial<Record<Side, Rect>> = {}
    if (leftWidth) {
        rails.left = { x: area.x, y: area.y, width: leftWidth, height: area.height }
    }
    if (rightWidth) {
        rails.right = { x: area.x + area.width - rightWidth, y: area.y, width: rightWidth, height: area.height }
    }
    const stageX = area.x + leftWidth
    const stage: Rect = { x: stageX, y: area.y, width: area.x + area.width - rightWidth - stageX, height: area.height }
    if (arrangement.stage) {
        place(arrangement.stage, stage, "stage")
    }
    for (const side of ["left", "right"] as const) {
        const rail = rails[side]
        const rects = rail ? stack(arrangement, arrangement[side], rail) : {}
        for (const id of arrangement[side]) {
            place(id, rects[id] ?? NOWHERE, side, !rail)
        }
    }
    for (const box of arrangement.floating) {
        const clamped = clampFloat(box, area)
        place(box.id, { ...clamped, height: arrangement.collapsed.includes(box.id) ? PANEL_HEAD : clamped.height }, "float")
    }
    return { area: round(area), stage: round(stage), rails: Object.fromEntries(Object.entries(rails).map(([side, rect]) => [side, round(rect)])), drawer: null, slots }
}

// ---- dragging: where a header dropped here would go ----

export type DropTarget = Placement & { preview: Rect }

const inside = (point: { x: number; y: number }, rect: Rect | undefined, margin = 0) =>
    !!rect && point.x >= rect.x - margin && point.x <= rect.x + rect.width + margin && point.y >= rect.y - margin && point.y <= rect.y + rect.height + margin

/** the stage's middle: a header dropped here swaps that panel onto the stage */
export function stageTarget(stage: Rect): Rect {
    const width = Math.max(140, stage.width * 0.36), height = Math.max(110, stage.height * 0.36)
    return round({ x: stage.x + (stage.width - width) / 2, y: stage.y + (stage.height - height) / 2, width, height })
}

/**
 * Where `id`'s header, dragged to `pointer` with its box at `box` (the floating size, placed under the pointer), would
 * land: a rail when the pointer is over it or within EDGE_SNAP of the window's side (its index from the pointer's
 * height among the rail's panels), the stage when it's over the stage's middle, else floating at `box` with its edges
 * snapped. `preview` is the box it would get.
 */
export function dropTarget(arrangement: Arrangement, frame: Frame, view: View, id: string, pointer: { x: number; y: number }, box: Rect): DropTarget {
    const layout = layoutWorkspace(arrangement, frame, view)
    const previewOf = (placement: Placement) => layoutWorkspace(movePanel(arrangement, id, placement), frame, { ...view, hide: view.hide.filter((side) => side !== placement.zone) }).slots[id].rect
    for (const side of ["left", "right"] as const) {
        const nearEdge = side === "left" ? pointer.x <= layout.area.x + EDGE_SNAP : pointer.x >= layout.area.x + layout.area.width - EDGE_SNAP
        if (nearEdge || inside(pointer, layout.rails[side])) {
            const others = arrangement[side].filter((other) => other !== id)
            const index = others.filter((other) => {
                const rect = layout.slots[other]?.rect
                return rect && rect.y + rect.height / 2 < pointer.y
            }).length
            const placement = { zone: side, index }
            return { ...placement, preview: previewOf(placement) }
        }
    }
    if (arrangement.stage !== id && inside(pointer, stageTarget(layout.stage))) {
        return { zone: "stage", preview: layout.stage }
    }
    const guides = [layout.area, layout.stage, ...Object.values(layout.rails), ...arrangement.floating.filter((other) => other.id !== id).map((other) => layout.slots[other.id].rect)]
    const snapped = clampFloat(snapBox(box, guides, SNAP_PX), layout.area)
    return { zone: "float", box: snapped, preview: snapped }
}

/** `box` moved so that each of its edges within `threshold` of a guide's edge lies on it (the nearest one per axis). */
export function snapBox(box: Rect, guides: Rect[], threshold: number): Rect {
    const best = (edges: number[], start: number, size: number) => {
        let shift = 0, distance = threshold + 1
        for (const edge of edges) {
            for (const candidate of [edge - start, edge - (start + size)]) {
                if (Math.abs(candidate) < distance) {
                    distance = Math.abs(candidate)
                    shift = candidate
                }
            }
        }
        return distance <= threshold ? shift : 0
    }
    const xs = guides.flatMap((guide) => [guide.x, guide.x + guide.width])
    const ys = guides.flatMap((guide) => [guide.y, guide.y + guide.height])
    return { ...box, x: box.x + best(xs, box.x, box.width), y: box.y + best(ys, box.y, box.height) }
}

// ---- this viewer's arrangement ----

export const WORKSPACE_KEY = "lv.workspace"

export function loadArrangement(ids: string[]): Arrangement {
    return normalizeArrangement(readLocal<Partial<Arrangement> | null>(WORKSPACE_KEY, null), ids)
}

export function saveArrangement(arrangement: Arrangement) {
    writeLocal(WORKSPACE_KEY, arrangement)
}

/** The arrangement in use; every change is saved. */
export const workspace = new Store<{ arrangement: Arrangement }>({ arrangement: loadArrangement([...FIXED_PANELS, cameraId(1)]) })
workspace.subscribe(() => saveArrangement(workspace.get().arrangement))

/** This page's view state (never saved: a reload starts with the drawers shut and the rails shown). */
export const workspaceView = new Store<View>(SHOWN)

export function arrange(change: (arrangement: Arrangement) => Arrangement) {
    const current = workspace.get().arrangement
    const next = change(current)
    if (next !== current) {
        workspace.set({ arrangement: next })
    }
}

export function resetArrangement(ids: string[]) {
    workspaceView.set(SHOWN)
    workspace.set({ arrangement: defaultArrangement(ids) })
}
