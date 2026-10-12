// Camera panels (ui/workspace.ts ids camera:<n>): one from the start (the profile's preferred camera once one is on
// the bus; until then it says there's none), more from the palette. Each is a workspace panel like any other (the
// main view by default). Its tools: a tab per image topic, a 2D detection overlay, the depth colormap and range; a gear
// over the picture picks latency vs quality. Depth is drawn as a colormap. Collapsed (or off screen: a shut drawer, a
// rail hidden by focus, a hidden browser tab) it holds no stream and no overlay subscription. As the main view it offers the dock fit / fill, the next camera and quality.
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ViewerApp } from "../core/app.ts"
import { persistentStore, useStore } from "../core/store.ts"
import { parseKey, type Topic } from "../core/transport.ts"
import { isDepthTopic, pageVisibility, panelStreams } from "../core/video.ts"
import { cameraTabs, isImage, pickDefault as pickPreferred, retargetPanels } from "../core/cameraChoice.ts"
import { overlayTypeFor } from "../core/layers/registry.ts"
import { decode } from "../core/lcm/lcm.ts"
import { DEFAULT_DEPTH_LOOK, DEPTH_COLORMAPS, DepthCanvas, type DepthLook } from "../core/render/depth.ts"
import { Button, Card, NumberInput, Select } from "dimos-react"
import { Icon } from "./icons.tsx"
import { popoverPosition } from "./panelDrag.ts"
import { Panel } from "./Panel.tsx"
import { useWorkspaceApi } from "./Workspace.tsx"
import { useDockActions } from "./dockActions.ts"
import { ContainCrash, Unavailable } from "./Unavailable.tsx"
import { presetFor, QUALITY_PRESETS, readLocal, type VideoQuality, writeLocal } from "../core/videoQuality.ts"
import { panelTitle } from "./commands.ts"
import { cameraId, isCamera, workspace } from "./workspace.ts"
import type { CameraActions } from "./useCommands.ts"

export interface PanelState {
    id: number
    /** image topic key ("" until one is picked) */
    key: string
    /** the topic key the viewer picked from the list (core/cameraChoice.ts shows it again whenever it's on the bus) */
    picked?: string
    /** overlay topic key ("" = none) */
    overlay: string
    /** depth topics: colormap and fixed range (null = auto) */
    depth?: DepthLook
}

export interface CameraLayout {
    panels: PanelState[]
}

/** the camera panels (a backend setting, so the agent can see which camera is shown) */
export const cameraLayout = persistentStore<CameraLayout>("lv.cameras", { panels: [{ id: 1, key: "", overlay: "" }] })

/** a lidar / point cloud: what makes the 3D view worth the screen */
export const isCloudTopic = (topic: Topic) => topic.type === "sensor_msgs.PointCloud2" || /lidar/i.test(topic.name)

/** The camera panels as saved, made safe: at least camera 1, unique ids. */
export function cameraPanels(layout: Partial<CameraLayout> | null | undefined): PanelState[] {
    const seen = new Set<number>()
    const panels = (Array.isArray(layout?.panels) ? layout.panels : []).filter((panel) => panel && Number.isInteger(panel.id) && panel.id > 0 && !seen.has(panel.id) && seen.add(panel.id))
        .map((panel) => ({ id: panel.id, key: typeof panel.key === "string" ? panel.key : "", picked: panel.picked, overlay: typeof panel.overlay === "string" ? panel.overlay : "", depth: panel.depth }))
    return seen.has(1) ? panels : [{ id: 1, key: "", overlay: "" }, ...panels]
}

const updatePanel = (id: number, patch: Partial<PanelState>) => cameraLayout.update({ panels: cameraPanels(cameraLayout.get()).map((panel) => panel.id === id ? { ...panel, ...patch } : panel) })

