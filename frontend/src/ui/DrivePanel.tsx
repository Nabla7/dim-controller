// Drive settings: which Twist topics (auto or a list), speeds, and the profile's extra controls.
import { Alert, Button, Checkbox, Field, Heading, Row, Slider, Text, TextArea } from "dimos-react"
import { useEffect, useState } from "react"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"

export function DrivePanel({ app }: { app: ControllerApp }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const settings = useStore(drive.settings)
    const values = useStore(drive.controlValues)
    useStore(app.connection.status)
    const candidates = drive.candidates()
    const usesVertical = Object.values(app.profile.drive.keys).some((action) => "axis" in action && action.axis === "vertical")
    const keyNames = Object.entries(app.profile.drive.keys)
        .filter(([code]) => !code.startsWith("Arrow"))
        .map(([code, action]) => `${code.replace(/^Key/, "")} ${"axis" in action ? `${action.axis} ${action.value > 0 ? "+" : "−"}` : `${action.control} ${(action.step ?? 0) > 0 ? "+" : "−"}`}`)
    const listed = settings.topics?.length ? settings.topics.join("\n") : ""
    const [text, setText] = useState(listed)
    useEffect(() => setText(listed), [listed])
    return (
        <div className="drive-panel">
            <Field
                label="Topics"
                hint="Auto: each running blueprint's cmd_vel entry point (one per module that takes velocity commands, never a mux's own output), else /cmd_vel and /tele_cmd_vel. One topic per line; add TwistStamped after a name for a stamped one."
            >
                <Checkbox
                    label="auto"
                    value={!settings.topics?.length}
                    onChange={(auto: boolean) => drive.settings.update({ topics: auto ? [] : drive.autoTopics().map((topic) => topic.topic) })}
                />
                {settings.topics?.length
                    ? (
                        <TextArea
                            mono
                            data-testid="drive-topics"
                            rows={Math.max(2, settings.topics.length + 1)}
                            value={text}
                            onChange={setText}
                            onBlur={() => drive.settings.update({ topics: text.split("\n").map((line) => line.trim()).filter(Boolean) })}
                        />
                    )
                    : null}
                <Text small muted data-testid="drive-topics-resolved">→ {state.topic || "nothing"}</Text>
            </Field>
            {candidates.length > 0 && settings.topics?.length ? <Text as="p" small muted>Seen: {candidates.join(", ")}</Text> : null}
            <Field label="Linear"><Slider min={0.05} max={3} step={0.05} value={settings.linear} format={(speed: number) => `${speed.toFixed(2)} m/s`} onChange={(linear: number) => drive.settings.update({ linear })} /></Field>
            <Field label="Angular"><Slider min={0.05} max={3} step={0.05} value={settings.angular} format={(speed: number) => `${speed.toFixed(2)} rad/s`} onChange={(angular: number) => drive.settings.update({ angular })} /></Field>
            {usesVertical && <Field label="Vertical"><Slider min={0.05} max={2} step={0.05} value={settings.vertical} format={(speed: number) => `${speed.toFixed(2)} m/s`} onChange={(vertical: number) => drive.settings.update({ vertical })} /></Field>}
            <Text as="p" small muted>
                Shift: ×{app.profile.drive.boost.linear} linear, ×{app.profile.drive.boost.angular} turning · Space: stop · {keyNames.join(" · ")}
            </Text>
            {app.profile.controls.length > 0 && (
                <section className="controls">
                    <Heading level={3}>{app.profile.name}</Heading>
                    {app.profile.controls.map((control) =>
                        control.kind === "slider"
                            ? (
                                <Field key={control.id} label={control.label} hint={`${control.type} on ${control.topic}`}>
                                    <Slider min={control.min} max={control.max} step={control.step} value={values[control.id] ?? control.initial} format={(value: number) => `${value.toFixed(2)}${control.unit ? ` ${control.unit}` : ""}`} onChange={(value: number) => drive.setControl(control.id, value)} />
                                </Field>
                            )
                            : <Button key={control.id} size="sm" onClick={() => drive.pressButton(control.id)}>{control.label}</Button>
                    )}
                </section>
            )}
            <Row gap={10} wrap>
                <Text small mono>lin {state.twist.linear.map((value) => value.toFixed(2)).join(" ")}</Text>
                <Text small mono>ang {state.twist.angular.map((value) => value.toFixed(2)).join(" ")}</Text>
                <Text small mono muted>{state.publishing ? `sending · ${state.sent}` : "idle"}</Text>
            </Row>
            {state.error && <Alert tone="danger">{state.error}</Alert>}
        </div>
    )
}
