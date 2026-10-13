// Driving on screen (no arming: keys and sticks always drive). Desktop: the profile's keys lighting up as they're held,
// in the action dock (ui/ActionDock.tsx). Phone: two thumbs, a left stick that translates (forward/back, plus strafe for profiles
// that strafe) and a right stick that turns (plus up/down for profiles with a vertical axis), STOP and boost. Both show the agent's commands (POST api/drive), dry runs included.
import { disengagedShort, disengagedText } from "./barStatus.ts"
import { profileAxes } from "../core/gamepad.ts"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import type { Axis } from "../profile/types.ts"
import { Badge, Button, Card, releaseAllThumbSticks, TextInput, ThumbStick } from "dimos-react"
import { shapeStick, smoothToward } from "../core/stick.ts"
import { sticksJoy } from "../core/joy.ts"
import type { DriveHalt } from "../core/drive.ts"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { popoverPosition } from "./panelDrag.ts"

/** Driving disengaged by the link watch: why, and Reconnect (the only way to drive again). */
function DisengagedNotice({ app, halt }: { app: ViewerApp; halt: DriveHalt }) {
    return (
        <div className="drive-halt" role="alert" data-testid="drive-halt">
            <span>{disengagedText(halt)}</span>
            <Button className="reconnect-button" data-testid="reconnect-button" disabled={halt.reconnecting} onClick={() => app.reconnect()}>
                {halt.reconnecting ? "Reconnecting…" : "Reconnect"}
            </Button>
        </div>
    )
}

/** The phone's version: one pill over the top of the sticks (it takes no room, so STOP never moves); a tap reconnects. */
function DisengagedPill({ app, halt }: { app: ViewerApp; halt: DriveHalt }) {
    const text = halt.reconnecting ? "Reconnecting…" : `${disengagedShort(halt)}${halt.reason === "latency" ? " lag" : ""} · Reconnect`
    return (
        <button
            type="button"
            className="drive-halt-pill"
            role="alert"
            data-testid="drive-halt"
            title={disengagedText(halt)}
            aria-label={disengagedText(halt)}
            disabled={halt.reconnecting}
            onClick={() => app.reconnect()}
        >
            {text}
        </button>
    )
}

export function DriveHud({ app, mobile }: { app: ViewerApp; mobile: boolean }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const { strafe: usesStrafe, vertical: usesVertical } = profileAxes(app.profile)
    const command = state.command
    const velocity = (linear: number[], angular: number[]) => velocityText(linear, angular, usesStrafe, usesVertical)
    // both thumbs as one Joy (core/joy.ts: a pad's four axes); a let-go stick reports 0, 0, so the rest goes out too
    const thumbs = useRef({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } })
    const thumbJoy = (side: "left" | "right", x: number, y: number) => {
        thumbs.current[side] = { x, y }
        app.joy.sample("touch", sticksJoy(thumbs.current.left, thumbs.current.right))
    }
    useEffect(() => () => app.joy.release("touch"), [app])

    if (mobile) {
        const moving = state.publishing && [...state.twist.linear, ...state.twist.angular].some((value) => value !== 0)
        return (
            <div className={`drive-hud mobile ${moving ? "moving" : ""}`} data-testid="drive-hud-mobile">
                <ThumbStick
                    className="stick-zone left"
                    label={usesStrafe ? "move" : "forward / back"}
                    axes={usesStrafe ? "xy" : "y"}
                    shape={shapeStick}
                    smooth={smoothToward}
                    onMove={(x: number, y: number) => {
                        drive.setAxes("left-stick", { forward: y, strafe: usesStrafe ? -x : 0 })
                        thumbJoy("left", x, y)
                    }}
                />
                {state.halt && <DisengagedPill app={app} halt={state.halt} />}
                <div className="hud-center">
                    <Badge className="hud-note" data-testid="drive-readout">
                        {command ? `${command.dryRun ? "dry run" : command.source} · ${velocity(command.linear, command.angular)}` : velocity(state.twist.linear, state.twist.angular)}
                    </Badge>
                    <Button
                        className="stop-button"
                        data-testid="stop-button"
                        onPointerDown={() => {
                            // on touch, not on the click after it: no 300 ms, and it works while a thumb holds a stick
                            releaseAllThumbSticks()
                            drive.stop()
                        }}
                        onClick={() => {
                            releaseAllThumbSticks()
                            drive.stop()
                        }}
                    >
                        STOP
                    </Button>
                    <Button className="boost-button" pressed={state.boost} onClick={() => drive.setBoost(!state.boost)}>{state.boost ? "FAST ON" : "FAST"}</Button>
                </div>
                <ThumbStick
                    className="stick-zone right"
                    label={usesVertical ? "turn · up / down" : "turn"}
                    axes={usesVertical ? "xy" : "x"}
                    shape={shapeStick}
                    smooth={smoothToward}
                    onMove={(x: number, y: number) => {
                        drive.setAxes("right-stick", { turn: -x, vertical: usesVertical ? y : 0 })
                        thumbJoy("right", x, y)
                    }}
                />
            </div>
        )
    }

    return <DriveKeys app={app} />
}

/** A fixed-width signed speed ("+0.00", "-0.35"): the readout keeps its width as values change. */
export const signed = (value: number) => {
    const digits = Math.abs(value).toFixed(2)
    return `${value < 0 && digits !== "0.00" ? "-" : "+"}${digits}`
}

/** The readout's velocity line, every field fixed-width. */
export function velocityText(linear: number[], angular: number[], strafe: boolean, vertical: boolean): string {
    return `${signed(linear[0])}${strafe ? ` / ${signed(linear[1])}` : ""}${vertical ? ` / ${signed(linear[2])}` : ""} m/s · ${signed(angular[2])} rad/s`
}

