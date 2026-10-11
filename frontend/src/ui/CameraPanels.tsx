// Camera panels: one by default (the profile's preferred camera), more on demand. In Classic any panel can take over
// the screen, which shrinks the 3D view into a picture-in-picture; a docked layout (logic/layout.ts) shows the first one
// in its camera region. Each panel is dimos-react's ViewPanel around a CameraView (the gateway's video track at this
// viewer's latency ↔ quality preset, depth as a colormap, an optional 2D detection overlay).
import { useEffect, useRef, useState } from "react"
import {
    Button,
    CameraTabs,
    CameraView,
    DEPTH_COLORMAPS,
    Icon,
    IconButton,
    IMAGE_OVERLAY_TYPES,
    isDepthTopic,
    isImageTopic,
    Menu,
    NumberInput,
    PanelInfo,
    parseKey,
    pickCamera,
    retargetCameras,
    Select,
    useVideoQuality,
    VIDEO_PRESETS,
    VIEW_PANEL_HEAD_PX,
    ViewPanel,
} from "dimos-react"
import type { ControllerApp } from "../logic/controller.ts"
import { type Store, useStore } from "../logic/settings.ts"
import type { Topic } from "../logic/connection.ts"
import { readLocal, writeLocal } from "../logic/local.ts"
import type { Dock } from "../App.tsx"

export interface DepthLook {
    colormap: string
    near: number | null
    far: number | null
}

export interface PanelState {
    id: number
    /** image topic key ("" until one is picked) */
    key: string
    /** the topic key the viewer picked from the tabs (shown again whenever it's on the bus) */
    picked?: string
    /** overlay topic key ("" = none) */
    overlay: string
    x: number
    y: number
    width: number
    height: number
    /** the user resized it: keep that size (else it fits the image's aspect) */
    sized?: boolean
    /** got the default size once */
    fitted?: boolean
    /** depth topics: colormap and fixed range (null = auto) */
    depth?: DepthLook
}

export interface CameraLayout {
    panels: PanelState[]
    /** the panel shown fullscreen (the 3D view becomes a picture-in-picture), or null */
    main: number | null
    /** a panel was opened on the first camera once (closing it all stays closed) */
    seeded?: boolean
    /** the camera is main because nothing draws in 3D (no point cloud): a cloud showing up gives the view back */
    auto?: boolean
    /** the panel that was opened for that (closed again with it) */
    autoPanel?: number | null
}

const DEFAULT_DEPTH_LOOK: DepthLook = { colormap: "turbo", near: null, far: null }

/** a lidar / point cloud: what makes the 3D view worth the screen */
export const isCloudTopic = (topic: Topic) => topic.type === "sensor_msgs.PointCloud2" || /lidar/i.test(topic.name)

/** the user swapped the layout themselves this session: the camera-only default leaves it alone */
let userChoseLayout = false
export function chooseLayout() {
    userChoseLayout = true
}

/** how long the topic list has to stay the same before a camera-only blueprint gets the camera layout (topics arrive one by one) */
const SETTLE_MS = 3000

function pickDefault(app: ControllerApp, topics: Topic[]): Topic | null {
    return pickCamera(app.profile.cameras.preferred, topics)
}

/** The size before the image's is known: ~38% of the window, 16:9. */
function defaultSize() {
    const width = Math.round(Math.max(320, Math.min(760, (globalThis.innerWidth || 1280) * 0.38)))
    return { width, height: Math.round(width * 9 / 16) + VIEW_PANEL_HEAD_PX }
}

