// Settings: the controller format (the robot type: how it's driven, not what it is), then driving (or the arm panel, for an arm; it was its own tab), the map's choices (the same
// setting as the map's cog), the 3D view's follow frame (the same as its follow button follows), then rendering.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { profiles } from "../profile/index.ts"
import { RobotIcon } from "./RobotIcon.tsx"
import { armShading } from "./armShading.ts"
import { ArmPanel } from "./ArmPanel.tsx"
import { ManipPanel } from "./ManipPanel.tsx"
import { plannerRunning } from "../core/runs.ts"
import { Field, Heading, NumberInput, Segmented, Select, Slider, Toggle } from "dimos-react"
import { gamepadSettings } from "../core/gamepad.ts"
import { JOY_HZ, JOY_TOPIC, JOY_TYPE, joySettings } from "../core/joy.ts"
import { maxLatencyOf } from "../core/linkWatch.ts"
import { DrivePanel } from "./DrivePanel.tsx"
import { rendering } from "../core/render/rendering.ts"
import { StylePicker } from "./StylePicker.tsx"
import { followFrameOptions } from "../core/map2d.ts"
import { useTfFrames } from "./useTfFrames.ts"
import { MapChoiceFields } from "./MapPanel.tsx"
import { CamerasIn3dToggle } from "./ScenePanel.tsx"
import { CUBE_SHADES } from "dimos-react/three"
import type { CubeShade, PointStyle } from "../core/render/rendering.ts"

export function SettingsPanel({ app }: { app: ViewerApp }) {
    const view = useStore(app.settings)
    const render = useStore(rendering)
    const robot = useStore(app.robot)
    const runs = useStore(app.runs.state)
    const manipulation = useStore(app.manipulation.state)
    const planner = plannerRunning(runs) || manipulation.available === true
    const current = profiles.find((profile) => profile.type === robot.type)
    // the TF frames to offer for following (the map's and the 3D view's), refreshed while shown
    const frames = useTfFrames(app)
    return (
        <div className="settings-panel">
            <div className="field-block robot-type" data-testid="robot-type">
                <span className="field-label">Controller format</span>
                <div className="robot-type-row">
                    <RobotIcon type={robot.type} size={40} />
                    <Select
                        aria-label="Controller format"
                        value={robot.auto ? "" : robot.type}
                        options={[["", `Auto: ${current?.name ?? robot.type}`], ...profiles.map((profile) => [profile.type, profile.name] as [string, string])]}
                        // every open viewer switches with it (app.ts), no reload
                        onChange={(profile: string) => (app.settings.update({ profile }), profile === "arm" && armShading())}
                    />
                </div>
                <p className="hint" data-testid="robot-type-reason">
                    {robot.auto ? `Auto: picked from the blueprint (${robot.reason}).` : "Picked here; Auto picks from the blueprint."} How you control it: the keys, speeds, the drive or arm controls and the model in the view. Choose any format, e.g. Dog for an RC car.
                </p>
            </div>
            {robot.type === "arm"
                ? (
                    <>
                        <section className="settings-section" data-section="manipulation">
                            <Heading level={3}>Plan and move</Heading>
                            <ManipPanel app={app} />
                        </section>
                        <section className="settings-section" data-section="arm">
                            <Heading level={3}>Arm</Heading>
                            <ArmPanel app={app} />
                        </section>
                    </>
                )
                : (
                    <>
                    {planner && (
                        <section className="settings-section" data-section="manipulation">
                            <Heading level={3}>Plan and move (arms)</Heading>
                            <ManipPanel app={app} />
                        </section>
                    )}
                    <section className="settings-section" data-section="drive">
                        <Heading level={3}>Drive</Heading>
                        <DrivePanel app={app} />
                        <Field inline label="Max latency (ms)" title="Over this (or when the link drops), driving disengages until you press Reconnect.">
                            <MaxLatencyInput app={app} />
                        </Field>
                        <GamepadSettingsFields />
                        <JoySettingsFields />
                    </section>
                    </>
                )}
            <section className="settings-section" data-section="map">
                <Heading level={3}>Map</Heading>
                <div className="map-settings-fields">
                    <MapChoiceFields app={app} frames={frames} />
                </div>
            </section>
            <section className="settings-section" data-section="scene">
                <Heading level={3}>3D view</Heading>
                <Field inline label="Follow robot" title="the 3D camera tracks a TF frame; a pan stops it, the follow button resumes it"><Toggle value={view.follow} onChange={(follow: any) => app.settings.update({ follow })} /></Field>
                <FollowFramePicker app={app} frames={frames} />
                <Field inline label="Cameras in 3D" title="each camera's picture and frustum at its CameraInfo frame; an open camera panel's stream is shared, else a small one a few times a second"><CamerasIn3dToggle app={app} /></Field>
            </section>
            <Heading level={3}>Rendering</Heading>
            <div className="field-block">
                <span className="field-label">Point style</span>
                <StylePicker value={render.pointStyle} onChange={(pointStyle: any) => rendering.update({ pointStyle: pointStyle as PointStyle })} />
                <p className="hint">The default for every point cloud; a layer can pick its own in its settings.</p>
            </div>
            <Field inline label="Cube shading" title={CUBE_SHADES[render.cubeShade]?.about}>
                <Segmented
                    data-cube-shade
                    size="sm"
                    value={render.cubeShade}
                    items={(Object.keys(CUBE_SHADES) as CubeShade[]).map((shade) => ({ value: shade, label: CUBE_SHADES[shade].label }))}
                    onChange={(cubeShade: CubeShade) => rendering.update({ cubeShade })}
                />
            </Field>
            <Field inline label="Robot model" title="a stand-in for the robot type at the robot's pose (an arm is drawn by its TF frames)"><Toggle value={view.robotModel !== false} onChange={(robotModel: any) => app.settings.update({ robotModel })} /></Field>
            <Field inline label="View cube" title="a cube in the 3D view's top-right corner: click a face, edge or corner to look from there, drag it to orbit"><Toggle value={view.viewCube === true} onChange={(viewCube: any) => app.settings.update({ viewCube })} /></Field>
            <Field inline label="Stats"><Toggle value={view.showStats} onChange={(showStats: any) => app.settings.update({ showStats })} /></Field>
            <p className="hint">Drag to orbit · right-drag or two fingers to pan · scroll or pinch to zoom. Follow is on the 3D view and in the dock. The panel arrangement: drag headers, or the palette's "Reset the layout".</p>
        </div>
    )
}

