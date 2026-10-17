// The 3D view (lidar, maps, TF, the robot model) as a workspace panel (ui/Panel.tsx). Its tools: points and bytes a
// second and its menu: cameras in 3D (the same setting as Settings → 3D view), then each PointCloud2 on the bus (on/off,
// this viewer's bandwidth preset, color and size), then every other layer (TF, maps, markers…: ui/LayersPanel.tsx).
// Collapsed (or off screen: a shut drawer, a rail hidden by focus) every 3D layer stops: nothing subscribed, no
// bandwidth; expanded, they subscribe again. Follow sits over its corner, and in the dock while it's the main view.
// View-only: nothing here moves the robot. The element the viewer draws into (`host`) is never remounted, wherever the
// panel goes.
import { type RefObject, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ViewerApp } from "../core/app.ts"
import type { LayerEntry } from "../core/layers/manager.ts"
import { type Store, useStore } from "../core/store.ts"
import { CLOUD_PRESETS, cloudQualities, cloudQualityOf, type CloudQuality, type CloudRate, cloudRates, formatBytes, formatCount, setCloudQuality } from "../core/cloudQuality.ts"
import { GRADIENTS, ViewCube } from "dimos-react/three"
import type { PointLook } from "../core/render/rendering.ts"
import type { CloudSettings } from "../layers/pointcloud.tsx"
import { Icon } from "./icons.tsx"
import { Button, Card, Select, Slider, Toggle } from "dimos-react"
import { popoverPosition } from "./panelDrag.ts"
import { Panel } from "./Panel.tsx"
import { ViewControls } from "./ViewControls.tsx"
import { TfFootnote } from "./TfFootnote.tsx"
import { panelTitle } from "./commands.ts"
import { useWorkspaceApi } from "./Workspace.tsx"
import { useDockActions } from "./dockActions.ts"
import { Unavailable } from "./Unavailable.tsx"
import { LayerList } from "./LayersPanel.tsx"
import { ManipActions } from "./ManipPanel.tsx"

const COLOR_MODES: [PointLook["colorMode"], string][] = [["height", "by height"], ["intensity", "by intensity"], ["range", "by distance"], ["solid", "solid"]]

const isCloud = (entry: LayerEntry) => entry.topic.type === "sensor_msgs.PointCloud2"

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
            info={slot?.collapsed ? "collapsed · nothing subscribed" : app ? <SceneRate /> : undefined}
            tools={app && !off && (
                <div className="scene-tools">
                    <CloudButton app={app} open={menuOpen} onOpen={setMenuOpen} buttonRef={cloudButton} />
                </div>
            )}
        >
            <div ref={host} className="scene" />
            {app?.viewer.webglError && !off && <Unavailable what="3D view" reason={app.viewer.webglError} />}
            {app && !off && !app.viewer.webglError && <SceneViewCube app={app} host={host} />}
            {app && !off && <ViewControls app={app} />}
            {app && !off && <ManipulatingNote app={app} />}
            {app && !off && <TfFootnote app={app} onOpen={onTf} />}
            {app && menuOpen && !off && <CloudMenu app={app} anchor={cloudButton.current} onClose={() => setMenuOpen(false)} />}
        </Panel>
        </>
    )
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

/** While the view orbits a grabbed arm gizmo: Done (or Esc) gives the view back its usual center. In focus mode, with a
 * target: the arm panel's Preview / Execute / Clear too. */
function ManipulatingNote({ app }: { app: ViewerApp }) {
    const { focused } = useStore(app.manipulation.gizmo)
    const { target } = useStore(app.manipulation.state)
    const api = useWorkspaceApi()
    // focus mode hides the arm panel: its actions come here while there's a target to move to
    const focusMode = !api.mobile && api.view.hide.length === 2
    useEffect(() => {
        if (!focused) {
            return
        }
        const escape = (event: KeyboardEvent) => event.key === "Escape" && app.manipulation.doneManipulating()
        addEventListener("keydown", escape)
        return () => removeEventListener("keydown", escape)
    }, [app, focused])
    if (!focused && !(focusMode && target)) {
        return null
    }
    return (
        <div className="manipulating-note" data-testid="manipulating-note">
            {focusMode && target && <ManipActions app={app} testid="scene-manip" />}
            {focused && <span>Orbiting {focused}'s gizmo</span>}
            {focused && <Button size="sm" onClick={() => app.manipulation.doneManipulating()} title="the view orbits what it did before (Esc)">Done manipulating</Button>}
        </div>
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

function SceneRate() {
    const total = totalRate(useStore(cloudRates))
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
    const clouds = list.filter(isCloud)
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
            <CamerasIn3dRow app={app} />
            <div className="quality-title">Point clouds</div>
            {!clouds.length && <p className="cloud-empty">No PointCloud2 on the bus yet.</p>}
            {clouds.map((entry) => <CloudRow key={entry.topic.key} app={app} entry={entry} rate={rates[entry.topic.key]} />)}
            <LayerList app={app} skip={isCloud} />
        </Card>,
        document.body,
    )
}

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
                    {look.colorMode === "solid"
                        ? <input type="color" className="cloud-solid" value={look.solid} aria-label={`${entry.topic.name} solid color`} onChange={(event) => setLook({ solid: event.target.value })} />
                        : (
                            <Select size="sm" className="cloud-color" value={look.gradient} aria-label={`${entry.topic.name} colormap`} options={GRADIENTS} onChange={(gradient) => setLook({ gradient })} />
                        )}
                    <Slider className="cloud-size" title="point size" min={0.01} max={0.5} step={0.01} value={look.size} aria-label={`${entry.topic.name} point size`} format={(size) => `${Math.round(size * 100)} cm`} onChange={(size) => setLook({ size })} />
                </div>
            )}
        </div>
    )
}
