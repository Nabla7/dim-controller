// The operator's raw input as sensor_msgs/Joy on /joystick (dimos's stream name: the web cockpit's Teleop(joystick=...)
// and KeyboardTeleop both publish `joystick: Joy`). It drives nothing; it's there for recordings and for a module that
// wants the actual input. Each source has its own layout (a message tells them apart by its lengths):
//   gamepad   axes: the Gamepad API's raw axes (3 decimals, y down +), then LT's and RT's analog travel 0..1 (Go2 Ctrl's
//             addition: a Joy button is only 0/1); buttons: every button 0/1 (standard mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB,
//             5 RB, 6 LT, 7 RT, 8 Back, 9 Start, 10 LS, 11 RS, 12-15 d-pad, 16 Home)
//   keyboard  axes: none; buttons: KeyboardTeleop's JOY_BUTTONS w a s d q e shift ctrl space (the arrows count as w a s d)
//   touch     axes: the phone's thumb sticks as a pad's left x, y, right x, y (y down +); buttons: none
// Like the drive (core/drive.ts) nothing goes out while idle: a sample is published when it changes, at most JOY_HZ per
// source (the latest wins), and a release (blur, a hidden tab, the pad gone, the setting turned off) sends that source
// at rest once. Tested in test/joy.test.ts.
import { encode } from "./lcm/lcm.ts"
import { persistentStore, Store } from "./store.ts"
import { type Connection, dimosKey, Priority, type Publisher } from "./transport.ts"
import type { PadLike } from "./gamepad.ts"

export const JOY_TOPIC = "/joystick"
export const JOY_TYPE = "sensor_msgs.Joy"
/** dimos's Teleop panel samples Joy at its publish_hz (15 by default) */
export const JOY_HZ = 15

export type JoySource = "gamepad" | "keyboard" | "touch"
export interface JoySample {
    axes: number[]
    buttons: number[]
}

export interface JoySettings {
    /** publish the raw input on JOY_TOPIC */
    enabled: boolean
}
export const joySettings = persistentStore<JoySettings>("lv.joy", { enabled: true })

/** KeyboardTeleop's Joy.buttons order (dimos/robot/unitree/keyboard_teleop.py) */
export const KEYBOARD_JOY_BUTTONS = ["w", "a", "s", "d", "q", "e", "shift", "ctrl", "space"] as const
const KEY_BUTTON: Record<string, number> = { KeyW: 0, ArrowUp: 0, KeyA: 1, ArrowLeft: 1, KeyS: 2, ArrowDown: 2, KeyD: 3, ArrowRight: 3, KeyQ: 4, KeyE: 5 }

/** standard mapping LT, RT */
const TRIGGERS = [6, 7]

const round3 = (value: number) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 || 0 : 0

/** A gamepad's Joy: raw axes, then the triggers' travel, and its buttons 0/1. */
export function padJoy(pad: PadLike): JoySample {
    return {
        axes: [...pad.axes.map(round3), ...TRIGGERS.map((index) => round3(pad.buttons[index]?.value ?? 0))],
        buttons: pad.buttons.map((button) => (button.pressed ? 1 : 0)),
    }
}

/** The keyboard's Joy: the held key codes (KeyW, ArrowUp, ...), Shift, Ctrl and Space as KEYBOARD_JOY_BUTTONS. */
export function keyboardJoy(held: Iterable<string>, mods: { shift: boolean; ctrl: boolean; space: boolean }): JoySample {
    const buttons = KEYBOARD_JOY_BUTTONS.map(() => 0)
    for (const code of held) {
        const index = KEY_BUTTON[code]
        if (index !== undefined) {
            buttons[index] = 1
        }
    }
    buttons[6] = mods.shift ? 1 : 0
    buttons[7] = mods.ctrl ? 1 : 0
    buttons[8] = mods.space ? 1 : 0
    return { axes: [], buttons }
}

/** The thumb sticks' Joy (each stick's x right +, y up +, as they report it) as a pad's four axes, y down +. */
export function sticksJoy(left: { x: number; y: number }, right: { x: number; y: number }): JoySample {
    return { axes: [left.x, -left.y, right.x, -right.y].map(round3), buttons: [] }
}

const atRest = (sample: JoySample): JoySample => ({ axes: sample.axes.map(() => 0), buttons: sample.buttons.map(() => 0) })
const keyOf = (sample: JoySample) => JSON.stringify(sample)