export function CameraPanels({ app, layout, mobile, dock }: {
    app: ControllerApp
    layout: Store<CameraLayout>
    mobile: boolean
    /** a docked layout's camera region (null: Classic, the panels float) */
    dock: Dock | null
}) {
    const { panels, main, seeded } = useStore(layout)
    const { topics } = useStore(app.connection.status)

    // the first time a camera shows up, open exactly one panel on it
    useEffect(() => {
        if (panels.length || seeded) {
            return
        }
        const first = pickDefault(app, topics)
        if (first) {
            layout.update({ seeded: true, panels: [{ id: 1, key: first.key, overlay: "", x: -1, y: -1, ...defaultSize(), fitted: true }] })
        }
    }, [topics, panels.length, seeded, app, layout])

    // a panel whose topic isn't on the bus moves to the default camera once the topics settle; the viewer's own pick comes back when it does
    const imageKeys = topics.filter(isImageTopic).map((topic) => topic.key).join("|")
    useEffect(() => {
        if (!imageKeys) {
            return
        }
        const timer = setTimeout(() => {
            const next = retargetCameras(layout.get().panels, app.connection.status.get().topics, app.profile.cameras.preferred)
            if (next) {
                layout.update({ panels: next })
            }
        }, SETTLE_MS)
        return () => clearTimeout(timer)
    }, [imageKeys, app, layout])

    // camera-only (no point cloud, a camera): the camera fills the screen and the 3D view becomes the picture-in-picture
    const topicKeys = topics.map((topic) => topic.key).join("|")
    useEffect(() => {
        const clouds = topics.some(isCloudTopic)
        const current = layout.get()
        if (clouds) {
            if (current.auto) {
                const panels = current.autoPanel ? current.panels.filter((panel) => panel.id !== current.autoPanel) : current.panels
                layout.update({ main: null, auto: false, autoPanel: null, panels })
            }
            return
        }
        if (current.main !== null || userChoseLayout || !topics.some(isImageTopic)) {
            return
        }
        const timer = setTimeout(() => {
            const latest = app.connection.status.get().topics
            const now = layout.get()
            if (latest.some(isCloudTopic) || now.main !== null || userChoseLayout) {
                return
            }
            const camera = now.panels.find((panel) => latest.some((topic) => topic.key === panel.key && isImageTopic(topic)))
            if (camera) {
                layout.update({ main: camera.id, auto: true })
                return
            }
            const first = pickDefault(app, latest)
            if (first) {
                const id = Math.max(0, ...now.panels.map((panel) => panel.id)) + 1
                layout.update({ seeded: true, auto: true, autoPanel: id, main: id, panels: [...now.panels, { id, key: first.key, overlay: "", x: -1, y: -1, ...defaultSize(), fitted: true }] })
            }
        }, SETTLE_MS)
        return () => clearTimeout(timer)
    }, [topicKeys, app, layout])

    const update = (id: number, patch: Partial<PanelState>) => layout.update({ panels: layout.get().panels.map((panel) => panel.id === id ? { ...panel, ...patch } : panel) })
    const close = (id: number) => {
        const current = layout.get()
        const wasMain = current.main === id
        if (wasMain) {
            chooseLayout()
        }
        layout.update({ panels: current.panels.filter((panel) => panel.id !== id), main: wasMain ? null : current.main, auto: wasMain ? false : current.auto, autoPanel: current.autoPanel === id ? null : current.autoPanel })
    }
    const add = () => {
        const used = new Set(panels.map((panel) => panel.key))
        const next = topics.filter(isImageTopic).find((topic) => !used.has(topic.key)) ?? pickDefault(app, topics)
        const id = Math.max(0, ...panels.map((panel) => panel.id)) + 1
        layout.update({ panels: [...panels, { id, key: next?.key ?? "", overlay: "", x: -1, y: -1, ...defaultSize(), fitted: true }] })
    }

    if (dock) {
        const first = panels[0]
        return first
            ? <CameraPanel key={first.id} app={app} panel={first} index={0} topics={topics} isMain={false} dock={dock} mobile={mobile} onChange={(patch) => update(first.id, patch)} onClose={() => close(first.id)} onMain={() => {}} />
            : (
                <ViewPanel placement="dock" dock={dock} className="camera-empty" head={<span className="dr-view-panel-title"><Icon name="camera" size={14} />Camera</span>}>
                    <div className="centered">
                        <Button size="sm" icon="plus" onClick={add}>{topics.some(isImageTopic) ? "Show a camera" : "No camera on the bus yet"}</Button>
                    </div>
                </ViewPanel>
            )
    }
    return (
        <>
            {panels.map((panel, index) => (
                <CameraPanel
                    key={panel.id}
                    app={app}
                    panel={panel}
                    index={index}
                    topics={topics}
                    isMain={main === panel.id}
                    dock={null}
                    mobile={mobile}
                    onChange={(patch) => update(panel.id, patch)}
                    onClose={() => close(panel.id)}
                    onMain={() => {
                        chooseLayout()
                        layout.update({ main: main === panel.id ? null : panel.id, auto: false, autoPanel: null })
                    }}
                />
            ))}
            <IconButton className="add-camera" variant="default" icon="camera" label="Add a camera panel" onClick={add} />
        </>
    )
}

