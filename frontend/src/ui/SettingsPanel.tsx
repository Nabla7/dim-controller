// Settings: the layout, the robot type, then driving (or the arm panel, for an arm), then the view.
import { Field, Heading, NumberInput, Row, Segmented, Select, Text, Toggle } from "dimos-react"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"
import { profiles } from "../profile/index.ts"
import { RobotIcon } from "./RobotIcon.tsx"
import { armShading } from "./armShading.ts"
import { ArmPanel } from "./ArmPanel.tsx"
import { maxLatencyOf } from "../logic/linkWatch.ts"
import { DrivePanel } from "./DrivePanel.tsx"
import { RenderingSettings, useTfFrames } from "dimos-react/three"
import { followFrameOptions } from "../logic/mapTopics.ts"
import { LAYOUTS, setLayoutMode, useLayout } from "../logic/layout.ts"

export function SettingsPanel({ app }: { app: ControllerApp }) {
    const view = useStore(app.settings)
    const robot = useStore(app.robot)
    const current = profiles.find((profile) => profile.type === robot.type)
    return (
        <div className="settings-panel">
            <LayoutPicker />
            <Field
                label="Robot"
                data-testid="robot-type"
                hint={
                    <>
                        <span data-testid="robot-type-reason">{robot.auto ? `Auto: ${robot.reason}.` : "Picked here; Auto follows what's running."} Sets the keys, speeds, the drive or arm controls and the model in the view.</span>{" "}
                        <span data-testid="robot-icon-credits">Icons after Izwar Muis's "Humanoid robot" and "robot dog" and rukanicon's "Robotics" (Noun Project, CC BY 3.0, modified) and Tabler's drone (MIT); see the README's Credits.</span>
                    </>
                }
            >
                <Row gap={10}>
                    <RobotIcon type={robot.type} size={40} />
                    <Select
                        aria-label="Robot type"
                        value={robot.auto ? "" : robot.type}
                        options={[["", `Auto: ${current?.name ?? robot.type}`], ...profiles.map((profile) => [profile.type, profile.name])]}
                        // every open viewer switches with it, no reload
                        onChange={(profile: string) => {
                            app.settings.update({ profile })
                            if (profile === "arm") {
                                armShading()
                            }
                        }}
                    />
                </Row>
            </Field>
            {robot.type === "arm"
                ? (
                    <section className="settings-section" data-section="arm">
                        <Heading level={3}>Arm</Heading>
                        <ArmPanel app={app} />
                    </section>
                )
                : (
                    <section className="settings-section" data-section="drive">
                        <Heading level={3}>Drive</Heading>
                        <DrivePanel app={app} />
                        <Field label="Max latency (ms)" hint="Over this, the drive panel stops driving and shows Reconnect (also when the link drops).">
                            <NumberInput aria-label="Max latency (ms)" data-testid="max-latency" min={1} step={100} value={maxLatencyOf(view.maxLatencyMs)} onChange={(value: number) => value > 0 && app.settings.update({ maxLatencyMs: Math.round(value) })} />
                        </Field>
                    </section>
                )}
            <Heading level={3}>Rendering</Heading>
            <RenderingSettings />
            <Field label="Follow robot" inline hint="the 3D camera tracks a TF frame; a pan stops it, the follow button (top right) resumes it">
                <Toggle value={view.follow} onChange={(follow: boolean) => app.settings.update({ follow })} />
            </Field>
            <FollowFramePicker app={app} />
            <Field label="Robot model" inline hint="a stand-in for the robot type at the robot's pose (an arm is drawn by its TF frames)">
                <Toggle value={view.robotModel !== false} onChange={(robotModel: boolean) => app.settings.update({ robotModel })} />
            </Field>
            <Field label="Stats" inline><Toggle value={view.showStats} onChange={(showStats: boolean) => app.settings.update({ showStats })} /></Field>
            <Text as="p" small muted>Drag to orbit · right-drag or two fingers to pan · scroll or pinch to zoom. Follow and top-down are on the view (top right).</Text>
        </div>
    )
}

/** the TF frame the 3D camera follows: the robot's by default, or any frame in the tree (refreshed while shown) */
function FollowFramePicker({ app }: { app: ControllerApp }) {
    const view = useStore(app.settings)
    const frames: string[] = useTfFrames({ tf: app.tf })
    const base = app.profile.baseFrame
    const others = followFrameOptions(frames, view.followFrame || base).filter(({ frame }) => frame !== base)
    return (
        <Field label="Follow frame">
            <Select
                aria-label="Frame to follow"
                value={view.followFrame === base ? "" : view.followFrame}
                options={[["", `robot (${base})${frames.includes(base) ? "" : " (waiting)"}`], ...others.map(({ frame, waiting }) => [frame, `${frame}${waiting ? " (waiting)" : ""}`])]}
                onChange={(followFrame: string) => app.settings.update({ followFrame })}
            />
        </Field>
    )
}

/** Settings → Layout: Classic or one of the docked arrangements (logic/layout.ts); every open page follows */
function LayoutPicker() {
    const { mode } = useLayout()
    const current = LAYOUTS.find((layout) => layout.id === mode)!
    return (
        <Field label="Layout" data-testid="layout-picker" hint={<span data-testid="layout-about">{current.about}</span>}>
            <Segmented label="Layout" value={mode} onChange={setLayoutMode} items={LAYOUTS.map((layout) => ({ value: layout.id, label: layout.label, title: layout.about }))} />
        </Field>
    )
}
