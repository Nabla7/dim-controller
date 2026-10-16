// The 2D map's model: the north-up view, grid and cloud images, the trail, and which topic it draws.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import {
    chooseMapTopic,
    chooseOverlay,
    DEFAULT_FOLLOW_FRAME,
    followFrameOptions,
    MapFollow,
    wheelGesture,
    fitView,
    heatLut,
    isValidView,
    MIN_FIT_SPAN,
    floorPose,
    gridLut,
    gridPixels,
    type MapView,
    niceLength,
    pan,
    projectCloud,
    screenToWorld,
    Trail,
    worldToScreen,
    zoomAt,
    DEFAULT_SLICE,
    sliceRange,
} from "../src/core/map2d.ts"
import { parseKey, rememberTopics, type Topic } from "../src/core/transport.ts"
import { LAYOUT_KEY, loadMapLayout, mapLayout, updateMapLayout } from "../src/ui/mapLayout.ts"

const topic = (name: string, type: string): Topic => parseKey(`dimos${name}/${type}`)!

Deno.test("north-up: +x is right, +y is up, the center is the middle", () => {
    const view: MapView = { centerX: 2, centerY: 3, metersPerPixel: 0.1 }
    assertEquals(worldToScreen(view, 200, 100, 2, 3), [100, 50])
    assertEquals(worldToScreen(view, 200, 100, 3, 3), [110, 50])
    assertEquals(worldToScreen(view, 200, 100, 2, 4), [100, 40])
    const [x, y] = screenToWorld(view, 200, 100, 110, 40)
    assertAlmostEquals(x, 3)
    assertAlmostEquals(y, 4)
})

Deno.test("zooming keeps the point under the cursor; panning moves the content with the drag", () => {
    const view: MapView = { centerX: 0, centerY: 0, metersPerPixel: 0.1 }
    const under = screenToWorld(view, 300, 200, 40, 170)
    const zoomed = zoomAt(view, 300, 200, 40, 170, 2)
    assertAlmostEquals(zoomed.metersPerPixel, 0.05)
    const after = screenToWorld(zoomed, 300, 200, 40, 170)
    assertAlmostEquals(after[0], under[0])
    assertAlmostEquals(after[1], under[1])
    // dragging right by 10 px: what was at the center is now 10 px right of it
    const moved = pan(view, 10, 0)
    assertEquals(worldToScreen(moved, 300, 200, 0, 0), [160, 100])
    // zoom stays within its limits
    assertEquals(zoomAt(view, 300, 200, 0, 0, 1e9).metersPerPixel, 0.002)
})

Deno.test("fit shows the whole box", () => {
    const view = fitView([-10, 0, 10, 5], 200, 200)!
    assertEquals([view.centerX, view.centerY], [0, 2.5])
    assert(view.metersPerPixel >= 0.1)
})

Deno.test("fit with empty or degenerate data never makes a view that blanks the map", () => {
    // no data (the empty box a min/max scan of nothing leaves), NaN, a reversed box: no view, the old one stays
    assertEquals(fitView([Infinity, Infinity, -Infinity, -Infinity], 300, 300), null)
    assertEquals(fitView([NaN, 0, 1, 1], 300, 300), null)
    assertEquals(fitView([1, 1, 0, 0], 300, 300), null)
    // a single point: centered on it, but not zoomed in past a few meters across
    const point = fitView([3, 4, 3, 4], 300, 300)!
    assertEquals([point.centerX, point.centerY], [3, 4])
    assert(point.metersPerPixel * 300 >= MIN_FIT_SPAN)
    // a canvas with no size yet still gives a usable view
    assert(isValidView(fitView([0, 0, 10, 10], 0, 0)))
    assert(!isValidView({ centerX: NaN, centerY: 0, metersPerPixel: 0.05 }))
    assert(!isValidView({ centerX: 0, centerY: 0, metersPerPixel: 0 }))
    assert(!isValidView(null))
})

Deno.test("a pose seen from above: position and yaw", () => {
    const yaw = 0.7
    // column-major rotation about z by yaw, translated to (1, 2, 3)
    const elements = [Math.cos(yaw), Math.sin(yaw), 0, 0, -Math.sin(yaw), Math.cos(yaw), 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]
    const pose = floorPose(elements)
    assertEquals([pose.x, pose.y], [1, 2])
    assertAlmostEquals(pose.yaw, yaw)
})

