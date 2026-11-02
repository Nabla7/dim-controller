// The 3D view (lidar, maps, TF, the robot model) as a workspace panel (ui/Panel.tsx). Its tools: points and bytes a
// second, pause (hold what it shows while the camera still moves; core/freeze.ts), a snapshot and the gallery
// (ui/SnapshotGallery.tsx), and its menu (a search box past ten switches, each group folding): cameras in 3D (the same
// setting as Settings → 3D view), then each PointCloud2 on the bus (on/off,
// this viewer's bandwidth preset, color and size), then every other layer (TF, maps, markers…: ui/LayersPanel.tsx).
// Collapsed (or off screen: a shut drawer, a rail hidden by focus) every 3D layer stops: nothing subscribed, no
// bandwidth; expanded, they subscribe again. Follow sits over its corner, and in the dock while it's the main view.
// View-only: nothing here moves the robot. The element the viewer draws into (`host`) is never remounted, wherever the
// panel goes.
import { type RefObject, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ViewerApp } from "../core/app.ts"
import type { LayerEntry } from "../core/layers/manager.ts"
import { allLayerTypes } from "../core/layers/registry.ts"
import { type Store, useStore } from "../core/store.ts"
import { CLOUD_PRESETS, cloudQualities, cloudQualityOf, type CloudQuality, type CloudRate, cloudRates, formatBytes, formatCount, setCloudQuality } from "../core/cloudQuality.ts"
import { GRADIENTS, ViewCube } from "dimos-react/three"
import { COLOR_MODES, type PointLook } from "../core/render/rendering.ts"
import type { CloudSettings } from "../layers/pointcloud.tsx"
import { Icon } from "./icons.tsx"
import { Button, Card, NumberInput, SearchInput, Segmented, Select, Slider, Tabs, Toggle } from "dimos-react"
import { popoverPosition } from "./panelDrag.ts"
import { Panel } from "./Panel.tsx"
import { DriveHint } from "./KeyOverlay.tsx"
import { ViewControls } from "./ViewControls.tsx"
import { TfFootnote } from "./TfFootnote.tsx"
import { panelTitle } from "./commands.ts"
import { useWorkspaceApi } from "./Workspace.tsx"
import { useDockActions } from "./dockActions.ts"
import { Unavailable } from "./Unavailable.tsx"
import { GroupTitle, LayerList, useCollapsedGroups } from "./LayersPanel.tsx"
import { FILTER_OVER, matchesQuery } from "../core/topicFilter.ts"
import { ManipActions, ManipPanel } from "./ManipPanel.tsx"
import { ArmPanel } from "./ArmPanel.tsx"
import { JointSection } from "./JointControl.tsx"
import { armsPanelShown } from "./ArmsPanel.tsx"
import { jointControlState } from "../core/jointControl.ts"
import { SceneSettings } from "./SettingsPanel.tsx"
import { SnapshotTools } from "./SnapshotGallery.tsx"
import { saveSnapshot, snapshot3d } from "../core/snapshots.ts"


const isCloud = (entry: LayerEntry) => entry.topic.type === "sensor_msgs.PointCloud2"
/** the menu's first group: the point clouds, each with its bandwidth preset and look */
const CLOUDS_LABEL = "Point clouds"

/** The sum over the clouds being drawn. */
export function totalRate(rates: Record<string, CloudRate>): CloudRate & { clouds: number } {
    const all = Object.values(rates)
    return {
        clouds: all.length,
        hz: 0,
        pointsPerSecond: all.reduce((sum, rate) => sum + rate.pointsPerSecond, 0),
        bytesPerSecond: all.reduce((sum, rate) => sum + rate.bytesPerSecond, 0),
    }
}

