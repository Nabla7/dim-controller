// Settings: driving (the wheeled base's controls, always; no format picker), grouped like a phone's settings
// (ui/SettingsGroup.tsx): speeds and the keyboard shortcuts, then folded "Advanced" groups. A panel's own settings are
// on its cog: the 3D view's (SceneSettings), a camera's (CameraSettings), the map's (MapPanel.tsx), a plot's.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { profiles } from "../profile/index.ts"
import { RobotIcon } from "./RobotIcon.tsx"
import { armShading } from "./armShading.ts"
import { Button, ColorSwatch, Disclosure, Field, Heading, NumberInput, Select, TextInput, Toggle } from "dimos-react"
import { useState } from "react"
import { GamepadModal } from "./GamepadModal.tsx"
import { gamepadSettings } from "../core/gamepad.ts"
import { JOY_HZ, JOY_TOPIC, JOY_TYPE, joySettings } from "../core/joy.ts"
import { maxLatencyOf } from "../core/linkWatch.ts"
import { DriveKeyboardFold, DrivePanel, DriveProfileFold } from "./DrivePanel.tsx"
import { SettingsFold, SettingsGroup, SettingsLink } from "./SettingsGroup.tsx"
import { LAYOUT_SUFFIX, pickLayoutFile, saveLayoutFile } from "../core/layoutFiles.ts"
import { rendering } from "../core/render/rendering.ts"
import { StylePicker } from "./StylePicker.tsx"
import { followFrameOptions } from "../core/map2d.ts"
import { useTfFrames } from "./useTfFrames.ts"
import { CamerasIn3dToggle } from "./ScenePanel.tsx"
import { CUBE_SHADES } from "dimos-react/three"
import type { CubeShade, PointStyle } from "../core/render/rendering.ts"
import { MESH_STYLES, type MeshStyle } from "../core/render/meshStyle.ts"
import { Stepper } from "./Stepper.tsx"

export function SettingsPanel({ app }: { app: ViewerApp }) {
    const robot = useStore(app.robot)
    return (
        <div className="settings-panel app-settings">
            {robot.type !== "arm" && (
                <>
                    <DrivePanel app={app} />
                    <h4 className="set-group-title set-advanced-title">Advanced</h4>
                    <DriveKeyboardFold app={app} />
                    <SettingsFold title="Gamepad" persistKey="lv.settings.advanced.gamepad">
                        <GamepadSettingsFields />
                        <RemapButton />
                    </SettingsFold>
                    <SettingsFold title="Joystick topic" persistKey="lv.settings.advanced.joy">
                        <JoySettingsFields />
                    </SettingsFold>
                    <SettingsFold title="Link safety" persistKey="lv.settings.advanced.link">
                        <Field inline className="set-row" label="Max latency" hint="Over this latency, or when the link drops, driving stops until you press Reconnect.">
                            <MaxLatencyInput app={app} />
                        </Field>
                    </SettingsFold>
                    <DriveProfileFold app={app} />
                </>
            )}
            <SettingsGroup title="Layout" data-layout-files="">
                <SettingsLink icon="download" label="Save layout" note={`panels, cameras and plots as a ${LAYOUT_SUFFIX} file`} onClick={() => saveLayoutFile()} />
                <SettingsLink icon="upload" label="Load layout…" note={`or drop a ${LAYOUT_SUFFIX} file anywhere`} onClick={pickLayoutFile} />
            </SettingsGroup>
        </div>
    )
}

/** The 3D view's cog: following, cameras in 3D, then how it draws (point style, cubes, meshes, the robot model, the view cube, stats). */
export function SceneSettings({ app }: { app: ViewerApp }) {
    const view = useStore(app.settings)
    const render = useStore(rendering)
    const frames = useTfFrames(app)
    return (
        <div className="settings-panel scene-settings">
            <Field inline label="Follow robot" title="the 3D camera tracks a TF frame; a pan stops it, the follow button resumes it"><Toggle value={view.follow} onChange={(follow: any) => app.settings.update({ follow })} /></Field>
            <FollowFramePicker app={app} frames={frames} />
            <Field inline label="Follow turns" title="following, the camera turns with the frame's heading (yaw only: the world stays level), like a third-person game; orbit and zoom stay an offset from it"><Toggle value={view.followTurns !== false} onChange={(followTurns: any) => app.settings.update({ followTurns })} /></Field>
            <Field inline label="Cameras in 3D" title="each camera's picture and frustum at its CameraInfo frame; an open camera panel's stream is shared, else a small one a few times a second"><CamerasIn3dToggle app={app} /></Field>
            <div className="field-block">
                <span className="field-label">Point style</span>
                <StylePicker value={render.pointStyle} onChange={(pointStyle: any) => rendering.update({ pointStyle: pointStyle as PointStyle })} />
                <p className="hint">The default for every point cloud; a layer can pick its own in its settings.</p>
            </div>
            <Field inline label="Cube shading" title={CUBE_SHADES[render.cubeShade]?.about}>
                <Select
                    data-cube-shade
                    aria-label="Cube shading"
                    value={render.cubeShade}
                    options={(Object.keys(CUBE_SHADES) as CubeShade[]).map((shade) => [shade, CUBE_SHADES[shade].label] as [string, string])}
                    onChange={(cubeShade: string) => rendering.update({ cubeShade: cubeShade as CubeShade })}
                />
            </Field>
            <Field inline label="Meshes" title="how the simulated world and the robot model draw: solid, or wireframe (each mesh's edges, its faces hidden)">
                <Select
                    data-testid="mesh-style"
                    aria-label="Meshes"
                    value={render.meshStyle}
                    options={MESH_STYLES}
                    onChange={(meshStyle: string) => rendering.update({ meshStyle: meshStyle as MeshStyle })}
                />
            </Field>
            {render.meshStyle === "wireframe" && (
                <Field inline label="Wireframe color"><ColorSwatch value={render.wireframeColor} onChange={(wireframeColor: string) => rendering.update({ wireframeColor })} /></Field>
            )}
            <Field inline label="Robot model" title="the robot's URDF when it publishes one, else a box at its pose (an arm is drawn by its TF frames)"><Toggle value={view.robotModel !== false} onChange={(robotModel: any) => app.settings.update({ robotModel })} /></Field>
            <Field inline label="View cube" title="a cube in the 3D view's top-right corner: click a face, edge or corner to look from there, drag it to orbit"><Toggle value={view.viewCube === true} onChange={(viewCube: any) => app.settings.update({ viewCube })} /></Field>
            <Field inline label="Stats"><Toggle value={view.showStats} onChange={(showStats: any) => app.settings.update({ showStats })} /></Field>
            <p className="hint">Drag to pan · Shift+drag or right-drag to orbit · scroll or pinch to zoom.</p>
        </div>
    )
}