Deno.test("scale bar lengths are 1/2/5 × 10^n", () => {
    assertEquals(niceLength(7), 5)
    assertEquals(niceLength(3), 2)
    assertEquals(niceLength(1.5), 1)
    assertAlmostEquals(niceLength(0.3), 0.2)
})

Deno.test("grid cells: unknown clear, free, cost between low and high, lethal", () => {
    const lut = gridLut({ free: [10, 10, 10, 255], low: [0, 0, 100, 255], high: [0, 0, 200, 255], lethal: [255, 255, 255, 255], unknown: [0, 0, 0, 0] })
    const pixels = gridPixels(new Int8Array([-1, 0, 50, 100]), 4, 1, lut)
    assertEquals([...pixels.slice(0, 4)], [0, 0, 0, 0])
    assertEquals([...pixels.slice(4, 8)], [10, 10, 10, 255])
    assert(pixels[10] > 100 && pixels[10] < 200)
    assertEquals([...pixels.slice(12, 16)], [255, 255, 255, 255])
})

Deno.test("a cloud from above: placed by its transform, the highest point colors a cell", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]
    const lut = heatLut([[0, 0, 0, 255], [255, 255, 255, 255]])
    const cloud = projectCloud(new Float32Array([0, 0, 0, 0.02, 0.02, 2, 1, 1, 0]), identity, lut, 0.5)!
    assertEquals([cloud.originX, cloud.originY, cloud.cell], [5, 0, 0.5])
    assertEquals([cloud.width, cloud.height], [3, 3])
    // cell (0,0) holds z=0 and z=2: the tall one wins
    assertEquals(cloud.pixels[0], 255)
    // (2,2) holds the floor point; empty cells stay clear
    assertEquals(cloud.pixels[(2 * 3 + 2) * 4 + 3], 255)
    assertEquals(cloud.pixels[(1 * 3 + 0) * 4 + 3], 0)
})

Deno.test("trail: skips jitter, breaks at a jump, stays bounded", () => {
    const trail = new Trail(0.05, 2, 10)
    assert(trail.push(0, 0))
    assert(!trail.push(0.01, 0))
    assert(trail.push(0.1, 0))
    trail.push(10, 0)
    assert(Number.isNaN(trail.points[4]))
    for (let index = 0; index < 50; index++) {
        trail.push(10 + index * 0.1, 0)
    }
    assert(trail.points.length <= 20)
})

Deno.test("heat ramp: cold to hot, never black (the floor shows on a dark background)", () => {
    const lut = heatLut()
    const brightness = (index: number) => lut[index * 4] + lut[index * 4 + 1] + lut[index * 4 + 2]
    assert(brightness(0) > 100)
    assert(brightness(255) > brightness(128) && brightness(128) > brightness(0))
    assertEquals(lut[3], 255)
})

Deno.test("layers: the base is the lidar map (a cloud) or a costmap (a grid), as picked; a costmap overlays a lidar base only when picked", () => {
    const lidar = topic("/lidar", "sensor_msgs.PointCloud2")
    const globalMap = topic("/global_map", "sensor_msgs.PointCloud2")
    const costmap = topic("/global_costmap", "nav_msgs.OccupancyGrid")
    const map = topic("/map", "nav_msgs.OccupancyGrid")
    // lidar (the default): the Go2 sim's global map, else a scan; never a grid
    assertEquals(chooseMapTopic([lidar, globalMap, costmap], "", "lidar")?.name, "/global_map")
    assertEquals(chooseMapTopic([lidar, costmap, map], "", "lidar")?.name, "/lidar")
    assertEquals(chooseMapTopic([costmap, map], "", "lidar"), null)
    assertEquals(chooseMapTopic([globalMap], lidar.key, "lidar")?.name, "/global_map")
    // a picked grid isn't a lidar map
    assertEquals(chooseMapTopic([lidar, costmap], costmap.key, "lidar")?.name, "/lidar")
    // costmap: /map first, else the picked grid; none on the bus → none
    assertEquals(chooseMapTopic([lidar, costmap, map], "", "costmap")?.name, "/map")
    assertEquals(chooseMapTopic([lidar, costmap, map], costmap.key, "costmap")?.name, "/global_costmap")
    assertEquals(chooseMapTopic([lidar, globalMap], "", "costmap"), null)
    assertEquals(chooseMapTopic([topic("/odom", "geometry_msgs.PoseStamped")], "", "lidar"), null)
    // the overlay: off by default, the picked grid when it's on the bus, over a lidar base only
    assertEquals(chooseOverlay([globalMap, costmap], "", "lidar"), null)
    assertEquals(chooseOverlay([globalMap, costmap], costmap.key, "lidar")?.name, "/global_costmap")
    assertEquals(chooseOverlay([globalMap], costmap.key, "lidar"), null)
    assertEquals(chooseOverlay([globalMap, costmap], globalMap.key, "lidar"), null)
    assertEquals(chooseOverlay([globalMap, costmap], costmap.key, "costmap"), null)
})