export function ScenePanel({ host, app, onTf }: { host: RefObject<HTMLDivElement | null>; app: ViewerApp | null; onTf: () => void }) {
    const slot = useWorkspaceApi().layout.slots.scene
    const off = !slot || slot.hidden || slot.collapsed
    const [menuOpen, setMenuOpen] = useState(false)
    const cloudButton = useRef<HTMLButtonElement>(null)

    // collapsed or off screen: every 3D layer unsubscribes; expanded: they subscribe again
    useEffect(() => {
        app?.layers.setPaused(off)
        if (off) {
            setMenuOpen(false)
            // its layers restart when it's back on: live, not paused with nothing to show
            app?.layers.setFrozen(false)
        }
    }, [app, off])

    return (
        <>
        {app && <SceneDockActions app={app} />}
        <Panel
            id="scene"
            title={panelTitle("scene")}
            icon="cube"
            className={`scene-slot ${off ? "off" : ""}`}
            testid="scene-panel"
            keepMounted
            settings={app ? () => <SceneSettings app={app} /> : undefined}
            info={slot?.collapsed ? "collapsed · nothing subscribed" : app ? <SceneRate app={app} /> : undefined}
            tools={app && !off && (
                <div className="scene-tools">
                    <JointControlButton app={app} />
                    <PauseButton app={app} />
                    <SnapshotTools what="3D view" take={async () => saveSnapshot(await snapshot3d(() => app.viewer.capture()), "3d")} />
                    <CloudButton app={app} open={menuOpen} onOpen={setMenuOpen} buttonRef={cloudButton} />
                </div>
            )}
        >
            <div ref={host} className="scene" />
            {app?.viewer.webglError && !off && <Unavailable what="3D view" reason={app.viewer.webglError} />}
            {app && !off && !app.viewer.webglError && <SceneViewCube app={app} host={host} />}
            {app && !off && <ViewControls app={app} />}
            {app && !off && <JointControlArea app={app} />}
            {app && !off && <TfFootnote app={app} onOpen={onTf} />}
            {app && !off && <SceneWaiting app={app} />}
            {app && menuOpen && !off && <CloudMenu app={app} anchor={cloudButton.current} onClose={() => setMenuOpen(false)} />}
        </Panel>
        </>
    )
}

/** No point cloud coming in: the drive keys and what they do, so a first look at an empty view teaches the controls. */
function SceneWaiting({ app }: { app: ViewerApp }) {
    const total = totalRate(useStore(cloudRates))
    return total.clouds ? null : <div className="scene-waiting"><DriveHint app={app} waiting="Waiting for lidar data." /></div>
}

/** Settings → View cube: dimos-react's CAD view cube in the top-right corner (click a face, edge or corner to look from there, drag to orbit). */
function SceneViewCube({ app, host }: { app: ViewerApp; host: RefObject<HTMLDivElement | null> }) {
    const { viewCube } = useStore(app.settings)
    useEffect(() => {
        if (!viewCube || !host.current) {
            return
        }
        let cube: ViewCube
        try {
            cube = new ViewCube(app.viewer, host.current, { corner: "top-right" })
        } catch (error) {
            console.warn("view cube: WebGL unavailable", error)
            return
        }
        return () => cube.dispose()
    }, [app, host, viewCube])
    return null
}

/** Whether joint control can do anything here: an arm (the Arm format, a running planner) or a format's jogged joint with joint states. */
export function useJointControlAvailable(app: ViewerApp): boolean {
    const robot = useStore(app.robot)
    const runs = useStore(app.runs.state)
    const manipulation = useStore(app.manipulation.state)
    const arm = useStore(app.arm.state)
    return armsPanelShown(robot.type, runs, manipulation.available) || (!!app.profile.joint && arm.joints.length > 0)
}

/** The 3D view's "Enable joint control": the gizmos, Plan / Execute on top and the joint tabs at its side, while on. */
function JointControlButton({ app }: { app: ViewerApp }) {
    const { enabled } = useStore(jointControlState)
    if (!useJointControlAvailable(app)) {
        return null
    }
    return (
        <Button size="sm" className="joint-control-toggle" pressed={enabled} data-testid="joint-control-toggle" title={enabled ? "Hide the joint control" : "Move the joints: gizmos in the view, Plan / Execute, the joint tabs"} onClick={() => jointControlState.update({ enabled: !enabled })}>
            <Icon name="arm" size={14} /><span>{enabled ? "Joint control on" : "Enable joint control"}</span>
        </Button>
    )
}

/** Joint control turned on: Plan / Execute across the top of the view, and at its side the Joint control tab (planning groups,
 * saved poses, the target, each joint; a jogged joint) and its Settings tab (the scene, status, planning). */
function JointControlArea({ app }: { app: ViewerApp }) {
    const { enabled, tab } = useStore(jointControlState)
    const manipulation = useStore(app.manipulation.state)
    const robot = useStore(app.robot)
    const available = useJointControlAvailable(app)
    if (!enabled || !available) {
        return null
    }
    const planner = robot.type === "arm" || manipulation.available === true
    return (
        <>
            {planner && <div className="joint-top" data-testid="joint-top"><ManipActions app={app} testid="scene-manip" /></div>}
            <aside className="joint-side panel-body" data-testid="joint-side">
                <Tabs size="sm" label="Joint control" items={[["joints", "Joint control"], ["settings", "Settings"]]} value={tab} onChange={(next) => jointControlState.update({ tab: next as "joints" | "settings" })} />
                {tab === "joints"
                    ? (
                        <>
                            {app.profile.joint && <JointSection app={app} />}
                            {robot.type === "arm" && <ArmPanel app={app} />}
                            {planner && <ManipPanel app={app} part="control" actions={false} />}
                        </>
                    )
                    : planner ? <ManipPanel app={app} part="settings" actions={false} /> : <p className="hint">Nothing to set: this format jogs one joint (its speed and topic are on the Joint control tab).</p>}
            </aside>
        </>
    )
}

