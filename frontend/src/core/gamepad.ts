// Driving from a gamepad (the Gamepad API: Xbox, PlayStation, Steam Deck, anything with the standard mapping; other
// pads are read with the common layout, sticks on axes 0-3). Kept free of the DOM so it's tested (test/gamepad.test.ts):
// ui/useGamepad.ts polls navigator.getGamepads() into GamepadDriver.poll and calls release() on blur / a hidden tab.
//   left stick   forward / back, plus strafe for formats that strafe (like the phone's left thumb)
//   right stick  turn (x), plus up / down for formats with a vertical axis
//   RB (held)    boost, like Shift
//   LT + RT      STOP: everything stops now, and the pad's driving holds until A
//   A            confirm: after LT + RT, drive again (from the sticks at rest); with driving held (latency, link lost),
//                Reconnect; otherwise it presses the focused button (a dialog's)
// Safety: nothing drives until the pad's sticks have been at rest (a pad connected with a stick off center, or drifting,
// sends nothing); a disconnect, blur or hidden tab zeroes it and asks for rest again; held driving (the link watch)
// ignores it like the keys. The arm format isn't driven by a pad (its joints and end effector are keyed): there only
// LT + RT (the arm's stop) and A work.
import { GamepadDriver as SharedDriver, type GamepadStatus, noPad, padAxes as sharedPadAxes, type PadLike } from "dimos-react"
import { persistentStore, Store } from "./store.ts"
import type { Axes, RobotProfile } from "../profile/types.ts"

export { noPad, readPad } from "dimos-react"
export type { GamepadStatus, PadLike } from "dimos-react"

export interface GamepadSettings {
    /** share of a stick's travel that sends nothing (drift) */
    deadZone: number
    /** up on the left stick backs up */
    invertY: boolean
}

export const GAMEPAD_DEFAULTS: GamepadSettings = { deadZone: 0.15, invertY: false }
export const gamepadSettings = persistentStore<GamepadSettings>("lv.gamepad", GAMEPAD_DEFAULTS)

/** Which drive axes a format uses beyond forward and turn (the same test as its keys: ui/DriveHud.tsx). */
export function profileAxes(profile: RobotProfile): { strafe: boolean; vertical: boolean } {
    const actions = Object.values(profile.drive.keys)
    return {
        strafe: actions.some((action) => "axis" in action && action.axis === "strafe"),
        vertical: actions.some((action) => "axis" in action && action.axis === "vertical"),
    }
}

/** The drive axes for the sticks (raw -1..1, y down as the API reports it), for this format and these settings. */
export function padAxes(pad: { lx: number; ly: number; rx: number; ry: number }, profile: RobotProfile, settings: GamepadSettings): Partial<Axes> {
    return sharedPadAxes(pad, { ...profileAxes(profile), invertY: settings.invertY, deadZone: settings.deadZone })
}

/** What the pad drives and stops (app.drive / app.arm through ui/useGamepad.ts; a test passes fakes). */
export interface PadTarget {
    profile: () => RobotProfile
    settings: () => GamepadSettings
    /** the drive's axes from this source (drive.setAxes("gamepad", ...)); ignored by the drive while held */
    setAxes: (axes: Partial<Axes>) => void
    setBoost: (boost: boolean) => void
    /** STOP, the same as Space (the drive's, or the arm's) */
    stop: () => void
    /** driving is held by the link watch (latency, link lost) */
    halted: () => boolean
    /** A while held: Reconnect */
    reconnect: () => void
    /** A otherwise: press the focused button */
    confirm: () => void
}

/** dimos-react's GamepadDriver with this app's format, settings and drive; its status as a Store for the bar. */
export class GamepadDriver {
    readonly #driver: SharedDriver

    constructor(readonly target: PadTarget, readonly status = new Store<GamepadStatus>(noPad())) {
        this.#driver = new SharedDriver(
            {
                axes: () => ({ ...profileAxes(target.profile()), ...target.settings() }),
                // an arm isn't driven by the sticks (its joints and end effector are keyed): only LT + RT and A work
                drives: () => target.profile().type !== "arm",
                setAxes: (axes) => target.setAxes(axes),
                setBoost: (boost) => target.setBoost(boost > 0),
                stop: () => target.stop(),
                halted: () => target.halted(),
                reconnect: () => target.reconnect(),
                confirm: () => target.confirm(),
            },
            {},
            (status) => this.status.set(status),
        )
    }

    /** One read of navigator.getGamepads(). */
    poll(pads: readonly (PadLike | null)[]) {
        this.#driver.poll(pads)
    }

    /** Blur, a hidden tab, a disconnect: zero now, and nothing again until the sticks are at rest. */
    release() {
        this.#driver.release()
    }
}

/** The pad's controls for the `?` list (ui/Overlays.tsx). */
export function gamepadBindings(profile: RobotProfile): { buttons: string; action: string }[] {
    if (profile.type === "arm") {
        return [
            { buttons: "LT + RT", action: "STOP the arm" },
            { buttons: "A", action: "confirm (the focused button)" },
            { buttons: "sticks", action: "nothing: the arm is driven from the keys and the arm panel" },
        ]
    }
    const { strafe, vertical } = profileAxes(profile)
    return [
        { buttons: "left stick", action: strafe ? "forward / back, strafe" : "forward / back" },
        { buttons: "right stick", action: vertical ? "turn, up / down" : "turn" },
        { buttons: "RB (hold)", action: "boost" },
        { buttons: "LT + RT", action: "STOP (the pad holds until A)" },
        { buttons: "A", action: "after a stop: drive again · disengaged: Reconnect · else the focused button" },
    ]
}
