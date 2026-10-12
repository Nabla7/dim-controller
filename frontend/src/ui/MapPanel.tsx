// The 2D map: a workspace panel (ui/Panel.tsx), top-down (north-up: +x right, +y up) with the bus's global map (an
// accumulated point cloud, as a height heatmap) or any other cloud or occupancy grid, optionally a costmap laid over
// it, the robot's pose, heading and trail and a scale bar (before any data: "no lidar data on <topic> yet"). View-only: wheel / pinch zoom and drag pan
// move the picture, never the robot. It follows a TF frame (base_link unless picked) until the viewer pans; a zoom keeps
// following, re-center (or a double-click) resumes it. Like the 3D view's layers, it keeps each topic's last message for
// the page's life (a collapse, a reopen or a topic missing from discovery never blanks it). Redrawn only when something
// changed (new data, the robot moved, a zoom or pan, a resize, the theme).
import { type ReactNode, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { decode, headerFrameId, type LcmValue } from "../core/lcm/lcm.ts"
import { poseMatrix } from "../core/layers/helpers.ts"
import { rememberTopics } from "../core/transport.ts"
import {
    chooseMapTopic,
    chooseOverlay,
    type MapBase,
    followFrameOptions,
    MapFollow,
    fitView,
    floorPose,
    formatMeters,
    gridLut,
    gridPixels,
    heatLut,
    isGridTopic,
    isValidView,
    mapCandidates,
    type MapView,
    niceLength,
    overlayCandidates,
    pan,
    projectCloud,
    type ProjectedCloud,
    type Rgba,
    Trail,
    wheelGesture,
    worldToScreen,
    zoomAt,
} from "../core/map2d.ts"
import { Icon } from "./icons.tsx"
import { mapLayout, updateMapLayout } from "./mapLayout.ts"
import { Panel } from "./Panel.tsx"
import { useWorkspaceApi } from "./Workspace.tsx"
import { panelTitle } from "./commands.ts"
import { useDockActions } from "./dockActions.ts"
import { popoverPosition } from "./panelDrag.ts"
import { useTfFrames } from "./useTfFrames.ts"

/** every map topic this page has seen (the 3D view's layers outlive discovery the same way): a 0.5 Hz map that misses a
 * discovery round, or drops off for a while, stays the map instead of the panel falling back to /lidar */
const seenTopics = new WeakMap<ViewerApp, Map<string, { topic: Topic; at: number }>>()

/** each topic's last message (decoded), kept for the page's life so a reopened panel or a re-picked topic shows it at once */
interface Retained {
    grid?: GridData
    gridInfo?: string
    cloudFrame?: string
    cloudPositions?: Float32Array
    cloudMatrix?: number[]
    cloudInfo?: string
}
const retained = new WeakMap<ViewerApp, Map<string, Retained>>()
function retainedFor(app: ViewerApp, key: string): Retained {
    let topics = retained.get(app)
    if (!topics) {
        retained.set(app, topics = new Map())
    }
    let entry = topics.get(key)
    if (!entry) {
        topics.set(key, entry = {})
    }
    return entry
}

/** The map's topics as the panel sees them: the base, the costmap over it, and what each could be. */
function useMapTopics(app: ViewerApp) {
    const layout = useStore(mapLayout)
    const { topics: live } = useStore(app.connection.status)
    if (!seenTopics.has(app)) {
        seenTopics.set(app, new Map())
    }
    const topics = rememberTopics(seenTopics.get(app)!, live, Date.now(), Infinity)
    const topic = chooseMapTopic(topics, layout.topic, layout.source)
    return {
        layout,
        topic,
        overlay: chooseOverlay(topics, layout.overlay, layout.source),
        candidates: mapCandidates(topics, layout.source),
        grids: overlayCandidates(topics),
    }
}

const topicName = (other: Topic) => `${other.name}${isGridTopic(other) ? "" : " (heatmap)"}`

/**
 * The map's choices: what it draws (the lidar map or a costmap; the costmap choice only when one is on the bus), which
 * topic, a costmap over a lidar map, and the TF frame it follows. The same fields (the same setting) in
 * the map's cog menu and in Settings → Map; `frames` are the TF frames to offer.
 */
export function MapChoiceFields({ app, frames }: { app: ViewerApp; frames: string[] }) {
    const { layout, topic, overlay, candidates, grids } = useMapTopics(app)
    const label = topic ? topicName(topic) : layout.source === "costmap" ? "no costmap on the bus" : "no lidar map on the bus"
    return (
        <>
            <div className="map-setting">
                <span>Show</span>
                <span className="dim-tabs segmented map-base" role="radiogroup" aria-label="Map source">
                    {([["lidar", "Lidar map"], ["costmap", "Costmap"]] as const).map(([source, name]) => {
                        const unavailable = source === "costmap" && !grids.length
                        return (
                            <button
                                key={source}
                                type="button"
                                role="radio"
                                aria-checked={layout.source === source}
                                className={`dim-tab ${layout.source === source ? "on" : ""}`}
                                disabled={unavailable && layout.source !== source}
                                title={unavailable ? "No costmap (nav_msgs.OccupancyGrid) on the bus" : source === "costmap" ? "The costmap as the map" : "The lidar map (a point cloud from above)"}
                                onClick={() => updateMapLayout({ source, topic: "" })}
                            >
                                {name}{unavailable ? " (none)" : ""}
                            </button>
                        )
                    })}
                </span>
            </div>
            <label className="map-setting">
                <span>Topic</span>
                {candidates.length > 1
                    ? (
                        <select className="dim-select map-topic" value={layout.topic} onChange={(event) => updateMapLayout({ topic: event.target.value })} aria-label="Map topic">
                            <option value="">auto ({label})</option>
                            {candidates.map((other) => <option key={other.key} value={other.key}>{topicName(other)}</option>)}
                        </select>
                    )
                    : <span className="map-source">{label}</span>}
            </label>
            {layout.source === "lidar" && grids.length > 0 && (
                <label className="map-setting">
                    <span>Overlay</span>
                    <select className="dim-select map-overlay" value={overlay?.key ?? ""} onChange={(event) => updateMapLayout({ overlay: event.target.value })} aria-label="Costmap overlay" title="A costmap drawn over the lidar map">
                        <option value="">no costmap</option>
                        {grids.map((grid) => <option key={grid.key} value={grid.key}>{grid.name}</option>)}
                    </select>
                </label>
            )}
            <label className="map-setting">
                <span>Follow</span>
                <select className="dim-select map-frame" value={layout.followFrame} onChange={(event) => updateMapLayout({ followFrame: event.target.value })} aria-label="Frame the map follows" title="The TF frame the map follows">
                    {followFrameOptions(frames, layout.followFrame).map(({ frame, waiting }) => <option key={frame} value={frame}>{frame}{waiting ? " (waiting)" : ""}</option>)}
                </select>
            </label>
        </>
    )
}

export function MapPanel({ app }: { app: ViewerApp }) {
    const { layout, topic, overlay } = useMapTopics(app)
    const update = updateMapLayout
    const canvas = useRef<HTMLCanvasElement>(null)
    const renderer = useRef<MapRenderer | null>(null)
    const [status, setStatus] = useState<MapStatus>({ info: "", problem: "", empty: true })
    const [follow, setFollow] = useState({ following: true, waiting: false })

    // the renderer lives while the panel is on screen; collapsed or off screen (a shut drawer, a rail hidden by focus), nothing is subscribed or drawn
    const slot = useWorkspaceApi().layout.slots.map
    const open = !!slot && !slot.hidden && !slot.collapsed
    useEffect(() => {
        if (!open || !canvas.current) {
            return
        }
        const created = new MapRenderer(app, canvas.current, layout.view, layout.followFrame, {
            onView: (view) => update({ view }),
            onFollow: (next) => setFollow((old) => old.following === next.following && old.waiting === next.waiting ? old : next),
            onStatus: (next) => setStatus((old) => old.info === next.info && old.problem === next.problem && old.empty === next.empty ? old : next),
        })
        renderer.current = created
        return () => {
            created.dispose()
            renderer.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [app, open])

    useEffect(() => {
        renderer.current?.setFollowFrame(layout.followFrame)
    }, [layout.followFrame, open])

    // the TF frames to offer for following, refreshed while open
    const frames = useTfFrames(app, open)

    useEffect(() => {
        renderer.current?.setTopics(topic, overlay, layout.source)
    }, [topic?.key, overlay?.key, layout.source, open])

    const recenter = () => renderer.current?.recenter()
    const fit = () => renderer.current?.fit()
    const followTitle = follow.following ? `Following ${layout.followFrame} (pan the map to look around)` : `Re-center on ${layout.followFrame} and follow it (or double-click the map)`
    useDockActions("map", [
        { id: "follow", label: follow.following ? "Following" : "Follow", icon: "target", title: followTitle, pressed: follow.following, run: recenter },
        { id: "fit", label: "Fit map", icon: "fit", title: "Fit the whole map", run: fit },
    ])
    const [settingsOpen, setSettingsOpen] = useState(false)
    const cog = useRef<HTMLButtonElement>(null)
    useEffect(() => {
        if (!open) {
            setSettingsOpen(false)
        }
    }, [open])
    return (
        <Panel
            id="map"
            title={panelTitle("map")}
            icon="map"
            className="map-panel"
            testid="map-panel"
            info={status.info}
            bodyClassName="map-body"
        >
            {open && (
                <>
                    <canvas ref={canvas} className="map-canvas" aria-label="Top-down map" />
                    {status.problem && <div className={status.empty ? "map-empty" : "map-problem"} data-testid={status.empty ? "map-empty" : undefined}>{status.problem}</div>}
                    {!status.problem && follow.following && follow.waiting && <div className="map-problem">waiting for TF frame "{layout.followFrame}"</div>}
                    <div className="map-controls panel-chrome">
                        <button ref={cog} type="button" className={`dim-btn icon map-control map-settings ${settingsOpen ? "on" : ""}`} aria-haspopup="menu" aria-expanded={settingsOpen} title="Map settings: topic, costmap, frame to follow, fit" aria-label="Map settings" onClick={() => setSettingsOpen(!settingsOpen)}>
                            <Icon name="settings" size={15} />
                        </button>
                        <button type="button" className="dim-btn icon map-control map-follow" aria-pressed={follow.following} title={followTitle} aria-label={follow.following ? "Following" : "Follow"} onClick={recenter}>
                            <Icon name="target" size={15} />
                        </button>
                    </div>
                    {!follow.following && (
                        <button type="button" className="dim-btn map-recenter" title="Follow it again (or double-click the map)" onClick={recenter}>
                            <Icon name="target" size={13} />Re-center on {layout.followFrame}
                        </button>
                    )}
                    {settingsOpen && (
                        <MapSettings anchor={cog.current} onClose={() => setSettingsOpen(false)}>
                            <MapChoiceFields app={app} frames={frames} />
                            <button type="button" className="dim-btn sm map-fit" title="Fit the whole map" onClick={fit}>
                                <Icon name="fit" size={14} />Fit the whole map
                            </button>
                        </MapSettings>
                    )}
                </>
            )}
        </Panel>
    )
}

/** The map's settings (behind its cog): a popover that closes on a click outside it. */
function MapSettings({ anchor, onClose, children }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode }) {
    useEffect(() => {
        const close = (event: Event) => {
            if (!(event.target as HTMLElement).closest?.(".map-settings-menu, .map-settings")) {
                onClose()
            }
        }
        addEventListener("pointerdown", close, true)
        return () => removeEventListener("pointerdown", close, true)
    }, [onClose])
    return createPortal(
        <div className="dim-panel map-settings-menu" role="menu" aria-label="Map settings" style={popoverPosition(anchor, 280)}>
            <div className="quality-title">Map</div>
            {children}
        </div>,
        document.body,
    )
}

/** what the map says about itself: a live note for the header, what's wrong, and whether it has nothing to draw yet */
interface MapStatus {
    info: string
    problem: string
    empty: boolean
}

/** before the first message: what the map is listening to */
const emptyText = (topic: Topic) => isGridTopic(topic) ? `no costmap data on ${topic.name} yet` : `no lidar data on ${topic.name} yet`

interface Palette {
    background: Rgba
    fg: Rgba
    muted: Rgba
    primary: Rgba
    robot: Rgba
    /** a grid as the base map: free floor, costs, walls */
    gridLut: Uint8ClampedArray
    /** a grid over the base: free floor clear, so the map under it shows */
    overlayLut: Uint8ClampedArray
    heatLut: Uint8ClampedArray
}

const css = ([r, g, b, a]: Rgba, alpha = 1) => `rgba(${r}, ${g}, ${b}, ${(a / 255) * alpha})`
const blend = (a: Rgba, b: Rgba, t: number): Rgba => [0, 1, 2, 3].map((index) => Math.round(a[index] + (b[index] - a[index]) * t)) as Rgba

/** A theme token (any CSS color, color-mix included) as rgba bytes, read back off a 1×1 canvas. */
function token(name: string, fallback: string): Rgba {
    const probe = document.createElement("span")
    probe.style.color = `var(${name})`
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    const pixel = document.createElement("canvas")
    pixel.width = pixel.height = 1
    const context = pixel.getContext("2d", { willReadFrequently: true })!
    context.fillStyle = fallback
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return [r, g, b, a]
}

function themePalette(): Palette {
    const background = token("--scene-bg, var(--bg)", "#05070d")
    const fg = token("--fg", "#ece8f0"), muted = token("--muted-fg", "#8e8898"), primary = token("--primary", "#7cc8ec")
    const opaque = (color: Rgba): Rgba => [color[0], color[1], color[2], 255]
    const base = opaque(background)
    const clear: Rgba = [0, 0, 0, 0]
    return {
        background: base,
        fg,
        muted,
        primary,
        robot: token("--warn", "#e8bf6a"),
        // free floor a shade off the background, costs toward the accent, walls in the text color, unknown clear
        gridLut: gridLut({ free: blend(base, opaque(fg), 0.1), low: blend(base, opaque(primary), 0.3), high: blend(base, opaque(primary), 0.8), lethal: opaque(fg), unknown: clear }),
        overlayLut: gridLut({ free: clear, low: [...primary.slice(0, 3), 70] as Rgba, high: [...primary.slice(0, 3), 190] as Rgba, lethal: [...primary.slice(0, 3), 235] as Rgba, unknown: clear }),
        heatLut: heatLut(),
    }
}

interface GridData {
    width: number
    height: number
    resolution: number
    // deno-lint-ignore no-explicit-any
    origin: any
    data: Int8Array
    frame: string
}

/** How far the robot moves (m) or turns (rad) before the map is redrawn for it. */
const POSE_EPSILON = 0.005
const YAW_EPSILON = 0.005
/** the default zoom before there's anything to fit */
const DEFAULT_METERS_PER_PIXEL = 0.05

/** One topic the map draws (the base, or the costmap over it): its subscription, its latest data as an image. */
class MapSource {
    grid: GridData | null = null
    gridImage: HTMLCanvasElement | null = null
    #gridPixels: Uint8ClampedArray | undefined
    /** the grid's (0,0) corner in the fixed frame, as last drawn */
    gridPose: { x: number; y: number; yaw: number } | null = null
    cloud: ProjectedCloud | null = null
    cloudImage: HTMLCanvasElement | null = null
    #cloudFrame: string | null = null
    /** the last cloud, kept to recolor it on a theme change */
    #cloudPositions: Float32Array | null = null
    #cloudMatrix: number[] | null = null
    info = ""
    problem = ""
    /** nothing from the topic yet (this page's life: a message from before counts) */
    empty = true
    #stop: (() => void)[] = []

    constructor(readonly app: ViewerApp, readonly topic: Topic, readonly lut: () => Uint8ClampedArray, readonly changed: () => void) {
        const connection = app.connection
        const kept = retainedFor(app, topic.key)
        this.problem = emptyText(topic)
        // the last message from before (a collapse, another pick, a discovery gap): drawn now, replaced by the next one
        if (kept.grid) {
            this.grid = kept.grid
            this.info = kept.gridInfo ?? ""
            this.problem = ""
            this.empty = false
        }
        if (kept.cloudFrame !== undefined) {
            this.#cloudFrame = kept.cloudFrame
        }
        if (kept.cloudPositions && kept.cloudMatrix) {
            this.#cloudPositions = kept.cloudPositions
            this.#cloudMatrix = kept.cloudMatrix
            this.info = kept.cloudInfo ?? ""
            this.problem = ""
            this.empty = false
        }
        this.rebuild()
        if (isGridTopic(topic)) {
            this.#stop.push(connection.subscribe(topic.key, { delivery: "latest", maxHz: 2 }, (message) => {
                this.empty = false
                let grid: LcmValue
                try {
                    grid = decode(topic.type, message.bytes)
                } catch (error) {
                    this.#status(this.info, `cannot decode ${topic.name}: ${error}`)
                    return
                }
                const { width, height, resolution, origin } = grid.info ?? {}
                if (!width || !height || !(resolution > 0) || !grid.data || grid.data.length < width * height) {
                    this.#status(this.info, `${topic.name}: empty or truncated grid`)
                    return
                }
                this.grid = kept.grid = { width, height, resolution, origin, data: grid.data, frame: grid.header?.frame_id ?? "" }
                this.gridPose = null
                this.rebuild()
                kept.gridInfo = `${width}×${height} @ ${resolution.toFixed(2)} m`
                this.#status(kept.gridInfo, "")
            }))
            return
        }
        // a cloud: its frame from one raw message (the compact encoding drops the header), then 1 Hz compact clouds
        let frameStop: (() => void) | null = connection.subscribe(topic.key, { delivery: "latest", maxHz: 1 }, (message) => {
            this.#cloudFrame = kept.cloudFrame = headerFrameId(topic.type, message.bytes) ?? ""
            frameStop?.()
            frameStop = null
        })
        this.#stop.push(() => frameStop?.())
        this.#stop.push(connection.subscribe(topic.key, { delivery: "latest", maxHz: 1, encoding: "dimos_lcm_pointcloud2" }, (message) => {
            const positions = (message.decoded as { positions?: Float32Array } | undefined)?.positions
            if (!positions || this.#cloudFrame === null) {
                return
            }
            this.empty = false
            const placed = app.tf.lookup(this.#cloudFrame, app.viewer.fixedFrame)
            if (!placed) {
                this.#status(this.info, `no TF from "${this.#cloudFrame}" to "${app.viewer.fixedFrame}"`)
                return
            }
            this.#cloudPositions = kept.cloudPositions = positions
            this.#cloudMatrix = kept.cloudMatrix = placed.elements.slice()
            this.rebuild()
            kept.cloudInfo = `${Math.round(positions.length / 3).toLocaleString()} pts`
            this.#status(kept.cloudInfo, "")
        }))
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
            this.#gridPixels = gridPixels(this.grid.data, this.grid.width, this.grid.height, this.lut(), this.#gridPixels)
            this.gridImage = toCanvas(this.#gridPixels, this.grid.width, this.grid.height, this.gridImage)
        }
        if (this.#cloudPositions && this.#cloudMatrix) {
            this.cloud = projectCloud(this.#cloudPositions, this.#cloudMatrix, this.lut())
            this.cloudImage = this.cloud ? toCanvas(this.cloud.pixels, this.cloud.width, this.cloud.height, this.cloudImage) : null
        }
    }

    /** every 3D frame: the grid's TF placement; true when it moved */
    place(fixedFrame: string): boolean {
        if (!this.grid) {
            return false
        }
        const placed = this.app.tf.lookup(this.grid.frame, fixedFrame)
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
        if (!before || Math.abs(before.x - pose.x) > 1e-4 || Math.abs(before.y - pose.y) > 1e-4 || Math.abs(before.yaw - pose.yaw) > 1e-5) {
            this.gridPose = pose
            if (this.problem.startsWith("no TF")) {
                this.#status(this.info, "")
            }
            return true
        }
        return false
    }

    /** the drawn data's box in the fixed frame, or null */
    bounds(): [number, number, number, number] | null {
        if (this.grid && this.gridPose) {
            const { width, height, resolution } = this.grid, { x, y, yaw } = this.gridPose
            const cos = Math.cos(yaw), sin = Math.sin(yaw)
            const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([u, v]) => [x + (u * cos - v * sin) * resolution, y + (u * sin + v * cos) * resolution])
            return [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))]
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
class MapRenderer {
    #view: MapView
    #fitted: boolean
    #follow: MapFollow
    /** where the followed frame is on the floor, or null while it isn't in the TF tree */
    #target: { x: number; y: number } | null = null
    #palette = themePalette()
    #base: MapSource | null = null
    #overlay: MapSource | null = null
    /** what the base is (for what to say when there is none) */
    #source: MapBase = "lidar"
    #robot: { x: number; y: number; yaw: number } | null = null
    #trail = new Trail()
    #fixedFrame = ""
    #frameRequest = 0
    #pointers = new Map<number, { x: number; y: number }>()
    #dragged = false
    #dispose: (() => void)[] = []