/** The 3D view's actions in the dock while it's the main view: follow the robot (again). */
function SceneDockActions({ app }: { app: ViewerApp }) {
    const view = useStore(app.settings)
    const { paused } = useStore(app.viewer.followPaused)
    const following = view.follow && !paused
    useDockActions("scene", [{
        id: "follow",
        label: following ? "Following" : "Follow",
        icon: "target",
        title: following ? `Following ${app.followFrame}: a pan looks around, click to reframe it` : `Follow ${app.followFrame} again`,
        pressed: following,
        run: () => app.recenter(),
    }])
    return null
}

/** Pause / resume the 3D view: paused, what's drawn stays put (orbit and zoom still work); resumed, it's live again. */
function PauseButton({ app }: { app: ViewerApp }) {
    const { frozen } = useStore(app.layers.hold.state)
    return (
        <Button
            className="dr-btn--icon icon-button scene-pause"
            pressed={frozen}
            data-testid="scene-pause"
            title={frozen ? "Paused: the 3D view holds what it showed (orbit and zoom still work). Click to go live" : "Pause the 3D view: hold what it shows now while you look around"}
            aria-label={frozen ? "Resume the 3D view" : "Pause the 3D view"}
            onClick={() => app.layers.setFrozen(!frozen)}
        >
            <Icon name={frozen ? "play" : "pause"} size={15} />
        </Button>
    )
}

function SceneRate({ app }: { app: ViewerApp }) {
    const { frozen, since } = useStore(app.layers.hold.state)
    const total = totalRate(useStore(cloudRates))
    if (frozen) {
        return <span className="scene-rate" title="The 3D view is paused: press play to go live">paused at {new Date(since!).toLocaleTimeString()}</span>
    }
    const text = total.clouds ? `${formatCount(total.pointsPerSecond)} pts/s · ${formatBytes(total.bytesPerSecond)}/s` : "no cloud"
    return <span className="scene-rate" title={`${total.clouds} point cloud${total.clouds === 1 ? "" : "s"} drawn: points and bytes received a second`}>{text}</span>
}

function CloudButton({ app, open, onOpen, buttonRef }: { app: ViewerApp; open: boolean; onOpen: (open: boolean) => void; buttonRef: RefObject<HTMLButtonElement | null> }) {
    const { list } = useStore(app.layers.entries)
    const on = list.filter((entry) => entry.enabled).length
    return (
        <Button ref={buttonRef} className="dr-btn--icon icon-button scene-clouds" aria-haspopup="menu" aria-expanded={open} title={`3D view layers: cameras in 3D, point clouds, TF and the rest (${on} of ${list.length} shown)`} aria-label="3D view settings" onClick={() => onOpen(!open)}>
            <Icon name="layers" size={15} />
            {list.length > 0 && <span className="scene-count">{on}/{list.length}</span>}
        </Button>
    )
}

function CloudMenu({ app, anchor, onClose }: { app: ViewerApp; anchor: HTMLElement | null; onClose: () => void }) {
    const { list } = useStore(app.layers.entries)
    const rates = useStore(cloudRates)
    useStore(cloudQualities)
    const [query, setQuery] = useState("")
    const searching = query.trim() !== ""
    const clouds = list.filter((entry) => isCloud(entry) && (!searching || matchesQuery(query, entry.topic.name, entry.topic.type, CLOUDS_LABEL)))
    const { collapsed, toggle } = useCollapsedGroups()
    const cloudsFolded = !searching && !!collapsed[CLOUDS_LABEL]
    useEffect(() => {
        const close = (event: Event) => {
            if (!(event.target as HTMLElement).closest?.(".cloud-menu, .scene-clouds")) {
                onClose()
            }
        }
        addEventListener("pointerdown", close, true)
        return () => removeEventListener("pointerdown", close, true)
    }, [onClose])
    return createPortal(
        <Card padded={false} className="cloud-menu" role="menu" aria-label="3D view settings" style={popoverPosition(anchor, 320)}>
            {list.length + 1 > FILTER_OVER && <SearchInput className="cloud-search" value={query} onChange={setQuery} placeholder="Filter topics…" aria-label="Filter the 3D view's topics" />}
            {(!searching || clouds.length > 0) && <GroupTitle label={CLOUDS_LABEL} count={clouds.length} collapsed={cloudsFolded} onToggle={() => toggle(CLOUDS_LABEL)} />}
            {!cloudsFolded && !searching && !clouds.length && <p className="cloud-empty">No PointCloud2 on the bus yet.</p>}
            {!cloudsFolded && clouds.map((entry) => <CloudRow key={entry.topic.key} app={app} entry={entry} rate={rates[entry.topic.key]} />)}
            <LayerList app={app} skip={isCloud} lead={[labelOf("graph")]} heads={{ [labelOf("camera3d")]: <CamerasIn3dRow app={app} /> }} query={query} />
        </Card>,
        document.body,
    )
}