/** Adding a camera panel, pointing the main one at a topic, and removing an added one (camera 1 always stays). */
export function useCameraActions(app: ViewerApp | null): CameraActions {
    return {
        addCamera: () => {
            const panels = cameraPanels(cameraLayout.get())
            const topics = app?.connection.status.get().topics ?? []
            const used = new Set(panels.map((panel) => panel.key))
            const next = topics.filter(isImage).find((topic) => !used.has(topic.key)) ?? (app ? pickPreferred(app.profile.cameras.preferred, topics) : null)
            const id = Math.max(0, ...panels.map((panel) => panel.id)) + 1
            cameraLayout.update({ panels: [...panels, { id, key: next?.key ?? "", overlay: "" }] })
        },
        showTopic: (key: string) => {
            const stage = workspace.get().arrangement.stage
            const id = stage && isCamera(stage) ? Number(stage.split(":")[1]) : 1
            updatePanel(id, { key, picked: key })
        },
        removeCamera: (panelId: string) => {
            if (!isCamera(panelId) || panelId === cameraId(1)) {
                return
            }
            const id = Number(panelId.split(":")[1])
            cameraLayout.update({ panels: cameraPanels(cameraLayout.get()).filter((panel) => panel.id !== id) })
        },
    }
}

export function CameraPanels({ app }: { app: ViewerApp }) {
    const layout = useStore(cameraLayout)
    const panels = cameraPanels(layout)
    const { topics } = useStore(app.connection.status)

    // a camera panel with no topic yet takes the profile's preferred camera as soon as one is on the bus
    const imageKeys = topics.filter(isImage).map((topic) => topic.key).join("|")
    useEffect(() => {
        const current = cameraPanels(cameraLayout.get())
        const empty = current.find((panel) => !panel.key)
        const first = empty && pickPreferred(app.profile.cameras.preferred, app.connection.status.get().topics)
        if (empty && first) {
            updatePanel(empty.id, { key: first.key })
        }
    }, [imageKeys, app])

    // a panel whose topic isn't on the bus (saved from another blueprint, the robot vs its sim) moves to the default
    // camera once the topics settle; the viewer's own pick comes back when it does
    useEffect(() => {
        if (!imageKeys) {
            return
        }
        const timer = setTimeout(() => {
            const next = retargetPanels(cameraPanels(cameraLayout.get()), app.connection.status.get().topics, app.profile.cameras.preferred)
            if (next) {
                cameraLayout.update({ panels: next })
            }
        }, SETTLE_MS)
        return () => clearTimeout(timer)
    }, [imageKeys, app])

    return (
        <>
            {panels.map((panel) => <ContainCrash key={panel.id} what="Camera"><CameraPanel app={app} panel={panel} topics={topics} onChange={(patch) => updatePanel(panel.id, patch)} /></ContainCrash>)}
        </>
    )
}

/** how long the topic list has to stay the same before a panel on a missing topic moves to one that's there */
const SETTLE_MS = 3000