/** Settings → Drive → Gamepad: its dead zone (drift) and inverted forward / back */
function GamepadSettingsFields() {
    const settings = useStore(gamepadSettings)
    return (
        <div className="field-block gamepad-settings" data-testid="gamepad-settings">
            <span className="field-label">Gamepad</span>
            <Field inline label="Dead zone" title="how far a stick moves before it drives (raise it for a drifting stick)">
                <Slider value={settings.deadZone} min={0.05} max={0.4} step={0.01} onChange={(deadZone: any) => gamepadSettings.update({ deadZone })} format={(value) => `${Math.round(value * 100)}%`} />
            </Field>
            <Field inline label="Invert Y" title="up on the left stick backs up"><Toggle value={settings.invertY} onChange={(invertY: any) => gamepadSettings.update({ invertY })} /></Field>
            <p className="hint">Left stick drives, right stick turns, RB boosts, LT + RT stops (A to drive again). The full list is under ?.</p>
        </div>
    )
}

/** Settings → Drive → Joy: the raw input (pad, keys, thumb sticks) as sensor_msgs/Joy, on or off */
function JoySettingsFields() {
    const settings = useStore(joySettings)
    return (
        <div className="field-block joy-settings" data-testid="joy-settings">
            <Field inline label="Publish Joy" title="the raw gamepad, drive keys and thumb sticks as sensor_msgs/Joy (drives nothing; for recordings and Joy readers)">
                <Toggle value={settings.enabled} onChange={(enabled: any) => joySettings.update({ enabled })} />
            </Field>
            <p className="hint" data-testid="joy-topic">
                Topic <code>{JOY_TOPIC}</code> ({JOY_TYPE.replace(".", "/")}), on each change, at most {JOY_HZ}/s; nothing while idle.
            </p>
        </div>
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
            value={saved}
            onChange={(value) => app.settings.update({ maxLatencyMs: Math.round(value) })}
        />
    )
}

/** the TF frame the 3D camera follows: the robot's by default, or any frame in the tree (refreshed while shown) */
function FollowFramePicker({ app, frames }: { app: ViewerApp; frames: string[] }) {
    const view = useStore(app.settings)
    const base = app.profile.baseFrame
    const others = followFrameOptions(frames, view.followFrame || base).filter(({ frame }) => frame !== base)
    return (
        <Field inline label="Follow frame" title="the 3D view's follow button follows this frame">
            <Select
                aria-label="Frame to follow"
                value={view.followFrame === app.profile.baseFrame ? "" : view.followFrame}
                options={[["", `robot (${base})${frames.includes(base) ? "" : " (waiting)"}`], ...others.map(({ frame, waiting }) => [frame, `${frame}${waiting ? " (waiting)" : ""}`] as [string, string])]}
                onChange={(followFrame: string) => app.settings.update({ followFrame })}
            />
        </Field>
    )
}
