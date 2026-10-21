// Driving from a gamepad (the Gamepad API's standard mapping: Xbox, PlayStation, a Steam Deck through Steam; other pads
// are read with the common layout, sticks on axes 0-3). DOM-free, so an app polls navigator.getGamepads() into
// GamepadDriver.poll and calls release() on blur or a hidden page, and tests pass plain objects. The bindings every app
// shares:
//   left stick   forward / back, and strafe (`strafe`)       right stick  turn, and up / down (`vertical`)
//   RB (held)    boost; with `analogBoost`, LT's pull too     LT + RT      STOP: the pad holds until A
//   A            after a stop, drive again (from rest); otherwise `confirm` (or `reconnect` while `halted`)
// and the optional ones an app turns on: B as a second STOP (`stopOnB`), and holding B to sit down (`sitDown`).
// Safety: nothing drives until the sticks have been seen at rest (a pad connected with a stick off center, or
// drifting, sends nothing); a disconnect, blur, hidden page or `halted` zeroes it and asks for rest again.
import { shapeAxis, shapeStick } from "./stick.ts"

/** The slice of a browser Gamepad this reads (navigator.getGamepads() entries; a test passes plain objects). */
export interface PadLike {
    index: number
    id: string
    mapping: string
    connected: boolean
    /** when it last changed (the Gamepad API's), to pick the pad in use among several */
    timestamp?: number
    axes: readonly number[]
    buttons: readonly { pressed: boolean; value: number }[]
}

/** the drive axes a pad sends, -1..1 each (REP-103: forward, left, turn left, up) */
export interface PadAxes {
    forward: number
    strafe: number
    turn: number
    vertical: number
}

export interface GamepadStatus {
    connected: boolean
    id: string
    /** the sticks were seen at rest since connect or the last stop: input counts */
    ready: boolean
    /** a STOP was pressed: the pad holds until A */
    stopped: boolean
    /** 0..1 while B is held toward sitting down (sitDown only) */
    sitHold: number
}

/** a stick's share of travel that sends nothing (drift) */
export const PAD_DEAD_ZONE = 0.15
/** a trigger counts as pulled past this */
const TRIGGER = 0.5
/** LT's travel below this is slack, not boost */
const BOOST_SLACK = 0.05
/** how long B is held to sit down */
export const SIT_HOLD_MS = 1000
/** standard mapping buttons (w3.org/TR/gamepad) */
export const PAD_BUTTON = { a: 0, b: 1, rb: 5, lt: 6, rt: 7 } as const

export const noPad = (): GamepadStatus => ({ connected: false, id: "", ready: false, stopped: false, sitHold: 0 })

/** The pad's sticks and buttons as this reads them; a short or broken axes array reads as rest. */
export function readPad(pad: PadLike) {
    const axis = (index: number) => (Number.isFinite(pad.axes[index]) ? pad.axes[index] : 0)
    const button = (index: number) => {
        const entry = pad.buttons[index]
        return !!entry && (entry.pressed || entry.value > TRIGGER)
    }
    return {
        lx: axis(0),
        ly: axis(1),
        rx: axis(2),
        ry: axis(3),
        a: button(PAD_BUTTON.a),
        b: button(PAD_BUTTON.b),
        rb: button(PAD_BUTTON.rb),
        lt: button(PAD_BUTTON.lt),
        rt: button(PAD_BUTTON.rt),
        ltValue: pad.buttons[PAD_BUTTON.lt]?.value ?? 0,
    }
}

export type PadRead = ReturnType<typeof readPad>

/** a dead zone kept to something usable */
const clampDeadZone = (value: number) => (Number.isFinite(value) ? Math.min(0.5, Math.max(0.02, value)) : PAD_DEAD_ZONE)
const clean = (value: number) => value || 0

export interface PadAxesOptions {
    /** the left stick's x strafes (else it's ignored) */
    strafe?: boolean
    /** the right stick's y is up / down (else it's ignored) */
    vertical?: boolean
    /** up on the left stick backs up */
    invertY?: boolean
    deadZone?: number
}

