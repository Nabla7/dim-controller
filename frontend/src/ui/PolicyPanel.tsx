import { useState } from "react"
import { Button, Field, Select, Slider, Toggle } from "dimos-react"
import type { ViewerApp } from "../core/app.ts"
import { actionAllowed, driveBlock, HEIGHT_RANGE, modeLabel, modeName, type PolicyCommand, type PolicyState } from "../core/policyControl.ts"
import { useStore } from "../core/store.ts"
import { Icon } from "./icons.tsx"

export function PolicyPanel({ app }: { app: ViewerApp }) {
    const state = useStore(app.policy.state)
    const status = state.status
    return <div className="sonic-controls" data-testid="sonic-controls">
        <strong>{state.stale ? "State unavailable" : status?.fault_reason ? "Damping stop latched" : status?.control_state ?? "Waiting"}</strong>
        {status && <span>{status.simulation ? "Simulation" : "Hardware"} · {status.fault_reason ? "Damping" : status.dry_run ? "Pose held" : "Live"} · {status.reference_source}</span>}
        <div className="sonic-actions">
            <Button disabled={!actionAllowed(state, "activate")} onClick={() => app.policy.act("activate")} title="Ramp from the measured pose into live balancing"><Icon name="play" />Activate</Button>
            <Button disabled={!actionAllowed(state, "stop-motion")} onClick={() => app.policy.act("stop-motion")} title="Cancel navigation and operator motion; keep balancing"><Icon name="stop" />Stop motion</Button>
            <Button disabled={!actionAllowed(state, "deactivate")} onClick={() => {
                if (confirm("Stop balancing and hold the measured pose? The G1 must be supported.")) void app.policy.act("deactivate")
            }} title="Stops balancing; support the robot first"><Icon name="pause" />Deactivate</Button>
            <Button className="sonic-damping" disabled={!actionAllowed(state, "damping-stop")} onClick={() => app.policy.act("damping-stop")} title="Latched software damping; not a power disconnect"><Icon name="stop" />Damping stop</Button>
        </div>
        {status && <dl className="sonic-status">
            <dt>Current gait</dt><dd>{modeName(state, status.mode)}</dd>
            <dt>Selected gait</dt><dd>{modeName(state, status.mode_queue?.at(-1) ?? status.mode_override)}</dd>
            {!!status.mode_queue?.length && <><dt>Transition</dt><dd>{[status.mode_override, ...status.mode_queue].map((mode) => modeName(state, mode)).join(" > ")}</dd></>}
            {status.stream_active && <><dt>Clip frame</dt><dd>{status.stream_frame ?? 0} / {status.stream_frames ?? 0}</dd></>}
            {status.webxr && <><dt>WebXR</dt><dd>{status.webxr.mode}{status.webxr.reason ? `: ${status.webxr.reason}` : ""}</dd></>}
        </dl>}
        <PolicySettings key={`${state.target?.run}/${state.target?.policy}`} app={app} state={state} />
        {state.pending && <span role="status">{state.pending} pending</span>}
        {state.notice && <span role="status">{state.notice}</span>}
        {driveBlock(state) && <span className="hint">{driveBlock(state)}</span>}
        {state.optionsError && <span className="problem" role="alert">Policy options unavailable: {state.optionsError}</span>}
        {state.error && <span className="problem" role="alert">{state.error}</span>}
    </div>
}

function PolicySettings({ app, state }: { app: ViewerApp; state: PolicyState }) {
    const [mode, setMode] = useState("")
    const [clip, setClip] = useState("")
    const [defaultHeight, setDefaultHeight] = useState(true)
    const [height, setHeight] = useState(0.4)
    const options = state.options
    if (!options) return null
    const apply = (command: PolicyCommand) => {
        if (state.status?.simulation || confirm("This changes the real G1's motion. These postures and clips are not hardware-validated. Continue?")) void app.policy.act(command)
    }
    return <div className="sonic-settings">
        {Object.keys(options.modes).length > 0 && <Field label="Locomotion">
            <div className="sonic-setting-row">
                <Select aria-label="SONIC locomotion mode" value={mode} disabled={!actionAllowed(state, "mode")}
                    options={[["", "Choose gait or posture"], ...Object.entries(options.modes).sort((a, b) => a[1] - b[1]).map(([name]) => [name, modeLabel(name)] as [string, string])]}
                    onChange={setMode} />
                <Button disabled={!mode || !actionAllowed(state, "mode")} onClick={() => apply({ action: "mode", mode })} title="Apply the selected gait or posture"><Icon name="check" />Apply</Button>
            </div>
        </Field>}
        {options.height && <Field label="Pelvis height request">
            <Toggle label="Mode default" value={defaultHeight} onChange={setDefaultHeight} disabled={!actionAllowed(state, "height")} />
            <div className="sonic-setting-row">
                {!defaultHeight && <Slider aria-label="Requested pelvis height" {...HEIGHT_RANGE} value={height}
                    disabled={!actionAllowed(state, "height")} format={(value) => `${value.toFixed(2)} m`} onChange={setHeight} />}
                <Button disabled={!actionAllowed(state, "height")} onClick={() => apply({ action: "height", height: defaultHeight ? null : height })} title="Set the planner's height request, not a measured height"><Icon name="check" />Apply height</Button>
            </div>
        </Field>}
        <Field label="Motion clip">
            <div className="sonic-setting-row">
                <Select aria-label="SONIC motion clip" value={clip} disabled={!actionAllowed(state, "clip")}
                    options={[["", options.clips.length ? "Choose installed motion" : "No motions installed"], ...options.clips.map((name) => [name, name] as [string, string])]}
                    onChange={setClip} />
                <Button disabled={!clip || !actionAllowed(state, "clip")} onClick={() => apply({ action: "clip", name: clip })} title="Play the selected motion reference"><Icon name="play" />Play</Button>
            </div>
        </Field>
        {state.status?.reference_source !== "planner" && <Button disabled={!actionAllowed(state, "stop-motion")} onClick={() => app.policy.act("stop-motion")} title="Clear the motion reference and return to stationary locomotion"><Icon name="stop" />Return to locomotion</Button>}
    </div>
}
