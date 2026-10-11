// The 2D map: a floating, collapsible (or a layout's docked), top-down panel (north-up: +x right, +y up) with the bus's global map (an
// accumulated point cloud, as a height heatmap) or any other cloud or occupancy grid, optionally a costmap laid over
// it, the planned path, the robot's pose, heading and trail, the world axes and a scale bar (dimos-react's Map2D). View-only: wheel / pinch zoom and drag pan
// move the picture, never the robot. It follows a TF frame (base_link unless picked) until the viewer pans; a zoom keeps
// following, re-center (or a double-click) resumes it. Like the 3D view's layers, it keeps each topic's last message for
// the page's life (a collapse, a reopen or a topic missing from discovery never blanks it). Redrawn only when something
// changed (new data, the robot moved, a zoom or pan, a resize, the theme).
import { useEffect, useRef, useState } from "react"
import { Button, clampPanelBox, Icon, IconButton, PanelInfo, Select, ViewPanel } from "dimos-react"
import { Map2D, useTfFrames } from "dimos-react/three"
import { chooseMapTopic, chooseOverlay, followFrameOptions, isGridTopic, mapCandidates, overlayCandidates } from "../logic/mapTopics.ts"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"
import { rememberTopics, type Topic } from "../logic/connection.ts"
import { writeLocal } from "../logic/local.ts"
import type { Dock } from "../App.tsx"
import { LAYOUT_KEY, loadMapLayout, type MapLayout, MIN_HEIGHT, MIN_WIDTH, viewport } from "../logic/mapLayout.ts"

/** every map topic this page has seen (the 3D view's layers outlive discovery the same way): a 0.5 Hz map that misses a
 * discovery round, or drops off for a while, stays the map instead of the panel falling back to /lidar */
const seenTopics = new WeakMap<ControllerApp, Map<string, { topic: Topic; at: number }>>()