/** The drive axes for the sticks (raw -1..1, y down as the API reports it), each with a dead zone and expo. */
export function padAxes(
    read: { lx: number; ly: number; rx: number; ry: number },
    options: PadAxesOptions = {},
): PadAxes {
    const deadZone = clampDeadZone(options.deadZone ?? PAD_DEAD_ZONE)
    const left = shapeStick(read.lx, options.invertY ? -read.ly : read.ly, 1, options.strafe ? "xy" : "y", deadZone)
    // with up / down on it, the right stick's dead zone is radial like the left's; else turn reads x alone
    const right = options.vertical
        ? shapeStick(read.rx, read.ry, 1, "xy", deadZone)
        : { x: shapeAxis(read.rx, deadZone), y: 0 }
    return { forward: left.y, strafe: options.strafe ? clean(-left.x) : 0, turn: clean(-right.x), vertical: right.y }
}

/** every stick inside the dead zone and both triggers out */
export function atRest(
    read: { lx: number; ly: number; rx: number; ry: number; lt: boolean; rt: boolean },
    deadZone = PAD_DEAD_ZONE,
): boolean {
    const zone = clampDeadZone(deadZone)
    return Math.hypot(read.lx, read.ly) <= zone && Math.hypot(read.rx, read.ry) <= zone && !read.lt && !read.rt
}

/** How much LT boosts: 0 released .. 1 fully pulled (past a little slack), in 0.05 steps so it isn't resent per poll. */
export function boostOf(value: number): number {
    const pulled = Math.min(1, Math.max(0, (value - BOOST_SLACK) / (1 - BOOST_SLACK)))
    return Math.round(pulled * 20) / 20
}

/**
 * The pad in use: a standard-mapped pad wins over a raw one (a handheld can show its raw pad beside Steam's virtual
 * one, with its own axis order), and among several the one that changed last.
 */
export function activePad(pads: readonly (PadLike | null)[]): PadLike | null {
    const all = pads.filter((pad): pad is PadLike => !!pad && pad.connected)
    const standard = all.filter((pad) => pad.mapping === "standard")
    const connected = standard.length ? standard : all
    if (connected.length < 2) {
        return connected[0] ?? null
    }
    return connected.reduce((best, pad) => ((pad.timestamp ?? 0) > (best.timestamp ?? 0) ? pad : best))
}

/** 4 decimals; not-a-number (a missing axis) as 0 */
const round4 = (value: number) => (Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0)

/**
 * A sensor_msgs/Joy sample of the pad: the raw axes (4 decimals) and buttons (0/1), then after the axes the triggers'
 * analog travel (LT then RT, 0 released .. 1 fully pulled), since a Joy button is only an integer.
 */
export function joySample(pad: PadLike): { axes: number[]; buttons: number[] } {
    const trigger = (index: number) => round4(pad.buttons[index]?.value ?? 0)
    return {
        axes: [...pad.axes.map(round4), trigger(PAD_BUTTON.lt), trigger(PAD_BUTTON.rt)],
        buttons: pad.buttons.map((button) => (button.pressed ? 1 : 0)),
    }
}

/** What the pad drives; only `setAxes`, `setBoost` and `stop` are needed. */
export interface PadTarget {
    /** the pad's axes; all zero = let go */
    setAxes: (axes: PadAxes) => void
    /** 0 or 1, or LT's pull 0..1 with `analogBoost` */
    setBoost: (boost: number) => void
    /** STOP now */
    stop: () => void
    /** how the sticks map, read every poll (an app's settings or its robot's axes can change) */
    axes?: () => PadAxesOptions
    /** false: the sticks don't drive (only STOP and A work), e.g. an arm driven from its own panel */
    drives?: () => boolean
    /** driving is held by the app (a lost link, high latency): input is ignored, and after it, only from rest */
    halted?: () => boolean
    /** A while halted */
    reconnect?: () => void
    /** A with nothing to resume (press the focused button) */
    confirm?: () => void
    /** B held SIT_HOLD_MS: the safe way down; B also stops at once when given */
    sitDown?: () => void
}

export interface GamepadOptions {
    /** B stops too (a second, one-handed STOP); implied by sitDown */
    stopOnB?: boolean
    /** LT boosts by how far it's pulled, beside RB's full boost */
    analogBoost?: boolean
}