Deno.test("discovery: a slow topic that misses a round stays listed until it's been gone a while", () => {
    const lidar = topic("/lidar", "sensor_msgs.PointCloud2")
    const globalMap = topic("/global_map", "sensor_msgs.PointCloud2")
    const lastSeen = new Map()
    assertEquals(rememberTopics(lastSeen, [lidar, globalMap], 0, 10_000).map((t) => t.name), ["/global_map", "/lidar"])
    // the 0.5 Hz map wasn't caught by this round's probe: still there (the panel doesn't flip to /lidar and wipe it)
    assertEquals(rememberTopics(lastSeen, [lidar], 2_000, 10_000).map((t) => t.name), ["/global_map", "/lidar"])
    // gone for longer than the window: dropped
    assertEquals(rememberTopics(lastSeen, [lidar], 12_001, 10_000).map((t) => t.name), ["/lidar"])
})

Deno.test("follow: on by default (base_link); a pan suspends it, a zoom keeps it, a re-center resumes it", () => {
    const follow = new MapFollow()
    assertEquals([follow.following, follow.frame], [true, DEFAULT_FOLLOW_FRAME])
    const view: MapView = { centerX: 0, centerY: 0, metersPerPixel: 0.05 }
    const target = { x: 3, y: -2 }
    assertEquals(follow.view(view, target), { centerX: 3, centerY: -2, metersPerPixel: 0.05 })
    // a zoom while following is anchored on the target, wherever the cursor is
    assertEquals(follow.zoomAnchor({ centerX: 3, centerY: -2, metersPerPixel: 0.05 }, 200, 100, 7, 9, target), [100, 50])
    assert(follow.following)
    assertEquals(follow.pan(), true)
    assertEquals(follow.pan(), false)
    assert(!follow.following)
    assertEquals(follow.view(view, target), view)
    assertEquals(follow.zoomAnchor(view, 200, 100, 7, 9, target), [7, 9])
    assertEquals(follow.recenter(), true)
    assertEquals(follow.recenter(), false)
    assertEquals(follow.view(view, target).centerX, 3)
})

Deno.test("follow: a frame not in the tree yet (no target) leaves the view where it is", () => {
    const follow = new MapFollow("odom")
    const view: MapView = { centerX: 1, centerY: 1, metersPerPixel: 0.1 }
    assertEquals(follow.view(view, null), view)
    assertEquals(follow.zoomAnchor(view, 200, 100, 7, 9, null), [7, 9])
    assert(follow.following)
})

Deno.test("follow: a pinch is a zoom until its middle drifts past the slop, then a pan", () => {
    const follow = new MapFollow()
    follow.pinchStart()
    assertEquals(follow.pinchPans(3, 4), false)
    assertEquals(follow.pinchPans(-3, -4), false)
    assert(follow.following)
    assertEquals(follow.pinchPans(0, 3), true)
    assert(!follow.following)
    // not following, every pinch step pans
    follow.pinchStart()
    assertEquals(follow.pinchPans(0, 0.5), true)
    // a new pinch after a re-center starts from no drift
    follow.recenter()
    follow.pinchStart()
    assertEquals(follow.pinchPans(0, 10), false)
})

