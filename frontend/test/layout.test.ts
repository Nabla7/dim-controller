// Settings → Layout: the saved choice (lv.layout, through the backend like every setting), and the boxes each layout
// gives its regions at a desktop's and a phone's size.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { applyRemoteSetting } from "../src/logic/settings.ts"
import {
    DEFAULT_LAYOUT,
    type Frame,
    LAYOUT_SETTING,
    layoutSettings,
    LAYOUTS,
    maximized,
    normalizeLayout,
    type Rect,
    type Region,
    regionRects,
    regionsOf,
    setLayoutMode,
    stickHeight,
    swapTiles,
    TILE_REGIONS,
    toggleMaximized,
} from "../src/logic/layout.ts"

const desktop: Frame = { width: 1440, height: 900, top: 48, bottom: 0, mobile: false, sticks: 0, sidePanel: false, gap: 8 }
const phone: Frame = { width: 390, height: 844, top: 44, bottom: 0, mobile: true, sticks: stickHeight(390, 844), sidePanel: false, gap: 8 }

const inside = (rect: Rect, frame: Frame) => rect.x >= 0 && rect.y >= frame.top && rect.x + rect.width <= frame.width && rect.y + rect.height <= frame.height - frame.bottom && rect.width > 0 && rect.height > 0
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

Deno.test("the default layout is Classic (today's page), and Classic docks nothing", () => {
    assertEquals(DEFAULT_LAYOUT.mode, "classic")
    assertEquals(normalizeLayout(undefined), { mode: "classic", tiles: TILE_REGIONS })
    assertEquals(regionRects("classic", desktop), {})
    assertEquals(regionsOf("classic", false), [])
    assertEquals(LAYOUTS.map((layout) => layout.id), ["classic", "cockpit", "split", "tiles"])
})

Deno.test("a saved layout is checked: an unknown mode is Classic, the tile order keeps every tile once", () => {
    assertEquals(normalizeLayout({ mode: "split" }).mode, "split")
    assertEquals(normalizeLayout({ mode: "bogus" as never }).mode, "classic")
    assertEquals(normalizeLayout({ mode: "tiles", tiles: ["map", "map", "nope" as Region, "camera"] }).tiles, ["map", "camera", "scene", "drive", "status", "settings"])
    assertEquals(normalizeLayout({ tiles: "camera" as never }).tiles, TILE_REGIONS)
})

Deno.test("the layout is a backend setting: a saved or remote value switches it, a pick is sent back", async () => {
    // a page loads (or another page / the agent changes) lv.layout: the store takes it
    applyRemoteSetting(LAYOUT_SETTING, { mode: "cockpit" })
    assertEquals(normalizeLayout(layoutSettings.get()).mode, "cockpit")
    applyRemoteSetting(LAYOUT_SETTING, { mode: "tiles", tiles: ["status", "camera"] })
    assertEquals(normalizeLayout(layoutSettings.get()).tiles.slice(0, 2), ["status", "camera"])

    // picking one here PATCHes api/settings (what the page's other settings do) and gives a maximized region back
    const sent: { key: string; value: { mode: string } }[] = []
    const realFetch = globalThis.fetch
    const hadLocation = "location" in globalThis
    Object.defineProperty(globalThis, "location", { value: new URL("http://127.0.0.1/apps/dim-controller/"), configurable: true })
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)))
        return Promise.resolve(new Response("{}"))
    }) as typeof fetch
    try {
        toggleMaximized("map")
        assertEquals(maximized.get().region, "map")
        setLayoutMode("split")
        assertEquals(maximized.get().region, null)
        assertEquals(layoutSettings.get().mode, "split")
        await new Promise((resolve) => setTimeout(resolve, 300))
        assertEquals(sent.at(-1)?.key, LAYOUT_SETTING)
        assertEquals(sent.at(-1)?.value.mode, "split")
        // the echo of our own change doesn't undo a newer local pick
        setLayoutMode("classic")
        applyRemoteSetting(LAYOUT_SETTING, { mode: "split" })
        assertEquals(layoutSettings.get().mode, "classic")
        await new Promise((resolve) => setTimeout(resolve, 800))
    } finally {
        globalThis.fetch = realFetch
        if (!hadLocation) {
            delete (globalThis as { location?: unknown }).location
        }
    }
})

Deno.test("maximize toggles one region at a time", () => {
    maximized.set({ region: null })
    toggleMaximized("camera")
    toggleMaximized("scene")
    assertEquals(maximized.get().region, "scene")
    toggleMaximized("scene")
    assertEquals(maximized.get().region, null)
})

Deno.test("swapping tiles trades two places and leaves the rest", () => {
    assertEquals(swapTiles(TILE_REGIONS, "camera", "status"), ["status", "scene", "map", "drive", "camera", "settings"])
    assertEquals(swapTiles(TILE_REGIONS, "camera", "camera"), TILE_REGIONS)
    assertEquals(swapTiles(["camera", "map"], "camera", "drive"), ["camera", "map"])
})