    constructor(readonly app: ViewerApp, readonly canvas: HTMLCanvasElement, view: MapView | null, followFrame: string, readonly events: {
        onView(view: MapView): void
        onFollow(follow: { following: boolean; waiting: boolean }): void
        onStatus(status: MapStatus): void
    }) {
        this.#view = isValidView(view) ? view : { centerX: 0, centerY: 0, metersPerPixel: DEFAULT_METERS_PER_PIXEL }
        this.#fitted = isValidView(view)
        this.#follow = new MapFollow(followFrame)
        this.#dispose.push(app.viewer.onFrame(() => this.#eachFrame()))
        const theme = () => {
            this.#palette = themePalette()
            this.#base?.rebuild()
            this.#overlay?.rebuild()
            this.requestDraw()
        }
        addEventListener("dim-theme", theme)
        this.#dispose.push(() => removeEventListener("dim-theme", theme))
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

    dispose() {
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

    #lookupTarget(): { x: number; y: number } | null {
        const placed = this.app.tf.lookup(this.#follow.frame, this.app.viewer.fixedFrame)
        return placed && this.app.tf.has(this.#follow.frame) ? floorPose(placed.elements) : null
    }

    /** the base map and the costmap over it (null: none); a source that didn't change keeps its data */
    setTopics(base: Topic | null, overlay: Topic | null, source: MapBase) {
        this.#source = source
        const changed = () => {
            this.#report()
            this.requestDraw()
        }
        if (base?.key !== this.#base?.topic.key) {
            this.#base?.dispose()
            this.#base = base ? new MapSource(this.app, base, () => isGridTopic(base) ? this.#palette.gridLut : this.#palette.heatLut, changed) : null
        }
        if (overlay?.key !== this.#overlay?.topic.key) {
            this.#overlay?.dispose()
            this.#overlay = overlay ? new MapSource(this.app, overlay, () => this.#palette.overlayLut, changed) : null
        }
        changed()
    }

    #report() {
        const base = this.#base, overlay = this.#overlay
        const info = [base?.info, overlay?.info && `+ ${overlay.topic.name} ${overlay.info}`].filter(Boolean).join(" · ")
        const none = this.#source === "costmap" ? "no costmap data yet: no costmap (occupancy grid) on the bus" : "no lidar data yet: no point cloud on the bus"
        const problem = !base ? none : base.problem || overlay?.problem || ""
        this.events.onStatus({ info, problem, empty: !base || base.empty })
    }

    /** every 3D frame: the robot's pose, the grids' TF placement, the fixed frame; a redraw only when one changed */
    #eachFrame() {
        const fixedFrame = this.app.viewer.fixedFrame
        if (fixedFrame !== this.#fixedFrame) {
            this.#fixedFrame = fixedFrame
            this.#trail.clear()
            this.requestDraw()
        }
        const matrix = this.app.robotMatrix
        const robot = matrix ? floorPose(matrix.elements) : null
        const old = this.#robot
        if (!robot !== !old || (robot && old && (Math.abs(robot.x - old.x) > POSE_EPSILON || Math.abs(robot.y - old.y) > POSE_EPSILON || Math.abs(robot.yaw - old.yaw) > YAW_EPSILON))) {
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
        if (!target !== !before || (target && before && Math.hypot(target.x - before.x, target.y - before.y) > POSE_EPSILON)) {
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
    #bounds(): [number, number, number, number] | null {
        const boxes = [this.#base?.bounds(), this.#overlay?.bounds()].filter((box): box is [number, number, number, number] => !!box)
        if (!boxes.length) {
            return null
        }
        return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))]
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

    #saveTimer = 0
    #saveView() {
        clearTimeout(this.#saveTimer)
        this.#saveTimer = setTimeout(() => this.events.onView(this.#view), 400) as unknown as number
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
            const others = [...this.#pointers.entries()].filter(([id]) => id !== event.pointerId).map(([, point]) => point)
            if (others.length) {
                // pinch: zoom by the change in spread around the other finger, pan by the midpoint's move
                const other = others[0]
                const spreadBefore = Math.hypot(before.x - other.x, before.y - other.y), spreadAfter = Math.hypot(event.clientX - other.x, event.clientY - other.y)
                const middleDx = (event.clientX - before.x) / 2, middleDy = (event.clientY - before.y) / 2
                const wasFollowing = this.#follow.following
                // a pinch zooms about the followed frame (still following) until its middle drifts: then it pans too
                const pans = this.#follow.pinchPans(middleDx, middleDy)
                if (wasFollowing && !this.#follow.following) {
                    this.#reportFollow()
                }
                let view = pans ? pan(this.#view, middleDx, middleDy) : this.#view
                if (spreadBefore > 10) {
                    const [anchorX, anchorY] = this.#follow.zoomAnchor(view, box.width, box.height, (event.clientX + other.x) / 2 - box.left, (event.clientY + other.y) / 2 - box.top, this.#target)
                    view = zoomAt(view, box.width, box.height, anchorX, anchorY, spreadAfter / spreadBefore)
                }
                this.#setView(view)
            } else {
                const dx = event.clientX - before.x, dy = event.clientY - before.y
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
            this.#pointers.delete(event.pointerId)
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
        const width = box.width, height = box.height
        if (width < 2 || height < 2) {
            return
        }
        const ratio = globalThis.devicePixelRatio || 1
        const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio)
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
        const [left, top] = [view.centerX - (width / 2) * view.metersPerPixel, view.centerY + (height / 2) * view.metersPerPixel]
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
        for (const [source, alpha] of [[this.#base, 1], [this.#overlay, 0.85]] as const) {
            if (source) {
                context.setTransform(ratio * scale, 0, 0, -ratio * scale, ratio * (width / 2 - view.centerX * scale), ratio * (height / 2 + view.centerY * scale))
                context.globalAlpha = alpha
                source.draw(context)
            }
        }
        context.globalAlpha = 1
        context.setTransform(ratio, 0, 0, ratio, 0, 0)

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

        // the scale bar
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

/** RGBA pixels on a canvas the map draws scaled (reused when the size matches). */
function toCanvas(pixels: Uint8ClampedArray, width: number, height: number, reuse: HTMLCanvasElement | null): HTMLCanvasElement {
    const canvas = reuse && reuse.width === width && reuse.height === height ? reuse : document.createElement("canvas")
    if (canvas !== reuse) {
        canvas.width = width
        canvas.height = height
    }
    canvas.getContext("2d")!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
    return canvas
}