Deno.test("wheel: vertical scrolls and trackpad pinches zoom, sideways or shift scrolls pan", () => {
    const wheel = (deltaX: number, deltaY: number, ctrlKey = false, shiftKey = false) => wheelGesture({ deltaX, deltaY, ctrlKey, shiftKey })
    assertEquals(wheel(0, 120), "zoom")
    assertEquals(wheel(2, -30), "zoom")
    assertEquals(wheel(40, 3), "pan")
    assertEquals(wheel(0, 120, false, true), "pan")
    assertEquals(wheel(40, 3, true), "zoom")
})

Deno.test("follow frame options: the tree's frames, the chosen one first and waiting when it isn't there", () => {
    assertEquals(followFrameOptions(["base_link", "odom", "world"], "base_link").map((o) => o.frame), ["base_link", "odom", "world"])
    assertEquals(followFrameOptions(["odom", "world"], "base_link"), [{ frame: "base_link", waiting: true }, { frame: "odom", waiting: false }, { frame: "world", waiting: false }])
    assertEquals(followFrameOptions([], "base_link"), [{ frame: "base_link", waiting: true }])
})

Deno.test("layout: the map's own choices are remembered and checked; following is not", () => {
    const fresh = loadMapLayout({})
    assertEquals([fresh.source, fresh.topic, fresh.overlay, fresh.followFrame, fresh.view], ["lidar", "", "", DEFAULT_FOLLOW_FRAME, null])
    assertEquals(loadMapLayout({ source: "costmap" }).source, "costmap")
    assertEquals(loadMapLayout({ source: "nope" } as never).source, "lidar")
    assertEquals(loadMapLayout({ followFrame: "odom" }).followFrame, "odom")
    assertEquals(loadMapLayout({ followFrame: 7 } as never).followFrame, DEFAULT_FOLLOW_FRAME)
    assertEquals(loadMapLayout({ topic: 3 } as never).topic, "")
    // an old entry's follow: false (and its box, now the workspace's) doesn't survive a reload
    assert(!("follow" in loadMapLayout({ follow: false } as never)))
    assert(!("x" in loadMapLayout({ x: 10, collapsed: true } as never)))
})


Deno.test("layout: one store for the map's choices (its cog and Settings → Map change the same one), saved on every change", () => {
    const before = localStorage.getItem(LAYOUT_KEY)
    try {
        updateMapLayout({ topic: "dimos/global_map/sensor_msgs.PointCloud2", followFrame: "odom" })
        assertEquals([mapLayout.get().topic, mapLayout.get().followFrame], ["dimos/global_map/sensor_msgs.PointCloud2", "odom"])
        assertEquals(loadMapLayout().followFrame, "odom")
    } finally {
        before === null ? localStorage.removeItem(LAYOUT_KEY) : localStorage.setItem(LAYOUT_KEY, before)
    }
})

Deno.test("the minimap's height slice: 0.91 m below to 3.66 m above the robot by default, off or without TF keeps everything", () => {
    assertEquals(sliceRange(DEFAULT_SLICE, 10), [10 - 0.91, 10 + 3.66])
    assertEquals(sliceRange({ ...DEFAULT_SLICE, enabled: false }, 10), null)
    assertEquals(sliceRange(DEFAULT_SLICE, null), null)
})

Deno.test("projectCloud with a height range drops points outside it (another floor) and keeps the rest", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const positions = new Float32Array([0, 0, 0.5, 1, 0, 1.0, 0, 1, 8.0])
    const all = projectCloud(positions, identity, heatLut())!
    const sliced = projectCloud(positions, identity, heatLut(), 0.05, [0, 4])!
    const painted = (cloud: { pixels: Uint8ClampedArray }) => cloud.pixels.filter((_, index) => index % 4 === 3 && cloud.pixels[index] > 0).length
    assertEquals(painted(all), 3)
    assertEquals(painted(sliced), 2)
    assertEquals(projectCloud(positions, identity, heatLut(), 0.05, [20, 30]), null)
})

Deno.test("a saved map layout without a slice gets the default one; a broken one falls back field by field", () => {
    assertEquals(loadMapLayout({}).slice, DEFAULT_SLICE)
    assertEquals(loadMapLayout({ slice: { enabled: false, below: -1, above: 2 } } as never).slice, { enabled: false, below: DEFAULT_SLICE.below, above: 2 })
})