/** The drive topic chip ("→ /tele_cmd_vel ▾"): a menu of auto, the Twist topics seen, and a custom one (the same setting as Settings → Drive). */
function DriveTopicChip({ app }: { app: ViewerApp }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const settings = useStore(drive.settings)
    useStore(app.connection.status)
    const [open, setOpen] = useState(false)
    const [custom, setCustom] = useState("")
    const chip = useRef<HTMLButtonElement>(null)
    useEffect(() => {
        if (!open) {
            return
        }
        const close = (event: Event) => {
            if (!(event.target as HTMLElement).closest?.(".drive-topic-chip, .drive-topic-menu")) {
                setOpen(false)
            }
        }
        addEventListener("pointerdown", close, true)
        return () => removeEventListener("pointerdown", close, true)
    }, [open])
    const chosen = settings.topics ?? []
    const auto = chosen.length === 0
    const choose = (topics: string[]) => {
        drive.settings.update({ topics })
        setOpen(false)
    }
    const autoText = drive.autoTopics().map((topic) => topic.topic).join(", ") || "nothing"
    return (
        <>
            <button
                ref={chip}
                type="button"
                className="drive-topic-chip"
                data-testid="drive-topic-chip"
                title={`Drive topic${auto ? " (auto)" : ""}: ${state.topic || "none"} (click to change; Settings → Drive has the same)`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                → {state.topic || "no drive topic"} ▾
            </button>
            {open && createPortal(
                <Card padded={false} className="quality-menu drive-topic-menu" role="menu" aria-label="Drive topic" style={popoverPosition(chip.current, 260)}>
                    <div className="quality-title">Drive topic</div>
                    <button type="button" role="menuitemradio" aria-checked={auto} className={`quality-option ${auto ? "on" : ""}`} onClick={() => choose([])}>
                        <span className="quality-name">auto</span>
                        <span className="quality-about">→ {autoText}</span>
                    </button>
                    {drive.candidates().map((topic) => {
                        const on = !auto && chosen.length === 1 && chosen[0].split(/\s+/)[0] === topic
                        return (
                            <button type="button" key={topic} role="menuitemradio" aria-checked={on} className={`quality-option ${on ? "on" : ""}`} onClick={() => choose([topic])}>
                                <span className="quality-name">{topic}</span>
                            </button>
                        )
                    })}
                    <form
                        className="drive-topic-custom"
                        onSubmit={(event) => {
                            event.preventDefault()
                            const topic = custom.trim()
                            if (topic) {
                                choose([topic.startsWith("/") ? topic : `/${topic}`])
                                setCustom("")
                            }
                        }}
                    >
                        <TextInput aria-label="Custom drive topic" placeholder="custom: /my_cmd_vel" value={custom} onChange={setCustom} />
                        <Button type="submit" disabled={!custom.trim()}>Use</Button>
                    </form>
                </Card>,
                document.body,
            )}
        </>
    )
}

/** The desktop's drive keys (lit while held), what's being sent (or the agent's command), and the hold with Reconnect. */
export function DriveKeys({ app }: { app: ViewerApp }) {
    const state = useStore(app.drive.state)
    const keys = app.profile.drive.keys
    const { strafe: usesStrafe, vertical: usesVertical } = profileAxes(app.profile)
    const keyFor = (axis: Axis, sign: number) => Object.entries(keys).find(([code, action]) => !code.startsWith("Arrow") && "axis" in action && action.axis === axis && Math.sign(action.value) === sign)?.[0].replace(/^Key/, "")
    const command = state.command
    const velocity = (linear: number[], angular: number[]) => velocityText(linear, angular, usesStrafe, usesVertical)
    // one width for every value: the longest velocity line plus an agent command's " · 10 s"
    const readoutWidth = `${velocity([0, 0, 0], [0, 0, 0]).length + 7}ch`
    const lit = (axis: Axis, sign: number) => Math.sign(state.axes[axis]) === sign && state.axes[axis] !== 0
    const cell = (axis: Axis, sign: number) => {
        const key = keyFor(axis, sign)
        return key ? <span className={`key ${lit(axis, sign) ? "down" : ""}`}>{key}</span> : <span className="key empty" />
    }
    return (
        <div className={`dock-drive ${state.publishing ? "moving" : ""} ${state.halt ? "halted" : ""}`} data-testid="drive-hud">
            <div className="keys" aria-label="drive keys">
                <div>{usesStrafe ? cell("strafe", 1) : usesVertical ? cell("vertical", -1) : <span className="key empty" />}{cell("forward", 1)}{usesStrafe ? cell("strafe", -1) : usesVertical ? cell("vertical", 1) : <span className="key empty" />}</div>
                <div>{cell("turn", 1)}{cell("forward", -1)}{cell("turn", -1)}</div>
            </div>
            <span className={`key shift ${state.boost ? "down" : ""}`} title="Shift: boost">⇧</span>
            {state.halt
                ? <DisengagedNotice app={app} halt={state.halt} />
                : (
                    <div className="hud-readout" data-testid="drive-readout" style={{ width: readoutWidth }}>
                        {command
                            ? <><div className="line">{command.dryRun ? "dry run · nothing sent" : `${command.source} driving`}</div><div className="line dim">{velocity(command.linear, command.angular)} · {command.seconds} s</div></>
                            : <><div className="line">{velocity(state.twist.linear, state.twist.angular)}</div><DriveTopicChip app={app} /></>}
                    </div>
                )}
        </div>
    )
}
