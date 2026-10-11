// The 3D view (dimos-react's Scene3D and layers) as a panel: Classic's full window behind everything, or (while a camera
// is main) a picture-in-picture with a header (drag it, double-click or the expand button for fullscreen) and a resize
// corner, or a layout's docked region. Its header has a point cloud menu (each PointCloud2 on the bus: on/off, this
// viewer's bandwidth preset, color and size, live points and bytes a second) and an off switch: off, every 3D layer
// stops (nothing subscribed, no bandwidth) and only a small bar to turn it back on is left. View-only: nothing here
// moves the robot.
import { useEffect, useMemo, useState } from "react"
import { Badge, Button, clampPanelBox, ColorSwatch, Icon, IconButton, PanelInfo, Popover, Segmented, Select, Slider, Text, Toggle, Toolbar, VIEW_PANEL_HEAD_PX, ViewPanel } from "dimos-react"
import {
    CLOUD_PRESETS,
    cloudQualities,
    cloudQualityOf,
    cloudRates,
    formatBytes,
    formatCount,
    FrameHighlight,
    GRADIENTS,
    Layer,
    RobotModel,
    Scene3D,
    SceneControls,
    SceneStats,
    setCloudQuality,
    TfFootnote,
    TopicLayers,
    useScene,
} from "dimos-react/three"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"
import { scenePanel, updateScenePanel } from "../logic/local.ts"
import type { Dock } from "../App.tsx"
import { useTfIssues } from "./sceneState.tsx"

const MIN_WIDTH = 220, MIN_HEIGHT = 150 + VIEW_PANEL_HEAD_PX
const COLOR_MODES: [string, string][] = [["height", "by height"], ["intensity", "by intensity"], ["range", "by distance"], ["solid", "solid"]]
/** the stand-in models dimos-react draws, by robot type (an arm is drawn by its TF frames) */
const MODEL_KINDS: Record<string, string> = { dog: "dog", humanoid: "humanoid", wheeled: "wheeled", drone: "drone" }

// deno-lint-ignore no-explicit-any
type LayerEntry = { topic: { key: string; name: string; type: string }; enabled: boolean; settings: any; status: Record<string, any> }
type CloudRate = { hz: number; pointsPerSecond: number; bytesPerSecond: number }

const isCloud = (entry: LayerEntry) => entry.topic.type === "sensor_msgs.PointCloud2"

/** The sum over the clouds being drawn. */
export function totalRate(rates: Record<string, CloudRate>) {
    const all = Object.values(rates)
    return {
        clouds: all.length,
        pointsPerSecond: all.reduce((sum, rate) => sum + rate.pointsPerSecond, 0),
        bytesPerSecond: all.reduce((sum, rate) => sum + rate.bytesPerSecond, 0),
    }
}

export function ScenePanel({ app, placement, dock, mobile, onMain, onTf }: {
    app: ControllerApp
    /** "main": Classic's full window; "float": the picture-in-picture while a camera is main; "dock": a layout's region */
    placement: "main" | "float" | "dock"
    dock: Dock | null
    mobile: boolean
    /** Classic: make the 3D view fullscreen again */
    onMain: () => void
    onTf: () => void
}) {
    const state = useStore(scenePanel)
    const off = state.off
    // off is per viewer and survives a reload: the layers stay stopped from the start
    useEffect(() => app.layers.setPaused(off), [app, off])
    const floating = placement === "float"
    const handleLeft = state.x < 0 || state.x + Math.max(state.width, MIN_WIDTH) / 2 > (globalThis.innerWidth || 1280) / 2
    const box = clampPanelBox(
        { ...state, width: state.width > 0 ? state.width : undefined, height: state.height > 0 ? state.height : undefined },
        { x: -1, y: -1, width: MIN_WIDTH, height: MIN_HEIGHT },
        { width: globalThis.innerWidth, height: globalThis.innerHeight },
        { width: MIN_WIDTH, height: MIN_HEIGHT },
    )
    const placed = box.x >= 0 ? { left: box.x, top: box.y, right: "auto", bottom: "auto" } : {}
    const sized = state.width > 0 && !off ? { width: box.width, height: box.height } : {}
    const style = floating && !mobile ? { ...placed, ...sized } : {}
    const setOff = (next: boolean) => updateScenePanel({ off: next })
    // a header (float, dock) carries the tools; the full window has them over its corner instead
    const headed = placement !== "main"
    const tools = (
        <>
            {!off && <SceneRate />}
            {off && <PanelInfo>off · nothing subscribed</PanelInfo>}
            {!off && <CloudMenu app={app} />}
            {floating && !off && <IconButton size="sm" icon="expand" label="Fullscreen 3D view (the camera becomes a popup)" onClick={onMain} />}
            <PowerButton off={off} onChange={setOff} />
        </>
    )
    return (
        <ViewPanel
            placement={placement}
            dock={dock}
            className={`scene-slot ${off ? "off" : ""}`}
            style={style}
            data-testid="scene-panel"
            top={48}
            onHeadDoubleClick={off ? undefined : onMain}
            onMove={floating && !mobile ? (x: number, y: number) => updateScenePanel({ x, y }) : undefined}
            resize={floating && !off && !mobile ? { corner: handleLeft ? "left" : "right", minimum: { width: MIN_WIDTH, height: MIN_HEIGHT }, onDone: (next: { x: number; y: number; width: number; height: number }) => updateScenePanel(next) } : null}
            head={headed ? <><span className="dr-view-panel-title"><Icon name="cube" size={14} />3D</span>{tools}</> : null}
        >
            <View app={app} overlays={placement !== "float"} onTf={onTf} />
            {!headed && !off && <Toolbar floating className="scene-tools">{tools}</Toolbar>}
            {off && !headed && (
                <Toolbar floating className="scene-off">
                    <Icon name="cube" size={15} />
                    <Text small>3D view off · nothing subscribed</Text>
                    <PowerButton off={off} onChange={setOff} />
                </Toolbar>
            )}
        </ViewPanel>
    )
}