/** a layer type's group label */
const labelOf = (id: string) => allLayerTypes().find((type) => type.id === id)?.label ?? id

/** Cameras in 3D: the same setting as Settings → 3D view (lv.view camerasIn3d) */
export function CamerasIn3dToggle({ app, label }: { app: ViewerApp; label?: string }) {
    const { camerasIn3d } = useStore(app.settings)
    return <Toggle value={camerasIn3d === true} onChange={(on) => app.settings.update({ camerasIn3d: on })} label={label} />
}

function CamerasIn3dRow({ app }: { app: ViewerApp }) {
    return (
        <div className="cloud-row cameras-3d-row" title="Each camera's picture and frustum at its CameraInfo frame. A camera whose panel is open shares its stream; otherwise the 3D view takes a small one a few times a second.">
            <CamerasIn3dToggle app={app} label="Cameras in 3D" />
        </div>
    )
}

function CloudRow({ app, entry, rate }: { app: ViewerApp; entry: LayerEntry; rate: CloudRate | undefined }) {
    const settings = entry.settings as Store<CloudSettings>
    const { look } = useStore(settings)
    const quality = cloudQualityOf(entry.topic.key)
    const setLook = (patch: Partial<PointLook>) => settings.update({ look: { ...look, ...patch } })
    const preset = CLOUD_PRESETS.find((other) => other.id === quality)!
    // the layer type's own row controls (a point cloud's accumulate + scan count), as the Layers list shows them
    const RowControls = entry.type.RowControls
    return (
        <div className={`cloud-row ${entry.enabled ? "on" : ""}`} data-key={entry.topic.key}>
            <div className="cloud-line">
                <Toggle value={entry.enabled} onChange={(enabled) => app.layers.setEnabled(entry.topic.key, enabled)} />
                <span className="cloud-name" title={entry.topic.key}>{entry.topic.name}</span>
                <span className="cloud-rate">{entry.enabled && rate ? `${formatCount(rate.pointsPerSecond)} pts/s · ${formatBytes(rate.bytesPerSecond)}/s` : entry.enabled ? "…" : "off"}</span>
            </div>
            {entry.enabled && (
                <div className="cloud-controls">
                    <div className="cloud-presets" role="radiogroup" aria-label={`${entry.topic.name} bandwidth`} title={preset.about}>
                        {CLOUD_PRESETS.map((option) => (
                            <button key={option.id} type="button" role="radio" aria-checked={quality === option.id} className={`cloud-preset ${quality === option.id ? "on" : ""}`} title={option.about} onClick={() => setCloudQuality(entry.topic.key, option.id as CloudQuality)}>
                                {option.id === "low" ? "Low" : option.label}
                            </button>
                        ))}
                    </div>
                    <Select size="sm" className="cloud-color" value={look.colorMode} aria-label={`${entry.topic.name} color by`} options={COLOR_MODES} onChange={(colorMode) => setLook({ colorMode })} />
                    {look.colorMode === "clear" ? null : look.colorMode === "solid"
                        ? (
                            <>
                                <input type="color" className="cloud-solid" value={look.solid} aria-label={`${entry.topic.name} solid color`} onChange={(event) => setLook({ solid: event.target.value })} />
                                <NumberInput size="sm" className="number cloud-opacity" unit="%" title="opacity, % (5–100)" step={5} min={5} max={100} value={Math.round((look.opacity ?? 1) * 100)} aria-label={`${entry.topic.name} opacity`} onChange={(percent: number | null) => setLook({ opacity: Math.min(100, Math.max(5, percent ?? 100)) / 100 })} />
                            </>
                        )
                        : (
                            <Select size="sm" className="cloud-color" value={look.gradient} aria-label={`${entry.topic.name} colormap`} options={GRADIENTS} onChange={(gradient) => setLook({ gradient })} />
                        )}
                    <Segmented size="sm" className="cloud-style" label={`${entry.topic.name} point shape`} items={[["voxel", "Voxels"], ["disc", "Spheres"]]} value={look.style === "disc" ? "disc" : "voxel"} onChange={(style) => setLook({ style: style as PointLook["style"] })} />
                    <Slider className="cloud-size" title="point size" min={0.01} max={0.5} step={0.01} value={look.size} aria-label={`${entry.topic.name} point size`} format={(size) => `${Math.round(size * 100)} cm`} onChange={(size) => setLook({ size })} />
                    {RowControls && <RowControls settings={entry.settings} topic={entry.topic} />}
                </div>
            )}
        </div>
    )
}