function CameraPanel({ app, panel, index, topics, isMain, dock, mobile, onChange, onClose, onMain }: {
    app: ControllerApp
    panel: PanelState
    index: number
    topics: Topic[]
    isMain: boolean
    dock: Dock | null
    mobile: boolean
    onChange: (patch: Partial<PanelState>) => void
    onClose: () => void
    onMain: () => void
}) {
    const topic = topics.find((other) => other.key === panel.key) ?? null
    // "(gone)" only once this topic was on the bus and then left, not while it's still being discovered
    const everSeen = useRef<string | null>(null)
    if (topic) {
        everSeen.current = panel.key
    } else if (everSeen.current !== panel.key) {
        everSeen.current = null
    }
    const depth = topic ? isDepthTopic(topic) : false
    const depthLook = panel.depth ?? DEFAULT_DEPTH_LOOK
    const [info, setInfo] = useState<{ width: number; height: number; fps: number; range: [number, number] | null }>({ width: 0, height: 0, fps: 0, range: null })
    const [quality, setQuality] = useVideoQuality(topic)

    // size: this viewer's width (dragged with the corner handle, kept in localStorage), the height from the image's
    // aspect, so there are never bars; until the image's size is known, the default 16:9
    const [viewerWidth, setViewerWidth] = useState<number | null>(() => loadPanelWidth(panel.id))
    const aspect = info.width && info.height ? info.height / info.width : 9 / 16
    const width = clampWidth(viewerWidth ?? (panel.fitted ? panel.width : defaultSize().width), aspect)
    const height = Math.round(width * aspect) + VIEW_PANEL_HEAD_PX
    // the handle sits on the corner facing into the screen: bottom-left for a panel on the right half (the default)
    const handleLeft = panel.x < 0 || panel.x + width / 2 > (globalThis.innerWidth || 1280) / 2

    // fullscreen only: the whole picture letterboxed ("fit") or the screen filled, edges cropped ("fill"); per panel
    const [fill, setFill] = useState(() => loadPanelFill(panel.id))
    const toggleFill = () => {
        setFill(!fill)
        savePanelFill(panel.id, !fill)
    }

    const floating = !isMain && !dock
    const fills = isMain || !!dock
    const style: React.CSSProperties = floating && !mobile
        ? { width, height, ...(panel.x >= 0 ? { left: panel.x, top: panel.y } : { right: 12, top: 60 + index * (height + 12) }) }
        : mobile && floating && info.width && info.height
        ? { "--cam-aspect": (info.height / info.width).toFixed(4) } as React.CSSProperties
        : {}
    const infoText = info.width ? `${info.width}×${info.height}${info.fps ? ` · ${info.fps} fps` : ""}${depth && info.range ? ` · ${info.range[0].toFixed(1)}–${info.range[1].toFixed(1)} m` : ""}` : ""
    const overlays = topics.filter((other) => IMAGE_OVERLAY_TYPES.includes(other.type))
    const overlayTopic = topics.find((other) => other.key === panel.overlay) ?? null
    const goneName = !topic && panel.key ? (everSeen.current ? "(gone) " : "") + ((parseKey(panel.key) as Topic | null)?.name ?? panel.key) : null
    const presetLabel = (VIDEO_PRESETS as { id: string; label: string }[]).find((preset) => preset.id === quality)?.label ?? "Balanced"
    return (
        <ViewPanel
            placement={dock ? "dock" : isMain ? "main" : "float"}
            dock={dock}
            className="camera-video"
            style={style}
            top={48}
            title={infoText}
            onHeadDoubleClick={onMain}
            onMove={floating && !mobile ? (x: number, y: number) => onChange({ x, y }) : undefined}
            resize={floating && !mobile
                ? {
                    corner: handleLeft ? "left" : "right",
                    minimum: { width: 200, height: 0 },
                    aspect,
                    onDone: (box: { x: number; y: number; width: number }) => {
                        setViewerWidth(box.width)
                        savePanelWidth(panel.id, box.width)
                        onChange({ x: box.x, y: box.y })
                    },
                }
                : null}
            bodyOnClick={mobile && floating ? onMain : undefined}
            head={
                <>
                    <CameraTabs topics={topics} value={panel.key} gone={goneName} onChange={(next: Topic) => onChange({ key: next.key, picked: next.key })} />
                    {overlays.length > 0 && (
                        <Select size="sm" value={panel.overlay} aria-label="Overlay" options={[["", "no overlay"], ...overlays.map((other) => [other.key, other.name])]} onChange={(overlay: string) => onChange({ overlay })} />
                    )}
                    {depth && (
                        <>
                            <Select size="sm" value={depthLook.colormap} aria-label="Depth colormap" options={DEPTH_COLORMAPS as string[]} onChange={(colormap: string) => onChange({ depth: { ...depthLook, colormap } })} />
                            <NumberInput size="sm" className="depth-range" step={0.1} min={0} placeholder="near" title="near (m); empty = auto" value={depthLook.near} onChange={(near: number) => onChange({ depth: { ...depthLook, near } })} />
                            <NumberInput size="sm" className="depth-range" step={0.1} min={0} placeholder="far" title="far (m); empty = auto" value={depthLook.far} onChange={(far: number) => onChange({ depth: { ...depthLook, far } })} />
                            {(depthLook.near !== null || depthLook.far !== null) && <IconButton size="sm" icon="refresh" label="Automatic range" onClick={() => onChange({ depth: { ...depthLook, near: null, far: null } })} />}
                        </>
                    )}
                    <PanelInfo>{infoText || "…"}</PanelInfo>
                    {topic && !depth && (!mobile || !floating) && (
                        <Menu
                            placement="bottom-end"
                            trigger={<IconButton size="sm" icon="settings" label={`Latency ↔ quality: ${presetLabel}`} className="quality-gear" />}
                            items={[
                                { heading: "Latency ↔ quality" },
                                ...(VIDEO_PRESETS as { id: string; label: string; about: string }[]).map((preset) => ({ label: preset.label, title: preset.about, checked: quality === preset.id, onSelect: () => setQuality(preset.id) })),
                            ]}
                        />
                    )}
                    {fills && <IconButton size="sm" icon={fill ? "fill" : "fit"} pressed={fill} label={fill ? "Fill: the picture fills its space, edges cropped (click to fit the whole picture)" : "Fit: the whole picture, letterboxed (click to fill its space)"} onClick={toggleFill} />}
                    {!dock && <IconButton size="sm" icon="expand" label={isMain ? "Back to the 3D view" : "Fullscreen camera (3D becomes a popup)"} onClick={onMain} />}
                    {!dock && <IconButton size="sm" icon="close" label="Close" onClick={onClose} />}
                </>
            }
        >
            <CameraView topic={topic} overlay={overlayTopic} fill={fills && fill} depthLook={depthLook} onInfo={setInfo} />
        </ViewPanel>
    )
}

