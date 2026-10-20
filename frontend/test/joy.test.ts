// Joy (core/joy.ts): each source's layout, and that it's published only on a change, at most JOY_HZ, with a rest on release.
import { assertEquals } from "jsr:@std/assert@1"
import { JOY_HZ, JoyPublisher, type JoySettings, keyboardJoy, padJoy, sticksJoy } from "../src/core/joy.ts"
import { decode } from "../src/core/lcm/lcm.ts"
import { Store } from "../src/core/store.ts"
import type { Connection } from "../src/core/transport.ts"
import type { PadLike } from "../src/core/gamepad.ts"

function fakeBridge() {
    const puts: { key: string; axes: number[]; buttons: number[]; frame: string; sec: number }[] = []
    const opened: string[] = []
    const client = {
        state: "connected",
        publisher(key: string) {
            opened.push(key)
            return {
                state: "open",
                put: (bytes: Uint8Array) => {
                    const joy = decode("sensor_msgs.Joy", bytes)
                    puts.push({ key, axes: [...joy.axes].map((value: number) => Math.round(value * 1000) / 1000), buttons: [...joy.buttons], frame: joy.header.frame_id, sec: joy.header.stamp.sec })
                },
                close() {},
            }
        },
    }
    const commanded: string[] = []
    return { connection: { client, command: (key: string) => commanded.push(key) } as unknown as Connection, puts, opened, commanded }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function pad(axes: number[], pressed: number[] = [], values: Record<number, number> = {}): PadLike {
    return {
        index: 0,
        id: "pad",
        mapping: "standard",
        connected: true,
        axes,
        buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: pressed.includes(index), value: values[index] ?? (pressed.includes(index) ? 1 : 0) })),
    }
}

Deno.test("a pad's Joy: the raw axes to 3 decimals, then LT's and RT's travel, and every button 0/1", () => {
    const sample = padJoy(pad([0.12345, -1, -0.00001, 0.5], [0, 7], { 6: 0.4567 }))
    assertEquals(sample.axes, [0.123, -1, 0, 0.5, 0.457, 1])
    assertEquals(sample.buttons.length, 17)
    assertEquals(sample.buttons.slice(0, 8), [1, 0, 0, 0, 0, 0, 0, 1], "LT pulled part way isn't pressed")
    assertEquals(padJoy(pad([NaN, 0])).axes, [0, 0, 0, 0], "a NaN axis is 0")
})

Deno.test("the keyboard's Joy is KeyboardTeleop's buttons (w a s d q e shift ctrl space), arrows as w a s d", () => {
    assertEquals(keyboardJoy(["KeyW", "ArrowLeft", "KeyE", "KeyZ"], { shift: true, ctrl: false, space: false }), { axes: [], buttons: [1, 1, 0, 0, 0, 1, 1, 0, 0] })
    assertEquals(keyboardJoy([], { shift: false, ctrl: false, space: true }).buttons, [0, 0, 0, 0, 0, 0, 0, 0, 1])
})

Deno.test("the thumb sticks' Joy is a pad's four axes, y down +", () => {
    assertEquals(sticksJoy({ x: 0.25, y: 1 }, { x: -0.33333, y: 0 }), { axes: [0.25, -1, -0.333, 0], buttons: [] })
})

Deno.test("published on /joystick only when it changes, at most JOY_HZ, the latest wins; a release sends the rest once; then quiet", async () => {
    const { connection, puts, opened } = fakeBridge()
    const joy = new JoyPublisher(connection, new Store<JoySettings>({ enabled: true }))
    joy.sample("gamepad", padJoy(pad([0, 0, 0, 0])))
    assertEquals(opened, [], "a pad at rest publishes nothing, and makes no publisher")
    joy.sample("gamepad", padJoy(pad([0, -0.5, 0, 0])))
    assertEquals(puts.length, 1)
    assertEquals(puts[0].key, "dimos/joystick/sensor_msgs.Joy")
    assertEquals(puts[0].axes, [0, -0.5, 0, 0, 0, 0])
    assertEquals(puts[0].frame, "")
    assertEquals(Math.abs(puts[0].sec - Date.now() / 1000) < 2, true, "stamped now")
    // three changes inside one gap: one more message, the last of them
    joy.sample("gamepad", padJoy(pad([0, -0.6, 0, 0])))
    joy.sample("gamepad", padJoy(pad([0, -0.7, 0, 0])))
    joy.sample("gamepad", padJoy(pad([0, -0.8, 0, 0], [5])))
    assertEquals(puts.length, 1, "not before the gap")
    await wait(1000 / JOY_HZ + 30)
    assertEquals(puts.length, 2)
    assertEquals(puts[1].axes[1], -0.8)
    assertEquals(puts[1].buttons[5], 1)
    // held still: nothing
    for (let index = 0; index < 5; index++) {
        joy.sample("gamepad", padJoy(pad([0, -0.8, 0, 0], [5])))
        await wait(20)
    }
    assertEquals(puts.length, 2, "an unchanged pad sends nothing")
    joy.release("gamepad")
    await wait(1000 / JOY_HZ + 30)
    assertEquals(puts.length, 3)
    assertEquals(puts[2].axes, [0, 0, 0, 0, 0, 0])
    assertEquals(puts[2].buttons.every((button) => button === 0), true)
    joy.release("gamepad")
    joy.sample("gamepad", padJoy(pad([0, 0, 0, 0])))
    await wait(150)
    assertEquals(puts.length, 3, "quiet at rest")
    joy.dispose()
})

Deno.test("a change undone inside the gap sends nothing; each source has its own gap", async () => {
    const { connection, puts } = fakeBridge()
    const joy = new JoyPublisher(connection, new Store<JoySettings>({ enabled: true }))
    const keys = (held: string[]) => keyboardJoy(held, { shift: false, ctrl: false, space: false })
    joy.sample("keyboard", keys(["KeyW"]))
    joy.sample("touch", sticksJoy({ x: 0, y: 1 }, { x: 0, y: 0 }))
    assertEquals(puts.length, 2, "another source isn't held by the keyboard's gap")
    joy.sample("keyboard", keys(["KeyW", "KeyA"]))
    joy.sample("keyboard", keys(["KeyW"]))
    await wait(1000 / JOY_HZ + 30)
    assertEquals(puts.length, 2)
    joy.sample("keyboard", keys([]))
    await wait(1000 / JOY_HZ + 30)
    assertEquals(puts.at(-1)!.buttons, [0, 0, 0, 0, 0, 0, 0, 0, 0], "the key-up's rest")
    joy.dispose()
})

Deno.test("turned off mid-hold: the rest goes out at once, then nothing; turned on again, it publishes", async () => {
    const { connection, puts } = fakeBridge()
    const settings = new Store<JoySettings>({ enabled: true })
    const joy = new JoyPublisher(connection, settings)
    joy.sample("gamepad", padJoy(pad([1, 0, 0, 0])))
    settings.set({ enabled: false })
    assertEquals(puts.length, 2)
    assertEquals(puts[1].axes, [0, 0, 0, 0, 0, 0])
    joy.sample("gamepad", padJoy(pad([0.5, 0, 0, 0])))
    await wait(150)
    assertEquals(puts.length, 2, "off: nothing")
    settings.set({ enabled: true })
    joy.sample("gamepad", padJoy(pad([0.5, 0, 0, 0])))
    await wait(1000 / JOY_HZ + 30)
    assertEquals(puts.at(-1)!.axes[0], 0.5)
    joy.dispose()
})