/** The scene itself; it never remounts when the panel's placement changes (the same ViewPanel moves). */
function View({ app, overlays, onTf }: { app: ControllerApp; overlays: boolean; onTf: () => void }) {
    const view = useStore(app.settings)
    useStore(app.robot)
    const profile = app.profile
    const highlight = useStore(app.highlight)
    const { labels } = useStore(app.labels.list)
    const { annotations } = useStore(app.agent.list)
    const issues = useTfIssues(app)
    const kind = MODEL_KINDS[profile.type]
    const labelData = useMemo(() => labels.map((label) => ({ label: label.label, position: label.position, frame: label.frame_id, color: "var(--warn)" })), [labels])
    const boxData = useMemo(() => annotations.map((annotation) => ({ center: annotation.center, size: annotation.size, yaw: annotation.yaw, frame: annotation.frame, label: [annotation.label || annotation.id, annotation.note].filter(Boolean).join("\n"), color: annotation.color || "var(--warn)", fill: 0.14 })), [annotations])
    return (
        <Scene3D
            className="scene"
            tf={app.tf}
            fixedFrame={view.fixedFrame || profile.fixedFrame || undefined}
            follow={view.follow}
            onFollowChange={(follow: boolean) => app.settings.update({ follow })}
            followFrame={app.followFrame}
            robotFrame={profile.baseFrame}
            viewDistance={profile.viewDistance ?? 7}
            layerOptions={{ baseFrame: profile.baseFrame, cameraInfo: profile.cameras.cameraInfo }}
            topics={() => app.connection.status.get().topics}
        >
            <SceneBridge app={app} />
            <TopicLayers manager={app.layers} />
            {kind && <RobotModel kind={kind} frame={profile.baseFrame} visible={view.robotModel !== false} />}
            <FrameHighlight frame={highlight.frame} onPlaced={(placed: boolean) => app.highlight.get().placed !== placed && app.highlight.update({ placed })} />
            <Layer type="labeled-points" data={labelData} />
            <Layer type="boxes3d" data={boxData} />
            {overlays && <SceneControls frameAll={false} />}
            {overlays && <TfFootnote issues={issues} onOpen={onTf} />}
            {view.showStats && <SceneStats detailed rttMs={app.connection.status.get().rttMs} className="stats-overlay" />}
        </Scene3D>
    )
}

/** Lends the mounted scene's viewer and camera actions to the logic (agent camera commands, captures, label picking). */
function SceneBridge({ app }: { app: ControllerApp }) {
    const scene = useScene()
    useEffect(() => {
        if (!scene.viewer) {
            return
        }
        app.attachScene({ viewer: scene.viewer, actions: scene.actions, fixedFrame: () => scene.viewer.fixedFrame })
        return () => app.attachScene(null)
    }, [app, scene.viewer, scene.actions])
    return null
}