/** A camera panel's cog: how long a hidden tab keeps its cameras. */
export function CameraSettings({ app }: { app: ViewerApp }) {
    const view = useStore(app.settings)
    return (
        <div className="settings-panel camera-settings">
            <Field inline label="Keep when hidden" title="a hidden tab (another tab, a minimized window) keeps its cameras subscribed this long, so coming back finds the picture still there; 0 drops them at once (saves bandwidth)">
                <Stepper label="Keep when hidden" min={0} max={300} step={15} value={view.cameraHiddenGraceS ?? 60} format={(seconds) => (seconds ? `${seconds} s` : "off")} onChange={(cameraHiddenGraceS) => app.settings.update({ cameraHiddenGraceS })} />
            </Field>
            <p className="hint">Latency vs quality, fit / fill and undistort are on the camera itself.</p>
        </div>
    )
}

/** Settings → Advanced → Gamepad: its dead zone (drift) and inverted forward / back */
function GamepadSettingsFields() {
    const settings = useStore(gamepadSettings)
    return (
        <>
            <Field inline className="set-row" label="Dead zone" title="how far a stick moves before it drives (raise it for a drifting stick)" data-testid="gamepad-settings">
                <Stepper label="Dead zone" value={settings.deadZone} min={0.05} max={0.4} step={0.01} onChange={(deadZone) => gamepadSettings.update({ deadZone })} format={(value) => `${Math.round(value * 100)}%`} />
            </Field>
            <Field inline className="set-row" label="Invert Y" title="up on the left stick backs up"><Toggle value={settings.invertY} onChange={(invertY: any) => gamepadSettings.update({ invertY })} /></Field>
        </>
    )
}

/** Settings → Advanced → Gamepad: the remapping (the same modal as the gamepad chip's). */
function RemapButton() {
    const [open, setOpen] = useState(false)
    return (
        <>
            <SettingsLink label="Remap buttons" icon="gamepad" note="Left stick drives, right stick turns, RB boosts, LT + RT stops (A to drive again)." onClick={() => setOpen(true)} />
            <GamepadModal open={open} onClose={() => setOpen(false)} />
        </>
    )
}

/** Settings → Advanced → Joystick topic: the raw input (pad, keys, thumb sticks) as sensor_msgs/Joy, on or off */
function JoySettingsFields() {
    const settings = useStore(joySettings)
    return (
        <>
            <Field inline className="set-row" label="Publish" hint={`The raw gamepad, drive keys and thumb sticks as ${JOY_TYPE.replace(".", "/")}, at most ${JOY_HZ}/s; nothing while idle. It drives nothing: it's for recordings.`} data-testid="joy-settings">
                <Toggle value={settings.enabled} onChange={(enabled: any) => joySettings.update({ enabled })} />
            </Field>
            <Field inline className="set-row" label="Topic">
                <TextInput mono size="sm" data-testid="joy-topic" aria-label="Joystick topic" placeholder={JOY_TOPIC} value={settings.topic ?? ""} onCommit={(topic) => joySettings.update({ topic: topic.trim() || undefined })} />
            </Field>
        </>
    )
}

/** Settings → Max latency: saved on Enter or leaving the field, so "1" on the way to "1500" never holds driving */
function MaxLatencyInput({ app }: { app: ViewerApp }) {
    const saved = maxLatencyOf(useStore(app.settings).maxLatencyMs)
    return (
        <NumberInput
            className="number"
            aria-label="Max latency (ms)"
            data-testid="max-latency"
            min={1}
            step={100}
            unit="ms"
            value={saved}
            onChange={(value) => app.settings.update({ maxLatencyMs: Math.round(value) })}
        />
    )
}

/** the TF frame the 3D camera follows: the robot's by default, or any frame in the tree (refreshed while shown) */
function FollowFramePicker({ app, frames }: { app: ViewerApp; frames: string[] }) {
    const view = useStore(app.settings)
    const base = app.robotFrame
    const others = followFrameOptions(frames, view.followFrame || base).filter(({ frame }) => frame !== base)
    return (
        <Field inline label="Follow frame" title="the 3D view's follow button follows this frame">
            <Select
                aria-label="Frame to follow"
                value={view.followFrame === base ? "" : view.followFrame}
                options={[["", `robot (${base})${frames.includes(base) ? "" : " (waiting)"}`], ...others.map(({ frame, waiting }) => [frame, `${frame}${waiting ? " (waiting)" : ""}`] as [string, string])]}
                onChange={(followFrame: string) => app.settings.update({ followFrame })}
            />
        </Field>
    )
}
