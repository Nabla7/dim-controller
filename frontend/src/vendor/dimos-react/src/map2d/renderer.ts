// The top-down 2D map's renderer (no React): a north-up canvas with a base map (an OccupancyGrid, or a point cloud as a
// height heatmap), an optional costmap over it, a planned path, the robot's pose and trail, the world axes, a meter grid
// and a scale bar. Wheel / pinch zoom and drag pan move the picture; it follows a TF frame until the viewer pans; a click
// that didn't drag reports where it landed (onPick). Colors come from the theme tokens. Every topic's last message is
// kept per map context, so a reopened map or a re-picked topic shows at once. Ported from dim-controller's MapPanel.
import type { DataSource, Topic } from "../data.ts"
import { decode, headerFrameId, type LcmStruct } from "../lcm.ts"
import { poseMatrix } from "../three/layers/pose.tsx"
import type { TfTree } from "../three/tf.ts"
import {
    fitView,
    floorPose,
    formatMeters,
    gridLut,
    gridPixels,
    heatLut,
    isGridTopic,
    isValidView,
    MapFollow,
    niceLength,
    pan,
    projectCloud,
    screenToWorld,
    Trail,
    wheelGesture,
    worldToScreen,
    zoomAt,
} from "./math.ts"
import type { CloudImage, FloorPose, MapBox, MapView, Rgba, RgbaPixels } from "./math.ts"
/** A decoded OccupancyGrid, as the map keeps it. */
interface GridData {
    width: number
    height: number
    resolution: number
    /** the grid's (0,0) corner in `frame` (a geometry_msgs Pose) */
    origin: Parameters<typeof poseMatrix>[0]
    data: ArrayLike<number>
    frame: string
}
/** One topic's last data, kept per map context. */
export interface RetainedMapData {
    grid?: GridData
    gridInfo?: string
    cloudFrame?: string
    cloudPositions?: ArrayLike<number>
    cloudMatrix?: number[]
    cloudInfo?: string
}
/** What the renderer reads through: the data source, the TF tree, the frames to use, the data kept across remounts. */
export interface Map2DContext {
    source: DataSource
    tf: TfTree
    /** each topic's last data (by topic key) */
    retained: Map<string, RetainedMapData>
    fixedFrame: () => string
    robotFrame: () => string
}
export interface Map2DFollowState {
    following: boolean
    /** the followed frame isn't in the TF tree yet */
    waiting: boolean
}
export interface Map2DStatus {
    info: string
    problem: string
}
/** a click that didn't move the map: where it landed in the fixed frame */
export interface Map2DPick {
    x: number
    y: number
    frame: string
    event: PointerEvent
}
/** What the renderer reports. */
export interface Map2DEvents {
    /** the view settled (debounced): remember it to start there next time */
    onView: (view: MapView) => void
    onFollow: (follow: Map2DFollowState) => void
    onStatus: (status: Map2DStatus) => void
    onPick?: (pick: Map2DPick) => void
}
/** Each topic's last data for a map context (`map.retained`, a Map): a reopened map shows it at once. */
function retainedFor(map: Map2DContext, key: string): RetainedMapData {
    let entry = map.retained.get(key)
    if (!entry) {
        map.retained.set(key, entry = {})
    }
    return entry
}
const css = ([r, g, b, a]: Rgba, alpha = 1): string => `rgba(${r}, ${g}, ${b}, ${(a / 255) * alpha})`
const blend = (a: Rgba, b: Rgba, t: number): number[] =>
    [0, 1, 2, 3].map((index) => Math.round(a[index] + (b[index] - a[index]) * t))