export function MapPanel({ app, mobile, dock }: { app: ControllerApp; mobile: boolean; dock: Dock | null }) {
    const [layout, setLayout] = useState(() => loadMapLayout())
    const update = (patch: Partial<MapLayout>) =>
        setLayout((old) => {
            const next = { ...old, ...patch }
            writeLocal(LAYOUT_KEY, next)
            return next
        })
    const { topics: live } = useStore(app.connection.status)
    if (!seenTopics.has(app)) {
        seenTopics.set(app, new Map())
    }
    const topics = rememberTopics(seenTopics.get(app)!, live, Date.now(), Infinity)
    const topic = chooseMapTopic(topics, layout.topic)
    const overlay = chooseOverlay(topics, layout.overlay, topic)
    const candidates = mapCandidates(topics)
    const grids = overlayCandidates(topics).filter((grid) => grid.key !== topic?.key)
    const path = topics.find((other) => other.type === "nav_msgs.Path" && /(^|\/)path$/.test(other.name)) ?? null
    // deno-lint-ignore no-explicit-any
    const renderer = useRef<any>(null)
    const [status, setStatus] = useState({ info: "", problem: "" })
    const [follow, setFollow] = useState({ following: true, waiting: false })
    /** the last header press moved the panel (so its click isn't an "open") */
    const dragged = useRef(false)

    // a smaller window: the panel moves and shrinks back onto it
    const [, setViewport] = useState(viewport)
    useEffect(() => {
        const resized = () => setViewport(viewport())
        addEventListener("resize", resized)
        return () => removeEventListener("resize", resized)
    }, [])

    // the renderer lives while the panel is open; collapsed, nothing is subscribed or drawn (docked, it's always open)
    const open = !!dock || !layout.collapsed
    const full = !dock && layout.full
    // the TF frames to offer for following, refreshed while open
    const frames: string[] = useTfFrames({ tf: app.tf })

    // where it is, kept on this window as it is now (the remembered box can be from a bigger one)
    const box = clampPanelBox(layout, layout, viewport(), { width: MIN_WIDTH, height: MIN_HEIGHT })
    const placed = box.x >= 0 ? { left: box.x, top: box.y } : {}
    const floating = !dock && !full
    const style: React.CSSProperties = mobile || !floating ? {} : open ? { ...placed, width: box.width, height: box.height } : placed
    const name = (other: Topic) => `${other.name}${isGridTopic(other) ? "" : " (heatmap)"}`
    const label = topic ? name(topic) : "no map on the bus"
    // a header press that moved the panel isn't an "open"
    const openFromHead = () => !open && !dragged.current && update({ collapsed: false })
    return (
        <div className="map-layer">
            <ViewPanel
                placement={dock ? "dock" : full && open ? "main" : "float"}
                dock={dock}
                className={`map-panel ${open ? "open" : "collapsed"} ${box.x < 0 ? "default-spot" : ""}`}
                style={style}
                title={open ? status.info : "Show the 2D map (drag to move it)"}
                onHeadDoubleClick={() => open && !mobile && update({ full: !layout.full })}
                top={48}
                onMove={floating && !mobile
                    ? (x: number, y: number) => {
                        dragged.current = true
                        update({ x, y })
                    }
                    : undefined}
                resize={floating && open && !mobile ? { corner: "right", minimum: { width: MIN_WIDTH, height: MIN_HEIGHT }, onDone: (next: { x: number; y: number; width: number; height: number }) => update(next) } : null}
                bodyClassName="map-body"
                wrapHead
                head={
                    <>
                        {/* folded, a click on the title opens it (a drag moves it instead) */}
                        <span className="dr-view-panel-title map-title" onPointerDown={() => (dragged.current = false)} onClick={openFromHead}><Icon name="map" size={14} />Map</span>
                        {!open && <PanelInfo className="map-show" onPointerDown={() => (dragged.current = false)} onClick={openFromHead}>show</PanelInfo>}
                        {open && candidates.length > 1 && (
                            <Select size="sm" value={layout.topic} aria-label="Map topic" options={[["", `auto (${label})`], ...candidates.map((other) => [other.key, name(other)])]} onChange={(topic: string) => update({ topic })} />
                        )}
                        {open && candidates.length <= 1 && <PanelInfo className="map-source">{label}</PanelInfo>}
                        {open && grids.length > 0 && (
                            <Select size="sm" className="map-overlay" value={overlay?.key ?? ""} aria-label="Costmap overlay" title="A costmap drawn over the map" options={[["", "no costmap"], ...grids.map((grid) => [grid.key, `+ ${grid.name}`])]} onChange={(next: string) => update({ overlay: next })} />
                        )}
                        {open && <PanelInfo>{status.info}</PanelInfo>}
                        {open && (
                            <Select size="sm" className="map-frame" value={layout.followFrame} aria-label="Frame to follow" title="The TF frame the map follows" options={followFrameOptions(frames, layout.followFrame).map(({ frame, waiting }) => [frame, `follow ${frame}${waiting ? " (waiting)" : ""}`])} onChange={(followFrame: string) => update({ followFrame })} />
                        )}
                        {open && (
                            <>
                                <IconButton size="sm" icon="target" className="map-follow" pressed={follow.following} label={follow.following ? `Following ${layout.followFrame} (pan the map to look around)` : `Re-center on ${layout.followFrame} and follow it (or double-click the map)`} onClick={() => renderer.current?.recenter()} />
                                <IconButton size="sm" icon="fit" label="Fit the whole map" onClick={() => renderer.current?.fit()} />
                                {!mobile && !dock && <IconButton size="sm" icon={layout.full ? "fullscreen-exit" : "fullscreen"} label={layout.full ? "Back to a floating panel" : "Fullscreen map"} onClick={() => update({ full: !layout.full })} />}
                            </>
                        )}
                        {!dock && (
                            <IconButton size="sm" icon={open ? "chevron-up" : "chevron-down"} aria-expanded={open} label={open ? "Collapse the map" : "Show the 2D map"} onClick={() => update({ collapsed: open, full: open ? false : layout.full })} />
                        )}
                    </>
                }
            >
                {open && (
                    <>
                        <Map2D
                            tf={app.tf}
                            topic={topic}
                            overlay={overlay}
                            path={path?.key ?? null}
                            followFrame={layout.followFrame}
                            robotFrame={app.profile.baseFrame}
                            fixedFrame={app.fixedFrame}
                            view={layout.view}
                            onView={(view: MapLayout["view"]) => update({ view })}
                            onFollow={(next: { following: boolean; waiting: boolean }) => setFollow((old) => old.following === next.following && old.waiting === next.waiting ? old : next)}
                            onStatus={(next: { info: string; problem: string }) => setStatus((old) => old.info === next.info && old.problem === next.problem ? old : next)}
                            onMap={(map: unknown) => (renderer.current = map)}
                        />
                        {status.problem && <PanelInfo className="map-problem">{status.problem}</PanelInfo>}
                        {!status.problem && follow.following && follow.waiting && <PanelInfo className="map-problem">waiting for TF frame "{layout.followFrame}"</PanelInfo>}
                        {!follow.following && (
                            <Button size="sm" icon="target" className="map-recenter" title="Follow it again (or double-click the map)" onClick={() => renderer.current?.recenter()}>Re-center on {layout.followFrame}</Button>
                        )}
                    </>
                )}
            </ViewPanel>
        </div>
    )
}