function PowerButton({ off, onChange }: { off: boolean; onChange: (off: boolean) => void }) {
    return (
        <IconButton
            size="sm"
            icon="power"
            className={`scene-power ${off ? "" : "on"}`}
            pressed={!off}
            label={off ? "Turn the 3D view on (subscribes to its layers again)" : "Turn the 3D view off (unsubscribes every 3D layer: no bandwidth)"}
            onClick={() => onChange(!off)}
        />
    )
}

function SceneRate() {
    const total = totalRate(useStore(cloudRates) as Record<string, CloudRate>)
    const text = total.clouds ? `${formatCount(total.pointsPerSecond)} pts/s · ${formatBytes(total.bytesPerSecond)}/s` : "no cloud"
    return <PanelInfo title={`${total.clouds} point cloud${total.clouds === 1 ? "" : "s"} drawn: points and bytes received a second`}>{text}</PanelInfo>
}

function CloudMenu({ app }: { app: ControllerApp }) {
    const { list } = useStore(app.layers.entries) as { list: LayerEntry[] }
    const rates = useStore(cloudRates) as Record<string, CloudRate>
    useStore(cloudQualities)
    const [open, setOpen] = useState(false)
    const clouds = list.filter(isCloud)
    const on = clouds.filter((entry) => entry.enabled).length
    return (
        <Popover
            open={open}
            onOpenChange={setOpen}
            placement="bottom-end"
            className="cloud-menu"
            trigger={
                <Button variant="ghost" size="sm" icon="layers" className="scene-clouds" aria-haspopup="menu" aria-expanded={open} title={`Point clouds: ${on} of ${clouds.length} shown`} aria-label="Point clouds">
                    {clouds.length > 0 ? `${on}/${clouds.length}` : null}
                </Button>
            }
        >
            <Text as="div" small muted className="cloud-menu-title">Point clouds</Text>
            {!clouds.length && <Text as="p" small muted>No PointCloud2 on the bus yet.</Text>}
            {clouds.map((entry) => <CloudRow key={entry.topic.key} app={app} entry={entry} rate={rates[entry.topic.key]} />)}
        </Popover>
    )
}

function CloudRow({ app, entry, rate }: { app: ControllerApp; entry: LayerEntry; rate: CloudRate | undefined }) {
    const { look } = useStore(entry.settings) as { look: { colorMode: string; gradient: string; solid: string; size: number } }
    const quality = cloudQualityOf(entry.topic.key)
    const preset = (CLOUD_PRESETS as { id: string; label: string; about: string }[]).find((other) => other.id === quality)!
    const setLook = (patch: Partial<typeof look>) => entry.settings.update({ look: { ...look, ...patch } })
    return (
        <div className={`cloud-row ${entry.enabled ? "on" : ""}`} data-key={entry.topic.key}>
            <div className="cloud-line">
                <Toggle size="sm" value={entry.enabled} onChange={(enabled: boolean) => app.layers.setEnabled(entry.topic.key, enabled)} />
                <Text className="cloud-name" title={entry.topic.key}>{entry.topic.name}</Text>
                <Badge className="dr-mono">{entry.enabled && rate ? `${formatCount(rate.pointsPerSecond)} pts/s · ${formatBytes(rate.bytesPerSecond)}/s` : entry.enabled ? "…" : "off"}</Badge>
            </div>
            {entry.enabled && (
                <div className="cloud-controls">
                    <Segmented
                        size="sm"
                        label={`${entry.topic.name} bandwidth`}
                        title={preset?.about}
                        value={quality}
                        onChange={(id: string) => setCloudQuality(entry.topic.key, id)}
                        items={(CLOUD_PRESETS as { id: string; label: string; about: string }[]).map((option) => ({ value: option.id, label: option.id === "low" ? "Low" : option.label, title: option.about }))}
                    />
                    <Select size="sm" value={look.colorMode} options={COLOR_MODES} aria-label={`${entry.topic.name} color by`} onChange={(colorMode: string) => setLook({ colorMode })} />
                    {look.colorMode === "solid"
                        ? <ColorSwatch value={look.solid} label={`${entry.topic.name} solid color`} onChange={(solid: string) => setLook({ solid })} />
                        : <Select size="sm" value={look.gradient} options={GRADIENTS as string[]} aria-label={`${entry.topic.name} colormap`} onChange={(gradient: string) => setLook({ gradient })} />}
                    <Slider min={0.01} max={0.5} step={0.01} value={look.size} aria-label={`${entry.topic.name} point size`} format={(size: number) => `${Math.round(size * 100)} cm`} onChange={(size: number) => setLook({ size })} />
                </div>
            )}
        </div>
    )
}
