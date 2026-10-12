// Drive settings: which Twist topics (auto or a list), speeds, and the profile's extra controls.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Field, Slider } from "./controls.tsx"

export function DrivePanel({ app }: { app: ViewerApp }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const settings = useStore(drive.settings)
    const values = useStore(drive.controlValues)
    useStore(app.connection.status)
    const candidates = drive.candidates()
    const usesVertical = Object.values(app.profile.drive.keys).some((action) => "axis" in action && action.axis === "vertical")
    return (
        <div className="drive-panel">
            <Field
                label="Topics"
                hint="Auto: each running blueprint's cmd_vel entry point (one per module that takes velocity commands, never a mux's own output), else /cmd_vel and /tele_cmd_vel. One topic per line; add TwistStamped after a name for a stamped one."
            >
                <label className="dim-check">
                    <input
                        type="checkbox"
                        checked={!(settings.topics?.length)}
                        onChange={(event) => drive.settings.update({ topics: event.target.checked ? [] : drive.autoTopics().map((topic) => topic.topic) })}
                    />
                    <span className="box" />
                    <span>auto</span>
                </label>
                {settings.topics?.length
                    ? (
                        <textarea
                            className="dim-textarea"
                            data-testid="drive-topics"
                            key={settings.topics.join("\n")}
                            rows={Math.max(2, settings.topics.length + 1)}
                            defaultValue={settings.topics.join("\n")}
                            onBlur={(event) => drive.settings.update({ topics: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })}
                        />
                    )
                    : null}
                <div className="hint" data-testid="drive-topics-resolved">→ {state.topic || "nothing"}</div>
            </Field>
            {candidates.length > 0 && settings.topics?.length
                ? <p className="hint">Seen: {candidates.join(", ")}</p>
                : null}
            <Field label="Linear"><Slider min={0.05} max={3} step={0.05} value={settings.linear} format={(speed) => `${speed.toFixed(2)} m/s`} onChange={(linear) => drive.settings.update({ linear })} /></Field>
            <Field label="Angular"><Slider min={0.05} max={3} step={0.05} value={settings.angular} format={(speed) => `${speed.toFixed(2)} rad/s`} onChange={(angular) => drive.settings.update({ angular })} /></Field>
            {usesVertical && <Field label="Vertical"><Slider min={0.05} max={2} step={0.05} value={settings.vertical} format={(speed) => `${speed.toFixed(2)} m/s`} onChange={(vertical) => drive.settings.update({ vertical })} /></Field>}
            <p className="hint">
                Shift: ×{app.profile.drive.boost.linear} linear, ×{app.profile.drive.boost.angular} turning · Space: stop · <kbd>?</kbd> lists every key
            </p>
            {app.profile.controls.length > 0 && (
                <section className="controls">
                    <h3 className="dim-label">{app.profile.name}</h3>
                    {app.profile.controls.map((control) =>
                        control.kind === "slider"
                            ? (
                                <Field key={control.id} label={control.label} hint={`${control.type} on ${control.topic}`}>
                                    <Slider min={control.min} max={control.max} step={control.step} value={values[control.id] ?? control.initial} format={(value) => `${value.toFixed(2)}${control.unit ? ` ${control.unit}` : ""}`} onChange={(value) => drive.setControl(control.id, value)} />
                                </Field>
                            )
                            : <button key={control.id} type="button" className="dim-btn sm" onClick={() => drive.pressButton(control.id)}>{control.label}</button>
                    )}
                </section>
            )}
            <div className="twist-readout">
                <span>lin {state.twist.linear.map((value) => value.toFixed(2)).join(" ")}</span>
                <span>ang {state.twist.angular.map((value) => value.toFixed(2)).join(" ")}</span>
                <span>{state.publishing ? `sending · ${state.sent}` : "idle"}</span>
            </div>
            {state.error && <p className="problem">{state.error}</p>}
        </div>
    )
}
