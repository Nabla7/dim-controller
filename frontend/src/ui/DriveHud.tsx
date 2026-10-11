// Driving on screen (no arming: keys and sticks always drive). Desktop: the profile's keys lighting up as they're held,
// in the bottom-left corner. Phone: two thumbs, a left stick that translates (forward/back, plus strafe for profiles
// that strafe) and a right stick that turns (plus up/down for profiles with a vertical axis), STOP and boost. Both show
// the agent's commands (POST api/drive), dry runs included.
import { Alert, Badge, Button, KeyCap, KeyPad, Panel, releaseAllThumbSticks, Text, ThumbStick } from "dimos-react"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"
import type { Axis } from "../profile/types.ts"
import type { DriveHalt } from "../logic/drive.ts"

/** Driving is held (latency over the max, or the link lost): why, and the Reconnect button. */
function HaltNotice({ app, halt }: { app: ControllerApp; halt: DriveHalt }) {
    const why = halt.reason === "lost" ? "Link lost" : `Latency over ${halt.maxMs} ms${halt.latencyMs !== null ? ` (${halt.latencyMs} ms)` : ""}`
    return (
        <Alert
            tone="danger"
            data-testid="drive-halt"
            actions={<Button size="sm" data-testid="reconnect-button" loading={halt.reconnecting} onClick={() => app.reconnect()}>{halt.reconnecting ? "Reconnecting…" : "Reconnect"}</Button>}
        >
            {why} · driving stopped
        </Alert>
    )
}

export function DriveHud({ app, mobile }: { app: ControllerApp; mobile: boolean }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const keys = app.profile.drive.keys
    const usesVertical = Object.values(keys).some((action) => "axis" in action && action.axis === "vertical")
    const usesStrafe = Object.values(keys).some((action) => "axis" in action && action.axis === "strafe")
    const keyFor = (axis: Axis, sign: number) => Object.entries(keys).find(([code, action]) => !code.startsWith("Arrow") && "axis" in action && action.axis === axis && Math.sign(action.value) === sign)?.[0].replace(/^Key/, "")
    const command = state.command
    const velocity = (linear: number[], angular: number[]) => `${linear[0].toFixed(2)}${usesStrafe ? ` / ${linear[1].toFixed(2)}` : ""}${usesVertical ? ` / ${linear[2].toFixed(2)}` : ""} m/s · ${angular[2].toFixed(2)} rad/s`
    const lit = (axis: Axis, sign: number) => Math.sign(state.axes[axis]) === sign && state.axes[axis] !== 0

    if (mobile) {
        const moving = state.publishing && [...state.twist.linear, ...state.twist.angular].some((value) => value !== 0)
        const stop = () => {
            releaseAllThumbSticks()
            drive.stop()
        }
        return (
            <div className={`drive-hud-mobile ${moving ? "moving" : ""}`} data-testid="drive-hud-mobile">
                <ThumbStick
                    className="stick-left"
                    data-testid="stick-left"
                    label={usesStrafe ? "move" : "forward / back"}
                    axes={usesStrafe ? "xy" : "y"}
                    onMove={(x: number, y: number) => drive.setAxes("left-stick", { forward: y, strafe: usesStrafe ? -x : 0 })}
                />
                <div className="hud-center">
                    {state.halt && <HaltNotice app={app} halt={state.halt} />}
                    <Badge data-testid="drive-readout">
                        {command ? `${command.dryRun ? "dry run" : command.source} · ${velocity(command.linear, command.angular)}` : velocity(state.twist.linear, state.twist.angular)}
                    </Badge>
                    {/* on touch, not on the click after it: no 300 ms, and it works while a thumb holds a stick */}
                    <Button variant="danger" size="lg" className="stop-button" data-testid="stop-button" onPointerDown={stop} onClick={stop}>STOP</Button>
                    <Button size="sm" pressed={state.boost} onClick={() => drive.setBoost(!state.boost)}>{state.boost ? "FAST ON" : "FAST"}</Button>
                </div>
                <ThumbStick
                    className="stick-right"
                    data-testid="stick-right"
                    label={usesVertical ? "turn · up / down" : "turn"}
                    axes={usesVertical ? "xy" : "x"}
                    onMove={(x: number, y: number) => drive.setAxes("right-stick", { turn: -x, vertical: usesVertical ? y : 0 })}
                />
            </div>
        )
    }

    const cell = (axis: Axis, sign: number) => {
        const key = keyFor(axis, sign)
        return key ? { label: key, down: lit(axis, sign) } : null
    }
    const side = (sign: number) => usesStrafe ? cell("strafe", sign) : usesVertical ? cell("vertical", -sign) : null
    return (
        <Panel glass className={`drive-hud ${state.publishing ? "moving" : ""} ${state.halt ? "halted" : ""}`} data-testid="drive-hud">
            {state.halt && <HaltNotice app={app} halt={state.halt} />}
            <div className="drive-hud-row">
                <KeyPad aria-label="drive keys" rows={[[side(1), cell("forward", 1), side(-1)], [cell("turn", 1), cell("forward", -1), cell("turn", -1)]]} />
                <KeyCap label="⇧" down={state.boost} title="Shift: faster" />
                <div className="hud-readout" data-testid="drive-readout">
                    {command
                        ? <><Text small>{command.dryRun ? "dry run · nothing sent" : `${command.source} driving`}</Text><Text small muted mono>{velocity(command.linear, command.angular)} · {command.seconds} s</Text></>
                        : <><Text small mono>{velocity(state.twist.linear, state.twist.angular)}</Text><Text small muted mono>→ {state.topic || "nothing"}</Text></>}
                </div>
            </div>
        </Panel>
    )
}