function CameraPanel({ app, panel, topics, onChange }: {
    app: ViewerApp
    panel: PanelState
    topics: Topic[]
    onChange: (patch: Partial<PanelState>) => void
}) {
    const tools = useRef<HTMLDivElement>(null)
    const video = useRef<HTMLVideoElement>(null)
    const depthHost = useRef<HTMLDivElement>(null)
    const depthRenderer = useRef<DepthCanvas | null>(null)
    const [depthError, setDepthError] = useState<string | null>(null)
    const depthLook = panel.depth ?? DEFAULT_DEPTH_LOOK
    const lookRef = useRef(depthLook)
    lookRef.current = depthLook
    const [depthRange, setDepthRange] = useState<[number, number] | null>(null)
    const overlayCanvas = useRef<HTMLCanvasElement>(null)
    const topic = topics.find((other) => other.key === panel.key) ?? null
    // "(gone)" only once this topic was on the bus and then left, not while it's still being discovered
    const everSeen = useRef<string | null>(null)
    if (topic) {
        everSeen.current = panel.key
    } else if (everSeen.current !== panel.key) {
        everSeen.current = null
    }
    const [size, setSize] = useState({ width: 0, height: 0, fps: 0 })
    const depth = topic ? isDepthTopic(topic) : false
    const slot = useWorkspaceApi().layout.slots[cameraId(panel.id)]
    const { hidden: pageHidden } = useStore(pageVisibility)
    const open = panelStreams(slot, pageHidden)

    // the stream (shared with a 3D projection of the same topic), only while the panel is open
    useEffect(() => {
        if (!topic || !open) {
            return
        }
        const source = app.video.acquire(topic)
        let noWebGL = false
        const unsubscribe = depth
            ? source.depth.subscribe(() => {
                const image = source.depth.get().image
                if (image && depthHost.current && !noWebGL) {
                    if (!depthRenderer.current) {
                        try {
                            depthRenderer.current = new DepthCanvas()
                        } catch (error) {
                            console.warn("depth view: WebGL2 unavailable", error)
                            noWebGL = true
                            setDepthError("this browser couldn't start WebGL2")
                            return
                        }
                        depthRenderer.current.canvas.className = "camera-media"
                        depthHost.current.prepend(depthRenderer.current.canvas)
                    }
                    const range = depthRenderer.current.draw(image, lookRef.current)
                    setDepthRange((old) => old && Math.abs(old[0] - range[0]) < 0.05 && Math.abs(old[1] - range[1]) < 0.05 ? old : range)
                    setSize((old) => old.width === image.width ? old : { width: image.width, height: image.height, fps: 0 })
                }
            })
            : source.video.subscribe(() => {
                const state = source.video.get()
                if (video.current && state.stream && video.current.srcObject !== state.stream) {
                    video.current.srcObject = state.stream
                    video.current.play().catch(() => {})
                }
                setSize({ width: state.width, height: state.height, fps: state.fps })
            })
        const state = source.video.get()
        if (!depth && video.current && state.stream) {
            video.current.srcObject = state.stream
            video.current.play().catch(() => {})
        }
        return () => {
            unsubscribe()
            app.video.release(topic)
        }
    }, [app, topic?.key, open])

    // the overlay (latest message, redrawn as it arrives)
    useEffect(() => {
        const overlayTopic = topics.find((other) => other.key === panel.overlay)
        const type = overlayTopic && overlayTypeFor(overlayTopic.type)
        const canvas = overlayCanvas.current
        if (!open || !overlayTopic || !type || !canvas) {
            canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height)
            return
        }
        return app.connection.subscribe(overlayTopic.key, { delivery: "latest", maxHz: 30 }, (message) => {
            const context = canvas.getContext("2d")!
            const width = size.width || canvas.width, height = size.height || canvas.height
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width
                canvas.height = height
            }
            context.clearRect(0, 0, width, height)
            try {
                type.draw(context, decode(overlayTopic.type, message.bytes), { width, height })
            } catch {
                // a message the overlay can't read: leave it blank
            }
        })
    }, [app, panel.overlay, topics.length, size.width, size.height, open])

    // the shown camera's tab in view (it can be off the end of a long row)
    useEffect(() => {
        const tab = tools.current?.querySelector<HTMLElement>(".camera-tab.on")
        const row = tab?.parentElement
        if (tab && row && (tab.offsetLeft < row.scrollLeft || tab.offsetLeft + tab.offsetWidth > row.scrollLeft + row.clientWidth)) {
            row.scrollLeft = tab.offsetLeft - 6
        }
    }, [panel.key, topics.length])

    // the whole picture letterboxed ("fit", object-fit: contain) or its box filled, edges cropped ("fill", cover); this viewer's, per panel
    const [fill, setFill] = useState(() => loadPanelFill(panel.id))
    const toggleFill = () => {
        setFill(!fill)
        savePanelFill(panel.id, !fill)
    }

    // the latency/quality menu (gear over the picture)
    const [qualityOpen, setQualityOpen] = useState(false)
    const gear = useRef<HTMLButtonElement>(null)
    const quality = useQuality(app, open ? topic : null, depth)
    useEffect(() => {
        if (!qualityOpen) {
            return
        }
        const close = (event: Event) => {
            if (!(event.target as HTMLElement).closest?.(".camera-quality, .quality-menu")) {
                setQualityOpen(false)
            }
        }
        addEventListener("pointerdown", close, true)
        return () => removeEventListener("pointerdown", close, true)
    }, [qualityOpen])

    const info = size.width ? `${size.width}×${size.height}${size.fps ? ` · ${size.fps} fps` : ""}${depth && depthRange ? ` · ${depthRange[0].toFixed(1)}–${depthRange[1].toFixed(1)} m` : ""}` : ""
    const overlays = topics.filter((other) => overlayTypeFor(other.type))
    const tabs = cameraTabs(topics)
    const nextTab = tabs.length > 1 ? tabs[(tabs.findIndex((tab) => tab.topic.key === panel.key) + 1) % tabs.length] : null
    const qualityIndex = QUALITY_PRESETS.findIndex((preset) => preset.id === quality)
    const nextQuality = QUALITY_PRESETS[(qualityIndex + 1) % QUALITY_PRESETS.length]
    useDockActions(cameraId(panel.id), [
        { id: "fill", label: fill ? "Fill" : "Fit", icon: fill ? "fill" : "fit", title: fill ? "Fill: the picture fills the view, edges cropped (click to fit the whole picture)" : "Fit: the whole picture, letterboxed (click to fill the view)", pressed: fill, run: toggleFill },
        ...(nextTab ? [{ id: "next", label: "Next camera", icon: "camera", title: `Show ${nextTab.topic.name}`, run: () => onChange({ key: nextTab.topic.key, picked: nextTab.topic.key }) }] : []),
        ...(topic && !depth ? [{ id: "quality", label: `mode: ${presetFor(quality).id}`, icon: "settings", title: `${presetFor(quality).label}: ${presetFor(quality).about} (click for ${nextQuality.label})`, run: () => app.video.setQuality(topic, nextQuality.id) }] : []),
    ])
    return (
        <Panel
            id={cameraId(panel.id)}
            title={panelTitle(cameraId(panel.id))}
            icon="camera"
            className="camera-video"
            testid="camera-panel"
            info={info || (topic ? "…" : "")}
            bodyClassName={fill ? "camera-body fill" : "camera-body"}
            tools={
                <div className="camera-tools" ref={tools}>
                    <div className="camera-tabs" role="tablist" aria-label="Cameras" onWheel={(event) => (event.currentTarget.scrollLeft += event.deltaY)}>
                        {!topic && panel.key && (
                            <span className="camera-tab gone" title={parseKey(panel.key)?.name ?? panel.key}>{(everSeen.current ? "(gone) " : "") + (parseKey(panel.key)?.name ?? panel.key)}</span>
                        )}
                        {tabs.map((tab) => (
                            <button
                                key={tab.topic.key}
                                type="button"
                                role="tab"
                                aria-selected={tab.topic.key === panel.key}
                                className={`camera-tab ${tab.topic.key === panel.key ? "on" : ""} ${tab.depth ? "depth" : ""}`}
                                title={`${tab.topic.name} (${tab.topic.type})`}
                                onClick={() => onChange({ key: tab.topic.key, picked: tab.topic.key })}
                            >
                                {tab.label}
                            </button>
                        ))}
                        {!tabs.length && !panel.key && <span className="camera-tab gone">no camera on the bus yet</span>}
                    </div>
                    {overlays.length > 0 && (
                        <Select value={panel.overlay} options={[["", "no overlay"], ...overlays.map((other) => [other.key, other.name] as [string, string])]} onChange={(overlay) => onChange({ overlay })} aria-label="Overlay" />
                    )}
                    {depth && (
                        <>
                            <Select value={depthLook.colormap} options={DEPTH_COLORMAPS} onChange={(colormap) => onChange({ depth: { ...depthLook, colormap } })} aria-label="Depth colormap" />
                            <NumberInput nullable className="number depth-range" step={0.1} placeholder="near" title="near (m); empty = auto" value={depthLook.near} onChange={(near) => onChange({ depth: { ...depthLook, near } })} />
                            <NumberInput nullable className="number depth-range" step={0.1} placeholder="far" title="far (m); empty = auto" value={depthLook.far} onChange={(far) => onChange({ depth: { ...depthLook, far } })} />
                        </>
                    )}
                    <Button className="dr-btn--icon icon-button camera-fit" pressed={fill} title={fill ? "Fill: the picture fills its space, edges cropped (click to fit the whole picture)" : "Fit: the whole picture, letterboxed (click to fill its space)"} onClick={toggleFill}>
                        <Icon name={fill ? "fill" : "fit"} size={15} />
                    </Button>
                </div>
            }
        >
            {depth && depthError && <Unavailable what="Depth view" reason={depthError} />}
            {depth ? <div ref={depthHost} className="camera-media depth-host" /> : <video ref={video} className="camera-media" muted playsInline autoPlay disablePictureInPicture disableRemotePlayback />}
            <canvas ref={overlayCanvas} className="camera-overlay" />
            {!topic && <div className="camera-placeholder"><Icon name="camera" size={28} /><span>{tabs.length ? "Pick a camera from this panel's topic tabs (shown on hover) or the palette (/)" : "No camera on the bus yet"}</span></div>}
            {topic && !depth && (
                <div className={`camera-quality panel-chrome ${qualityOpen ? "open" : ""}`} onClick={(event) => event.stopPropagation()}>
                    <Button ref={gear} className="dr-btn--icon quality-gear" title={`Latency ↔ quality: ${presetFor(quality).label}`} aria-label="Latency or quality" aria-haspopup="menu" aria-expanded={qualityOpen} onClick={() => setQualityOpen(!qualityOpen)}>
                        <Icon name="settings" size={14} />
                    </Button>
                    {qualityOpen && createPortal(
                        <Card padded={false} className="quality-menu" role="menu" aria-label="Latency or quality" style={popoverPosition(gear.current, 236)} onClick={(event) => event.stopPropagation()}>
                            <div className="quality-title">Latency ↔ quality</div>
                            {QUALITY_PRESETS.map((preset) => (
                                <button
                                    key={preset.id}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={quality === preset.id}
                                    className={`quality-option ${quality === preset.id ? "on" : ""}`}
                                    onClick={() => {
                                        app.video.setQuality(topic, preset.id)
                                        setQualityOpen(false)
                                    }}
                                >
                                    <span className="quality-name">{preset.label}</span>
                                    <span className="quality-about">{preset.about}</span>
                                </button>
                            ))}
                        </Card>,
                        document.body,
                    )}
                </div>
            )}
        </Panel>
    )
}

/** panel id → the picture fills its box (cropped) instead of fitting it; per viewer */
const FILL_KEY = "lv.cameras.fill"
const loadPanelFill = (id: number): boolean => readLocal<Record<string, boolean>>(FILL_KEY, {})[id] === true
const savePanelFill = (id: number, fill: boolean) => writeLocal(FILL_KEY, { ...readLocal<Record<string, boolean>>(FILL_KEY, {}), [id]: fill })

/** The topic's quality preset as the shared source has it (changes in another panel of the same topic show here). */
function useQuality(app: ViewerApp, topic: Topic | null, depth: boolean): VideoQuality {
    const [quality, setQuality] = useState<VideoQuality>("balanced")
    useEffect(() => {
        if (!topic || depth) {
            return
        }
        const source = app.video.acquire(topic)
        const apply = () => setQuality(source.quality.get().quality)
        apply()
        const unsubscribe = source.quality.subscribe(apply)
        return () => {
            unsubscribe()
            app.video.release(topic)
        }
    }, [app, topic?.key, depth])
    return quality
}