for (const frame of [desktop, phone]) {
    const name = frame.mobile ? "phone" : "desktop"

    Deno.test(`Cockpit (${name}): the camera fills the page, the map and 3D view are insets on it that don't overlap`, () => {
        const rects = regionRects("cockpit", frame)
        assertEquals(rects.camera, { x: 0, y: frame.top, width: frame.width, height: frame.height - frame.top })
        for (const region of ["map", "scene"] as const) {
            assert(inside(rects[region]!, frame), `${region} ${JSON.stringify(rects[region])}`)
            assert(rects[region]!.width < frame.width / 2)
        }
        assert(!overlap(rects.map!, rects.scene!))
        if (frame.mobile) {
            // the sticks keep the bottom: the insets sit above them
            for (const region of ["map", "scene"] as const) {
                assert(rects[region]!.y + rects[region]!.height <= frame.height - frame.sticks)
            }
            assertEquals(rects.drive, undefined)
        } else {
            assert(!overlap(rects.drive!, rects.map!) && !overlap(rects.drive!, rects.scene!))
        }
    })

    Deno.test(`Split (${name}): camera and 3D view the same size, the map beside them, nothing overlapping`, () => {
        const rects = regionRects("split", frame)
        const shown = Object.entries(rects) as [Region, Rect][]
        assertEquals(shown.map(([region]) => region).sort(), (frame.mobile ? ["camera", "map", "scene"] : ["camera", "drive", "map", "scene"]).sort())
        for (const [region, rect] of shown) {
            assert(inside(rect, frame), `${region} ${JSON.stringify(rect)}`)
        }
        for (const [a, first] of shown) {
            for (const [b, second] of shown) {
                assert(a === b || !overlap(first, second), `${a} overlaps ${b}`)
            }
        }
        if (!frame.mobile) {
            assertEquals(rects.camera!.width, rects.scene!.width)
            assertEquals(rects.camera!.height, rects.scene!.height)
            // a side tab open: a column for it, the halves smaller (stacked, once they'd be taller than wide)
            const withColumn = regionRects("split", { ...frame, sidePanel: true })
            const area = (rect: Rect) => rect.width * rect.height
            assert(withColumn.settings && inside(withColumn.settings, frame))
            assert(area(withColumn.camera!) < area(rects.camera!))
            assertEquals(area(withColumn.camera!), area(withColumn.scene!))
            assert(!overlap(withColumn.settings, withColumn.scene!))
        }
    })

    Deno.test(`Tiles (${name}): equal tiles in the saved order, inside the page, above the sticks`, () => {
        const order = swapTiles(TILE_REGIONS, "camera", "map")
        const rects = regionRects("tiles", frame, order)
        const shown = regionsOf("tiles", frame.mobile, order)
        assertEquals(Object.keys(rects).sort(), [...shown].sort())
        // a phone: the sticks are the drive tile and Settings is the bottom sheet
        assertEquals(shown.includes("drive"), !frame.mobile)
        const sizes = new Set(shown.map((region) => `${rects[region]!.width}x${rects[region]!.height}`))
        assert(sizes.size <= 2, `tiles should be equal (±1 px rounding): ${[...sizes]}`)
        for (const region of shown) {
            assert(inside(rects[region]!, frame), region)
            assert(rects[region]!.y + rects[region]!.height <= frame.height - frame.sticks)
        }
        // reading order follows the saved order: the first tile is top-left
        assertEquals(rects[order[0]]!.x, frame.gap)
        assertEquals(rects[order[0]]!.y, frame.top + frame.gap)
        for (const [index, a] of shown.entries()) {
            for (const b of shown.slice(index + 1)) {
                assert(!overlap(rects[a]!, rects[b]!), `${a} overlaps ${b}`)
            }
        }
    })
}

Deno.test("a maximized region fills the layout's area alone; the others step aside", () => {
    for (const mode of ["cockpit", "split", "tiles"] as const) {
        const rects = regionRects(mode, desktop, TILE_REGIONS, "scene")
        assertEquals(Object.keys(rects), ["scene"])
        assert(rects.scene!.width >= desktop.width - 2 * desktop.gap && rects.scene!.height >= desktop.height - desktop.top - 2 * desktop.gap)
    }
    // a region the layout doesn't have can't take the page
    assert(Object.keys(regionRects("cockpit", desktop, TILE_REGIONS, "status")).length > 1)
})

Deno.test("Split stacks its halves when the space is taller than wide", () => {
    const tall = regionRects("split", { ...desktop, width: 900, height: 1200 })
    assertEquals(tall.camera!.x, tall.scene!.x)
    assert(tall.scene!.y > tall.camera!.y)
})