/** A theme token (any CSS color, color-mix included) as rgba bytes, read back off a 1×1 canvas. */
function token(name: string): Rgba {
    const probe = document.createElement("span")
    probe.style.color = `var(${name})`
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    const pixel = document.createElement("canvas")
    pixel.width = pixel.height = 1
    const context = pixel.getContext("2d", { willReadFrequently: true })!
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return [r, g, b, a]
}
/** The map's colors, from the theme tokens. */
interface MapPalette {
    background: Rgba
    fg: Rgba
    muted: Rgba
    primary: Rgba
    robot: Rgba
    path: Rgba
    /** CSS colors */
    axisX: string
    axisY: string
    gridLut: RgbaPixels
    overlayLut: RgbaPixels
    heatLut: RgbaPixels
}
function themePalette(): MapPalette {
    const background = token("--scene-bg, var(--bg)")
    const fg = token("--fg"),
        muted = token("--muted-fg"),
        primary = token("--primary")
    const opaque = (color: Rgba): Rgba => [color[0], color[1], color[2], 255]
    const base = opaque(background)
    const clear = [0, 0, 0, 0]
    return {
        background: base,
        fg,
        muted,
        primary,
        robot: token("--warn"),
        path: token("--ok"),
        axisX: css(token("--axis-x")),
        axisY: css(token("--axis-y")),
        // free floor a shade off the background, costs toward the accent, walls in the text color, unknown clear
        gridLut: gridLut({
            free: blend(base, opaque(fg), 0.1),
            low: blend(base, opaque(primary), 0.3),
            high: blend(base, opaque(primary), 0.8),
            lethal: opaque(fg),
            unknown: clear,
        }),
        overlayLut: gridLut({
            free: clear,
            low: [...primary.slice(0, 3), 70],
            high: [...primary.slice(0, 3), 190],
            lethal: [...primary.slice(0, 3), 235],
            unknown: clear,
        }),
        heatLut: heatLut(),
    }
}
/** How far the robot moves (m) or turns (rad) before the map is redrawn for it. */
const POSE_EPSILON = 0.005
const YAW_EPSILON = 0.005
/** the default zoom before there's anything to fit */
const DEFAULT_METERS_PER_PIXEL = 0.05
/** One topic the map draws (the base, or the costmap over it): its subscription, its latest data as an image. */
class MapSource {
    map: Map2DContext
    topic: Topic
    /** the colors to draw it in (read at each rebuild: the theme can change) */
    lut: () => RgbaPixels
    changed: () => void
    grid: GridData | null = null
    gridImage: HTMLCanvasElement | null = null
    #gridPixels: RgbaPixels | undefined
    /** the grid's (0,0) corner in the fixed frame, as last drawn */
    gridPose: FloorPose | null = null
    cloud: CloudImage | null = null
    cloudImage: HTMLCanvasElement | null = null
    #cloudFrame: string | null = null
    /** the last cloud, kept to recolor it on a theme change */
    #cloudPositions: ArrayLike<number> | null = null
    #cloudMatrix: number[] | null = null
    info = ""
    problem = ""
    #stop: (() => void)[] = []
    constructor(map: Map2DContext, topic: Topic, lut: () => RgbaPixels, changed: () => void) {
        this.map = map
        this.topic = topic
        this.lut = lut
        this.changed = changed
        const connection = map.source
        const kept = retainedFor(map, topic.key)
        this.problem = `waiting for ${topic.name}`
        // the last message from before (a collapse, another pick, a discovery gap): drawn now, replaced by the next one
        if (kept.grid) {
            this.grid = kept.grid
            this.info = kept.gridInfo ?? ""
            this.problem = ""
        }
        if (kept.cloudFrame !== undefined) {
            this.#cloudFrame = kept.cloudFrame
        }
        if (kept.cloudPositions && kept.cloudMatrix) {
            this.#cloudPositions = kept.cloudPositions
            this.#cloudMatrix = kept.cloudMatrix
            this.info = kept.cloudInfo ?? ""
            this.problem = ""
        }
        this.rebuild()
        if (isGridTopic(topic)) {
            this.#stop.push(
                connection.subscribe(topic.key, { delivery: "latest", maxHz: 2 }, (message) => {
                    let grid: LcmStruct
                    try {
                        // a decoded message: its shape is checked below
                        grid = (message.value as LcmStruct | undefined) ?? decode(topic.type, message.bytes)
                    } catch (error) {
                        this.#status(this.info, `cannot decode ${topic.name}: ${error}`)
                        return
                    }
                    const { width, height, resolution, origin } = grid.info ?? {}
                    if (!width || !height || !(resolution > 0) || !grid.data || grid.data.length < width * height) {
                        this.#status(this.info, `${topic.name}: empty or truncated grid`)
                        return
                    }
                    this.grid = kept.grid = {
                        width,
                        height,
                        resolution,
                        origin,
                        data: grid.data,
                        frame: grid.header?.frame_id ?? "",
                    }
                    this.gridPose = null
                    this.rebuild()
                    kept.gridInfo = `${width}×${height} @ ${resolution.toFixed(2)} m`
                    this.#status(kept.gridInfo, "")
                }),
            )
            return
        }
        // a cloud: its frame from one raw message (the compact encoding drops the header), then 1 Hz compact clouds
        let frameStop: (() => void) | null = connection.subscribe(
            topic.key,
            { delivery: "latest", maxHz: 1 },
            (message) => {
                const value = message.value as LcmStruct | undefined
                this.#cloudFrame =
                    kept.cloudFrame =
                        (value ? (value.frame ?? value.header?.frame_id) : headerFrameId(topic.type, message.bytes)) ??
                            ""
                frameStop?.()
                frameStop = null
            },
        )
        this.#stop.push(() => frameStop?.())
        this.#stop.push(
            connection.subscribe(
                topic.key,
                { delivery: "latest", maxHz: 1, encoding: "dimos_lcm_pointcloud2" },
                (message) => {
                    const positions = (
                        (message.decoded ?? message.value) as { positions?: ArrayLike<number> } | undefined
                    )?.positions
                    if (!positions || this.#cloudFrame === null) {
                        return
                    }
                    const placed = map.tf.lookup(this.#cloudFrame, map.fixedFrame())
                    if (!placed) {
                        this.#status(this.info, `no TF from "${this.#cloudFrame}" to "${map.fixedFrame()}"`)
                        return
                    }
                    this.#cloudPositions = kept.cloudPositions = positions
                    this.#cloudMatrix = kept.cloudMatrix = placed.elements.slice()
                    this.rebuild()
                    kept.cloudInfo = `${Math.round(positions.length / 3).toLocaleString()} pts`
                    this.#status(kept.cloudInfo, "")
                },
            ),
        )
    }
    dispose() {
        this.#stop.forEach((stop) => stop())
        this.#stop = []
    }
    #status(info: string, problem: string) {
        this.info = info
        this.problem = problem
        this.changed()
    }
    /** the image from the latest data in the current colors */
    rebuild() {
        if (this.grid) {
            this.#gridPixels = gridPixels(
                this.grid.data,
                this.grid.width,
                this.grid.height,
                this.lut(),
                this.#gridPixels,
            )
            this.gridImage = toCanvas(this.#gridPixels, this.grid.width, this.grid.height, this.gridImage)
        }
        if (this.#cloudPositions && this.#cloudMatrix) {
            this.cloud = projectCloud(this.#cloudPositions, this.#cloudMatrix, this.lut())
            this.cloudImage = this.cloud
                ? toCanvas(this.cloud.pixels, this.cloud.width, this.cloud.height, this.cloudImage)
                : null
        }
    }
    /** every 3D frame: the grid's TF placement; true when it moved */
    place(fixedFrame: string): boolean {
        if (!this.grid) {
            return false
        }
        const placed = this.map.tf.lookup(this.grid.frame, fixedFrame)
        if (!placed) {
            const had = !!this.gridPose
            this.gridPose = null
            if (!this.problem) {
                this.#status(this.info, `no TF from "${this.grid.frame}" to "${fixedFrame}"`)
            }
            return had
        }
        const pose = floorPose(placed.clone().multiply(poseMatrix(this.grid.origin)).elements)
        const before = this.gridPose
        if (
            !before ||
            Math.abs(before.x - pose.x) > 1e-4 ||
            Math.abs(before.y - pose.y) > 1e-4 ||
            Math.abs(before.yaw - pose.yaw) > 1e-5
        ) {
            this.gridPose = pose
            if (this.problem.startsWith("no TF")) {
                this.#status(this.info, "")
            }
            return true
        }
        return false
    }
    /** the drawn data's box in the fixed frame, or null */
    bounds(): MapBox | null {
        if (this.grid && this.gridPose) {
            const { width, height, resolution } = this.grid,
                { x, y, yaw } = this.gridPose
            const cos = Math.cos(yaw),
                sin = Math.sin(yaw)
            const corners = [
                [0, 0],
                [width, 0],
                [0, height],
                [width, height],
            ].map(([u, v]) => [x + (u * cos - v * sin) * resolution, y + (u * sin + v * cos) * resolution])
            return [
                Math.min(...corners.map((c) => c[0])),
                Math.min(...corners.map((c) => c[1])),
                Math.max(...corners.map((c) => c[0])),
                Math.max(...corners.map((c) => c[1])),
            ]
        }
        if (this.cloud) {
            const { originX, originY, width, height, cell } = this.cloud
            return [originX, originY, originX + width * cell, originY + height * cell]
        }
        return null
    }
    /** draws itself in world coordinates (the context already maps meters to the screen) */
    draw(context: CanvasRenderingContext2D) {
        if (this.grid && this.gridImage && this.gridPose) {
            context.translate(this.gridPose.x, this.gridPose.y)
            context.rotate(this.gridPose.yaw)
            context.scale(this.grid.resolution, this.grid.resolution)
            context.drawImage(this.gridImage, 0, 0)
        } else if (this.cloud && this.cloudImage) {
            context.translate(this.cloud.originX, this.cloud.originY)
            context.scale(this.cloud.cell, this.cloud.cell)
            context.drawImage(this.cloudImage, 0, 0)
        }
    }
}
/** Draws the map onto its canvas (no React): subscriptions, view, interaction. */
export class Map2DRenderer {
    map: Map2DContext
    canvas: HTMLCanvasElement
    events: Map2DEvents
    #view: MapView
    #fitted: boolean
    #follow: MapFollow
    /** where the followed frame is on the floor, or null while it isn't in the TF tree */
    #target: FloorPose | null = null
    #palette = themePalette()
    #base: MapSource | null = null
    #overlay: MapSource | null = null
    #robot: FloorPose | null = null
    #trail = new Trail()
    #fixedFrame = ""
    #frameRequest = 0
    /** the pointers down on the canvas (by pointerId), where each was last */
    #pointers = new Map<number, { x: number; y: number }>()
    #dragged = false
    #dispose: (() => void)[] = []
    /** a nav_msgs.Path drawn over the map: its poses (x, y) in `frame` */
    #path: { frame: string; points: [number, number][] } | null = null
    #stopPath: (() => void) | null = null
    constructor(
        map: Map2DContext,
        canvas: HTMLCanvasElement,
        view: MapView | null | undefined,
        followFrame: string,
        events: Map2DEvents,
    ) {
        this.map = map
        this.canvas = canvas
        this.events = events
        this.#view = isValidView(view) ? view : { centerX: 0, centerY: 0, metersPerPixel: DEFAULT_METERS_PER_PIXEL }
        this.#fitted = isValidView(view)
        this.#follow = new MapFollow(followFrame)
        // its own frame loop (the 3D view may be off): cheap, it redraws only when something changed
        let loop = 0
        const tick = () => {
            this.#eachFrame()
            loop = requestAnimationFrame(tick)
        }
        loop = requestAnimationFrame(tick)
        this.#dispose.push(() => cancelAnimationFrame(loop))
        const theme = () => {
            this.#palette = themePalette()
            this.#base?.rebuild()
            this.#overlay?.rebuild()
            this.requestDraw()
        }
        addEventListener("dimos-react-theme", theme)
        this.#dispose.push(() => removeEventListener("dimos-react-theme", theme))
        const resize = new ResizeObserver(() => this.requestDraw())
        resize.observe(canvas)
        this.#dispose.push(() => resize.disconnect())
        // a browser zoom or a move to another screen changes the pixel ratio
        const redraw = () => this.requestDraw()
        addEventListener("resize", redraw)
        this.#dispose.push(() => removeEventListener("resize", redraw))
        this.#listen()
        this.#report()
        this.#target = this.#lookupTarget()
        this.#reportFollow()
        this.requestDraw()
    }
    /** Draws a nav_msgs.Path topic over the map (null: none). */
    setPath(topicKey: string | null | undefined) {
        this.#stopPath?.()
        this.#stopPath = null
        this.#path = null
        if (topicKey) {
            const off = this.map.source.subscribe(topicKey, { delivery: "latest", maxHz: 5 }, (message) => {
                let path: LcmStruct
                try {
                    path = (message.value as LcmStruct | undefined) ?? decode("nav_msgs.Path", message.bytes)
                } catch {
                    return
                }
                const points = ((path.poses ?? []) as LcmStruct[]).map((pose): [number, number] => [
                    pose.pose?.position?.x ?? 0,
                    pose.pose?.position?.y ?? 0,
                ])
                this.#path = { frame: path.header?.frame_id ?? "", points }
                this.requestDraw()
            })
            this.#stopPath = () => off()
        }
        this.requestDraw()
    }
    dispose() {
        this.#stopPath?.()
        cancelAnimationFrame(this.#frameRequest)
        this.#base?.dispose()
        this.#overlay?.dispose()
        this.#dispose.forEach((stop) => stop())
    }
    /** follows another TF frame (and resumes following: picking one means "show me that") */
    setFollowFrame(frame: string) {
        if (frame !== this.#follow.frame) {
            this.#follow.frame = frame
            this.#target = this.#lookupTarget()
            this.recenter()
        }
    }
    /** resumes following and centers on the frame now (the zoom stays) */
    recenter() {
        this.#follow.recenter()
        this.#setView(this.#follow.view(this.#view, this.#target))
        this.#reportFollow()
    }
    #reportFollow() {
        this.events.onFollow({ following: this.#follow.following, waiting: !this.#target })
    }
    #lookupTarget(): FloorPose | null {
        const placed = this.map.tf.lookup(this.#follow.frame, this.map.fixedFrame())
        return placed && this.map.tf.has(this.#follow.frame) ? floorPose(placed.elements) : null
    }
    /** the base map and the costmap over it (null: none); a source that didn't change keeps its data */
    setTopics(base: Topic | null | undefined, overlay: Topic | null | undefined) {
        const changed = () => {
            this.#report()
            this.requestDraw()
        }
        if (base?.key !== this.#base?.topic.key) {
            this.#base?.dispose()
            this.#base = base
                ? new MapSource(
                    this.map,
                    base,
                    () => (isGridTopic(base) ? this.#palette.gridLut : this.#palette.heatLut),
                    changed,
                )
                : null
        }
        if (overlay?.key !== this.#overlay?.topic.key) {
            this.#overlay?.dispose()
            this.#overlay = overlay ? new MapSource(this.map, overlay, () => this.#palette.overlayLut, changed) : null
        }
        changed()
    }
    #report() {
        const base = this.#base,
            overlay = this.#overlay
        const info = [base?.info, overlay?.info && `+ ${overlay.topic.name} ${overlay.info}`]
            .filter(Boolean)
            .join(" · ")
        const problem = !base ? "no point cloud or occupancy grid on the bus" : base.problem || overlay?.problem || ""
        this.events.onStatus({ info, problem })
    }
    /** every 3D frame: the robot's pose, the grids' TF placement, the fixed frame; a redraw only when one changed */
    #eachFrame() {
        const fixedFrame = this.map.fixedFrame()
        if (fixedFrame !== this.#fixedFrame) {
            this.#fixedFrame = fixedFrame
            this.#trail.clear()
            this.requestDraw()
        }
        const matrix = this.map.tf.lookup(this.map.robotFrame(), fixedFrame)
        const robot = matrix ? floorPose(matrix.elements) : null
        const old = this.#robot
        if (
            !robot !== !old ||
            (robot &&
                old &&
                (Math.abs(robot.x - old.x) > POSE_EPSILON ||
                    Math.abs(robot.y - old.y) > POSE_EPSILON ||
                    Math.abs(robot.yaw - old.yaw) > YAW_EPSILON))
        ) {
            this.#robot = robot
            if (robot) {
                this.#trail.push(robot.x, robot.y)
                if (!this.#fitted && !this.#bounds()) {
                    this.#view = { ...this.#view, centerX: robot.x, centerY: robot.y }
                }
            }
            this.requestDraw()
        }
        const target = this.#lookupTarget()
        const before = this.#target
        if (
            !target !== !before ||
            (target && before && Math.hypot(target.x - before.x, target.y - before.y) > POSE_EPSILON)
        ) {
            this.#target = target
            if (!target !== !before) {
                this.#reportFollow()
            }
            if (this.#follow.following && target) {
                this.#view = this.#follow.view(this.#view, target)
                this.requestDraw()
            }
        }
        // both run every frame (no short circuit): each keeps its own placement current
        const movedBase = this.#base?.place(fixedFrame) ?? false
        const movedOverlay = this.#overlay?.place(fixedFrame) ?? false
        if (movedBase || movedOverlay) {
            this.requestDraw()
        }
    }
    /** the box around everything drawn, in the fixed frame, or null */
    #bounds(): MapBox | null {
        const boxes = [this.#base?.bounds(), this.#overlay?.bounds()].filter((box): box is MapBox => !!box)
        if (!boxes.length) {
            return null
        }
        return [
            Math.min(...boxes.map((b) => b[0])),
            Math.min(...boxes.map((b) => b[1])),
            Math.max(...boxes.map((b) => b[2])),
            Math.max(...boxes.map((b) => b[3])),
        ]
    }
    /** Shows all of the map (and stops following); with nothing to fit, centers on the robot. A no-op when it can't tell. */
    fit() {
        const box = this.canvas.getBoundingClientRect()
        const bounds = this.#bounds()
        const fitted = bounds && box.width >= 2 && box.height >= 2 ? fitView(bounds, box.width, box.height) : null
        if (fitted) {
            this.#pan()
            this.#setView(fitted)
        } else if (this.#robot) {
            this.#setView({ centerX: this.#robot.x, centerY: this.#robot.y, metersPerPixel: DEFAULT_METERS_PER_PIXEL })
        }
    }
    #setView(view: MapView) {
        // a NaN or out-of-range view would blank the map and be remembered: keep the last good one
        if (!isValidView(view)) {
            return
        }
        this.#view = view
        this.#fitted = true
        this.requestDraw()
        this.#saveView()
    }
    #saveTimer: ReturnType<typeof setTimeout> | number = 0
    #saveView() {
        clearTimeout(this.#saveTimer)
        this.#saveTimer = setTimeout(() => this.events.onView(this.#view), 400)
    }
    requestDraw() {
        if (!this.#frameRequest) {
            this.#frameRequest = requestAnimationFrame(() => {
                this.#frameRequest = 0
                this.#draw()
            })
        }
    }
    #listen() {
        const canvas = this.canvas
        const wheel = (event: WheelEvent) => {
            event.preventDefault()
            const box = canvas.getBoundingClientRect()
            const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1
            if (wheelGesture(event) === "pan") {
                // shift turns a vertical wheel sideways in most browsers, but not all
                const [dx, dy] = event.shiftKey && !event.deltaX ? [event.deltaY, 0] : [event.deltaX, event.deltaY]
                this.#pan()
                this.#setView(pan(this.#view, -dx * lines, -dy * lines))
                return
            }
            this.#zoom(Math.exp(-event.deltaY * lines * 0.0015), event.clientX - box.left, event.clientY - box.top)
        }
        const down = (event: PointerEvent) => {
            canvas.setPointerCapture(event.pointerId)
            this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
            this.#dragged = false
            if (this.#pointers.size === 2) {
                this.#follow.pinchStart()
            }
        }
        const move = (event: PointerEvent) => {
            const before = this.#pointers.get(event.pointerId)
            if (!before) {
                return
            }
            const box = canvas.getBoundingClientRect()
            const others = [...this.#pointers.entries()]
                .filter(([id]) => id !== event.pointerId)
                .map(([, point]) => point)
            if (others.length) {
                // pinch: zoom by the change in spread around the other finger, pan by the midpoint's move
                const other = others[0]
                const spreadBefore = Math.hypot(before.x - other.x, before.y - other.y),
                    spreadAfter = Math.hypot(event.clientX - other.x, event.clientY - other.y)
                const middleDx = (event.clientX - before.x) / 2,
                    middleDy = (event.clientY - before.y) / 2
                const wasFollowing = this.#follow.following
                // a pinch zooms about the followed frame (still following) until its middle drifts: then it pans too
                const pans = this.#follow.pinchPans(middleDx, middleDy)
                if (wasFollowing && !this.#follow.following) {
                    this.#reportFollow()
                }
                let view = pans ? pan(this.#view, middleDx, middleDy) : this.#view
                if (spreadBefore > 10) {
                    const [anchorX, anchorY] = this.#follow.zoomAnchor(
                        view,
                        box.width,
                        box.height,
                        (event.clientX + other.x) / 2 - box.left,
                        (event.clientY + other.y) / 2 - box.top,
                        this.#target,
                    )
                    view = zoomAt(view, box.width, box.height, anchorX, anchorY, spreadAfter / spreadBefore)
                }
                this.#setView(view)
            } else {
                const dx = event.clientX - before.x,
                    dy = event.clientY - before.y
                if (!this.#dragged && Math.hypot(dx, dy) < 3) {
                    return
                }
                this.#dragged = true
                this.#pan()
                this.#setView(pan(this.#view, dx, dy))
            }
            this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
        }
        const up = (event: PointerEvent) => {
            const tap = this.#pointers.size === 1 && !this.#dragged && event.type === "pointerup"
            this.#pointers.delete(event.pointerId)
            // a click that didn't move the map: where it landed, in the fixed frame (e.g. a goal)
            if (tap && this.events.onPick) {
                const box = canvas.getBoundingClientRect()
                const [x, y] = screenToWorld(
                    this.#view,
                    box.width,
                    box.height,
                    event.clientX - box.left,
                    event.clientY - box.top,
                )
                this.events.onPick({ x, y, frame: this.map.fixedFrame(), event })
            }
        }
        const doubleClick = () => this.recenter()
        canvas.addEventListener("wheel", wheel, { passive: false })
        canvas.addEventListener("pointerdown", down)
        canvas.addEventListener("pointermove", move)
        canvas.addEventListener("pointerup", up)
        canvas.addEventListener("pointercancel", up)
        canvas.addEventListener("dblclick", doubleClick)
        this.#dispose.push(() => {
            canvas.removeEventListener("wheel", wheel)
            canvas.removeEventListener("pointerdown", down)
            canvas.removeEventListener("pointermove", move)
            canvas.removeEventListener("pointerup", up)
            canvas.removeEventListener("pointercancel", up)
            canvas.removeEventListener("dblclick", doubleClick)
        })
    }
    /** the viewer moved the map: stop following */
    #pan() {
        if (this.#follow.pan()) {
            this.#reportFollow()
        }
    }
    /** zooms about a point; following, about the followed frame (so it stays centered) */
    #zoom(factor: number, sx: number, sy: number) {
        const box = this.canvas.getBoundingClientRect()
        const [anchorX, anchorY] = this.#follow.zoomAnchor(this.#view, box.width, box.height, sx, sy, this.#target)
        this.#setView(zoomAt(this.#view, box.width, box.height, anchorX, anchorY, factor))
    }
    #draw() {
        const canvas = this.canvas
        const box = canvas.getBoundingClientRect()
        const width = box.width,
            height = box.height
        if (width < 2 || height < 2) {
            return
        }
        const ratio = globalThis.devicePixelRatio || 1
        const pixelWidth = Math.round(width * ratio),
            pixelHeight = Math.round(height * ratio)
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth
            canvas.height = pixelHeight
        }
        // first data with nothing remembered: show all of it
        const bounds = this.#fitted ? null : this.#bounds()
        const fitted = bounds && fitView(bounds, width, height)
        if (fitted) {
            this.#view = this.#follow.following && this.#target ? this.#follow.view(fitted, this.#target) : fitted
            this.#fitted = true
        }
        const context = canvas.getContext("2d")!
        const palette = this.#palette
        const view = this.#view
        const scale = 1 / view.metersPerPixel
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.fillStyle = css(palette.background)
        context.fillRect(0, 0, pixelWidth, pixelHeight)
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        const toScreen = (x: number, y: number) => worldToScreen(view, width, height, x, y)
        // a faint meter grid at the scale bar's step
        const step = niceLength(80 * view.metersPerPixel)
        context.strokeStyle = css(palette.fg, 0.06)
        context.lineWidth = 1
        context.beginPath()
        const [left, top] = [
            view.centerX - (width / 2) * view.metersPerPixel,
            view.centerY + (height / 2) * view.metersPerPixel,
        ]
        for (let x = Math.ceil(left / step) * step; x < left + width * view.metersPerPixel; x += step) {
            const sx = Math.round(toScreen(x, 0)[0]) + 0.5
            context.moveTo(sx, 0)
            context.lineTo(sx, height)
        }
        for (let y = Math.floor(top / step) * step; y > top - height * view.metersPerPixel; y -= step) {
            const sy = Math.round(toScreen(0, y)[1]) + 0.5
            context.moveTo(0, sy)
            context.lineTo(width, sy)
        }
        context.stroke()
        // the map: world → screen (y flipped), then each image's own placement; row 0 lands at the lowest y
        context.imageSmoothingEnabled = false
        for (
            const [source, alpha] of [
                [this.#base, 1],
                [this.#overlay, 0.85],
            ] as const
        ) {
            if (source) {
                context.setTransform(
                    ratio * scale,
                    0,
                    0,
                    -ratio * scale,
                    ratio * (width / 2 - view.centerX * scale),
                    ratio * (height / 2 + view.centerY * scale),
                )
                context.globalAlpha = alpha
                source.draw(context)
            }
        }
        context.globalAlpha = 1
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        // the world's origin: x (red) and y (green), a scale-bar step long but at least 24 px
        const axis = Math.max(24, Math.min(60, step * scale))
        const [ox, oy] = toScreen(0, 0)
        if (ox > -axis && ox < width + axis && oy > -axis && oy < height + axis) {
            drawAxes(context, palette, ox, oy, axis, true)
        }
        // the trail, then the robot on top
        const trail = this.#trail.points
        if (trail.length >= 4) {
            context.strokeStyle = css(palette.primary, 0.85)
            context.lineWidth = 2
            context.lineJoin = "round"
            context.lineCap = "round"
            context.beginPath()
            let pen = false
            for (let index = 0; index < trail.length; index += 2) {
                if (Number.isNaN(trail[index])) {
                    pen = false
                    continue
                }
                const [sx, sy] = toScreen(trail[index], trail[index + 1])
                if (pen) {
                    context.lineTo(sx, sy)
                } else {
                    context.moveTo(sx, sy)
                }
                pen = true
            }
            context.stroke()
        }
        // the planned path, placed through TF into the fixed frame
        const path = this.#path
        const placed = path && path.points.length > 1
            ? path.frame && path.frame !== this.map.fixedFrame()
                ? this.map.tf.lookup(path.frame, this.map.fixedFrame())
                : null
            : null
        if (path && path.points.length > 1 && (placed || !path.frame || path.frame === this.map.fixedFrame())) {
            const e = placed?.elements
            context.strokeStyle = css(palette.path, 0.95)
            context.lineWidth = 2.5
            context.lineJoin = "round"
            context.beginPath()
            path.points.forEach(([px, py], index) => {
                const wx = e ? e[0] * px + e[4] * py + e[12] : px
                const wy = e ? e[1] * px + e[5] * py + e[13] : py
                const [sx, sy] = toScreen(wx, wy)
                if (index) {
                    context.lineTo(sx, sy)
                } else {
                    context.moveTo(sx, sy)
                }
            })
            context.stroke()
        }
        if (this.#robot) {
            const [sx, sy] = toScreen(this.#robot.x, this.#robot.y)
            context.save()
            context.translate(sx, sy)
            // screen y points down: a yaw counter-clockwise in the world is counter-clockwise on screen too
            context.rotate(-this.#robot.yaw)
            context.beginPath()
            context.moveTo(11, 0)
            context.lineTo(-7, 7)
            context.lineTo(-3, 0)
            context.lineTo(-7, -7)
            context.closePath()
            context.fillStyle = css(palette.robot)
            context.strokeStyle = css(palette.background)
            context.lineWidth = 2
            context.stroke()
            context.fill()
            context.restore()
        }
        // corner key (which way +x and +y point) and the scale bar
        drawAxes(context, palette, width - 40, height - 14, 22, false)
        const barMeters = niceLength(110 * view.metersPerPixel)
        const barPixels = barMeters * scale
        context.strokeStyle = css(palette.fg, 0.9)
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(12, height - 16)
        context.lineTo(12, height - 11)
        context.lineTo(12 + barPixels, height - 11)
        context.lineTo(12 + barPixels, height - 16)
        context.stroke()
        context.fillStyle = css(palette.fg, 0.9)
        context.font = "10px ui-monospace, monospace"
        context.textBaseline = "bottom"
        context.fillText(formatMeters(barMeters), 14, height - 15)
    }
}
/** x (right) and y (up) arrows from (x, y); labeled ones mark the world origin */
function drawAxes(
    context: CanvasRenderingContext2D,
    palette: MapPalette,
    x: number,
    y: number,
    length: number,
    origin: boolean,
) {
    const arrow = (dx: number, dy: number, color: string, name: string) => {
        context.strokeStyle = color
        context.fillStyle = color
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(x, y)
        context.lineTo(x + dx * length, y + dy * length)
        context.stroke()
        context.beginPath()
        context.moveTo(x + dx * (length + 5), y + dy * (length + 5))
        context.lineTo(x + dx * length - dy * 4, y + dy * length + dx * 4)
        context.lineTo(x + dx * length + dy * 4, y + dy * length - dx * 4)
        context.closePath()
        context.fill()
        context.font = "600 10px ui-sans-serif, sans-serif"
        context.textBaseline = "middle"
        context.fillText(name, x + dx * (length + 12) - (dx ? 0 : 3), y + dy * (length + 12))
    }
    arrow(1, 0, palette.axisX, origin ? "x" : "+x")
    arrow(0, -1, palette.axisY, origin ? "y" : "+y")
}
/** RGBA pixels on a canvas the map draws scaled (reused when the size matches). */
function toCanvas(
    pixels: RgbaPixels,
    width: number,
    height: number,
    reuse: HTMLCanvasElement | null,
): HTMLCanvasElement {
    const canvas = reuse && reuse.width === width && reuse.height === height ? reuse : document.createElement("canvas")
    if (canvas !== reuse) {
        canvas.width = width
        canvas.height = height
    }
    canvas.getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0)
    return canvas
}