/** The smallest and largest a floating camera gets: at least 200 px wide, at most the window between the top bar and
 * the drive guide (so the handle in the corner stays reachable). */
function clampWidth(width: number, aspect: number) {
    const maxWidth = Math.min((globalThis.innerWidth || 1280) - 24, ((globalThis.innerHeight || 800) - 60 - 110 - VIEW_PANEL_HEAD_PX) / aspect)
    return Math.round(Math.max(Math.min(200, maxWidth), Math.min(maxWidth, width)))
}

/** panel id → width this viewer dragged it to (per viewer: a phone and a desktop don't share it) */
const SIZE_KEY = "lv.cameras.width"
const loadPanelWidth = (id: number): number | null => readLocal<Record<string, number>>(SIZE_KEY, {})[id] ?? null
const savePanelWidth = (id: number, width: number) => writeLocal(SIZE_KEY, { ...readLocal<Record<string, number>>(SIZE_KEY, {}), [id]: width })

/** panel id → fullscreen fills the screen (cropped) instead of fitting the picture; per viewer, like the width */
const FILL_KEY = "lv.cameras.fill"
const loadPanelFill = (id: number): boolean => readLocal<Record<string, boolean>>(FILL_KEY, {})[id] === true
const savePanelFill = (id: number, fill: boolean) => writeLocal(FILL_KEY, { ...readLocal<Record<string, boolean>>(FILL_KEY, {}), [id]: fill })