const ZERO: PadAxes = { forward: 0, strafe: 0, turn: 0, vertical: 0 }

export class GamepadDriver {
    status: GamepadStatus = noPad()
    #index: number | null = null
    #last = { a: false, combo: false, boost: 0 }
    #bSince: number | null = null
    #sitSent = false
    #wasHalted = false
    #sent = JSON.stringify(ZERO)

    constructor(
        readonly target: PadTarget,
        readonly options: GamepadOptions = {},
        readonly onStatus: (status: GamepadStatus) => void = () => {},
    ) {}

    #update(change: Partial<GamepadStatus>) {
        const next = { ...this.status, ...change }
        if (JSON.stringify(next) !== JSON.stringify(this.status)) {
            this.status = next
            this.onStatus(next)
        }
    }

    /** One read of navigator.getGamepads(); `now` in ms (only holding B to sit down needs it). */
    poll(pads: readonly (PadLike | null)[], now = 0) {
        const pad = activePad(pads)
        if (!pad) {
            if (this.status.connected) {
                this.release()
                this.#index = null
                this.#update(noPad())
            }
            return
        }
        if (pad.index !== this.#index) {
            // a new pad: nothing from it until its sticks are seen at rest
            this.release()
            this.#index = pad.index
            this.#last = { a: false, combo: false, boost: 0 }
            this.#update({ connected: true, id: pad.id, ready: false, stopped: false, sitHold: 0 })
        }
        const read = readPad(pad)
        const target = this.target
        const options = target.axes?.() ?? {}
        const sits = !!target.sitDown

        // LT + RT (or B): STOP at once, whatever else is going on
        const combo = (read.lt && read.rt) || ((this.options.stopOnB || sits) && read.b)
        if (combo && !this.#last.combo) {
            this.#zero()
            target.stop()
            this.#update({ stopped: true, ready: false })
        }
        // hold B: sit down after SIT_HOLD_MS, once per hold
        if (sits && read.b) {
            this.#bSince ??= now
            const held = Math.min(1, (now - this.#bSince) / SIT_HOLD_MS)
            if (held >= 1 && !this.#sitSent) {
                this.#sitSent = true
                target.sitDown!()
            }
            this.#update({ sitHold: this.#sitSent ? 1 : held })
        } else {
            this.#bSince = null
            this.#sitSent = false
            this.#update({ sitHold: 0 })
        }
        // A: reconnect while halted, resume after a stop, else confirm
        if (read.a && !this.#last.a && !(sits && read.b)) {
            if (target.halted?.()) {
                target.reconnect?.()
            } else if (this.status.stopped) {
                this.#update({ stopped: false, ready: false })
            } else {
                target.confirm?.()
            }
        }
        this.#last.a = read.a
        this.#last.combo = combo

        // halted: input ignored, and once it lets go, only from the sticks at rest
        const halted = !!target.halted?.()
        if (halted && !this.#wasHalted) {
            this.#zero()
            this.#update({ ready: false })
        }
        this.#wasHalted = halted

        if (!this.status.ready && !this.status.stopped && atRest(read, options.deadZone)) {
            this.#update({ ready: true })
        }
        const driving = this.status.ready && !this.status.stopped && !halted && (target.drives?.() ?? true)
        const boost = driving ? (read.rb ? 1 : this.options.analogBoost ? boostOf(read.ltValue) : 0) : 0
        if (boost !== this.#last.boost) {
            this.#last.boost = boost
            target.setBoost(boost)
        }
        if (!driving) {
            this.#zero()
            return
        }
        this.#send(padAxes(read, options))
    }

    /** Blur, a hidden page, a disconnect: zero now, and nothing again until the sticks are at rest. */
    release() {
        this.#zero()
        this.#bSince = null
        if (this.#last.boost) {
            this.#last.boost = 0
            this.target.setBoost(0)
        }
        if (this.status.connected) {
            this.#update({ ready: false, sitHold: 0 })
        }
    }

    #zero() {
        this.#send(ZERO)
    }

    #send(axes: PadAxes) {
        const key = JSON.stringify(axes)
        if (key !== this.#sent) {
            this.#sent = key
            this.target.setAxes(axes)
        }
    }
}