interface SourceState {
    /** what was last published (null: nothing yet) */
    sent: string | null
    sentAt: number
    /** a change waiting for the rate's gap */
    pending: JoySample | null
    timer: ReturnType<typeof setTimeout> | undefined
    last: JoySample | null
}

export class JoyPublisher {
    readonly published = new Store<{ count: number; last: JoySample | null }>({ count: 0, last: null })
    #sources = new Map<JoySource, SourceState>()
    #publisher: Publisher | null = null
    #client: unknown = null
    #unsubscribe: () => void

    constructor(readonly connection: Connection, readonly settings: Store<JoySettings> = joySettings, readonly hz = JOY_HZ, readonly now = () => Date.now()) {
        let enabled = settings.get().enabled
        this.#unsubscribe = settings.subscribe(() => {
            const next = settings.get().enabled
            if (enabled && !next) {
                // turned off mid-hold: each source's rest goes out first, then nothing
                for (const source of this.#sources.keys()) {
                    this.#flushRest(source)
                }
                this.#close()
            }
            enabled = next
        })
    }

    /** A source's current input: published if it changed, now or when the rate allows (the latest wins). */
    sample(source: JoySource, sample: JoySample) {
        if (!this.settings.get().enabled) {
            return
        }
        const state = this.#state(source)
        const key = keyOf(sample)
        if (state.pending && key === keyOf(state.pending)) {
            return
        }
        if (key === state.sent) {
            // back to what's out: whatever was waiting is moot
            state.pending = null
            clearTimeout(state.timer)
            state.timer = undefined
            return
        }
        // a source's first sample at rest says nothing new (a pad connected, the keyboard's first key-up)
        if (state.sent === null && keyOf(atRest(sample)) === key) {
            return
        }
        const wait = state.sentAt + 1000 / this.hz - this.now()
        if (wait <= 0) {
            this.#publish(source, state, sample)
            return
        }
        state.pending = sample
        if (state.timer === undefined) {
            state.timer = setTimeout(() => {
                state.timer = undefined
                const next = state.pending
                state.pending = null
                if (next && this.settings.get().enabled) {
                    this.#publish(source, state, next)
                }
            }, wait)
        }
    }

    /** The source let go (blur, a hidden tab, the pad gone): its rest goes out once, if it wasn't already. */
    release(source: JoySource) {
        const state = this.#sources.get(source)
        if (state?.last) {
            this.sample(source, atRest(state.last))
        }
    }

    #flushRest(source: JoySource) {
        const state = this.#state(source)
        clearTimeout(state.timer)
        state.timer = undefined
        state.pending = null
        if (state.last && state.sent !== keyOf(atRest(state.last))) {
            this.#publish(source, state, atRest(state.last))
        }
    }

    #state(source: JoySource): SourceState {
        let state = this.#sources.get(source)
        if (!state) {
            state = { sent: null, sentAt: -Infinity, pending: null, timer: undefined, last: null }
            this.#sources.set(source, state)
        }
        return state
    }

    #publish(source: JoySource, state: SourceState, sample: JoySample) {
        state.sent = keyOf(sample)
        state.sentAt = this.now()
        state.last = sample
        const publisher = this.#ensurePublisher()
        if (!publisher) {
            return
        }
        const now = this.now()
        this.connection.command(dimosKey(JOY_TOPIC, JOY_TYPE))
        try {
            publisher.put(encode(JOY_TYPE, { header: { stamp: { sec: Math.floor(now / 1000), nsec: (now % 1000) * 1_000_000 }, frame_id: "" }, axes: sample.axes, buttons: sample.buttons }))
            this.published.set({ count: this.published.get().count + 1, last: sample })
        } catch {
            // tripped: the next sample makes a fresh publisher
            this.#close()
        }
    }

    /** made on the first sample (nothing exists while idle), and again after a reconnect */
    #ensurePublisher(): Publisher | null {
        const client = this.connection.client
        if (!client || client.state === "lost") {
            return null
        }
        if (this.#publisher && (this.#client !== client || ["tripped", "closed", "rejected"].includes(this.#publisher.state))) {
            this.#close()
        }
        if (!this.#publisher) {
            this.#publisher = client.publisher(dimosKey(JOY_TOPIC, JOY_TYPE), { priority: Priority.INTERACTIVE_HIGH, delivery: "reliable" })
            this.#client = client
        }
        return this.#publisher
    }

    #close() {
        this.#publisher?.close()
        this.#publisher = null
        this.#client = null
    }

    dispose() {
        for (const state of this.#sources.values()) {
            clearTimeout(state.timer)
        }
        this.#unsubscribe()
        this.#close()
    }
}
