// Gamepad driving (core/gamepad.ts) against fake pads (what navigator.getGamepads() returns) and a fake drive: the
// mapping per controller format, LT + RT stopping and A confirming, the at-rest gate on connect, and zeroing on a
// disconnect or blur. Nothing here reaches a robot: the target is a recorder.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { GAMEPAD_DEFAULTS, GamepadDriver, gamepadBindings, padAxes, type PadLike, readPad } from "../src/core/gamepad.ts"
import { profileFor } from "../src/profile/index.ts"
import type { Axes, RobotType } from "../src/profile/types.ts"

interface PadState {
    lx?: number
    ly?: number
    rx?: number
    ry?: number
    a?: boolean
    rb?: boolean
    lt?: number
    rt?: number
}

function pad(state: PadState = {}, extra: Partial<PadLike> = {}): PadLike {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
    buttons[0] = { pressed: !!state.a, value: state.a ? 1 : 0 }
    buttons[5] = { pressed: !!state.rb, value: state.rb ? 1 : 0 }
    buttons[6] = { pressed: (state.lt ?? 0) > 0.5, value: state.lt ?? 0 }
    buttons[7] = { pressed: (state.rt ?? 0) > 0.5, value: state.rt ?? 0 }
    return { index: 0, id: "Xbox Wireless Controller (STANDARD GAMEPAD)", mapping: "standard", connected: true, axes: [state.lx ?? 0, state.ly ?? 0, state.rx ?? 0, state.ry ?? 0], buttons, ...extra }
}

function rig(type: RobotType = "dog", settings = GAMEPAD_DEFAULTS) {
    const log = { axes: [] as Partial<Axes>[], stops: 0, reconnects: 0, confirms: 0, boost: [] as boolean[] }
    let halted = false
    const driver = new GamepadDriver({
        profile: () => profileFor(type),
        settings: () => settings,
        setAxes: (axes) => log.axes.push(axes),
        setBoost: (boost) => log.boost.push(boost),
        stop: () => log.stops++,
        halted: () => halted,
        reconnect: () => log.reconnects++,
        confirm: () => log.confirms++,
    })
    const last = () => log.axes.at(-1) ?? { forward: 0, strafe: 0, turn: 0, vertical: 0 }
    const moving = () => Object.values(last()).some((value) => value !== 0)
    return { driver, log, last, moving, setHalted: (value: boolean) => (halted = value) }
}

Deno.test("mapping: left stick forward / strafe (formats that strafe), right stick turns; dead zone and expo like the phone sticks", () => {
    const dog = profileFor("dog"), wheeled = profileFor("wheeled")
    // up on the stick (the API's -y) is forward; left (-x) is +strafe and +turn (REP-103)
    const full = padAxes({ lx: -1, ly: -1, rx: -1, ry: 0 }, dog, GAMEPAD_DEFAULTS)
    assert(full.forward! > 0.6 && full.strafe! > 0.6 && full.turn === 1)
    // a wheeled base strafes too (the robot decides what linear.y means)
    assertEquals(padAxes({ lx: -1, ly: 0, rx: 0, ry: 0 }, wheeled, GAMEPAD_DEFAULTS), { forward: 0, strafe: 1, turn: 0, vertical: 0 })
    assertEquals(padAxes({ lx: 0, ly: -1, rx: 0, ry: 0 }, wheeled, GAMEPAD_DEFAULTS).forward, 1)
    // inside the dead zone: nothing (drift)
    assertEquals(padAxes({ lx: 0.1, ly: -0.1, rx: 0.12, ry: 0 }, dog, GAMEPAD_DEFAULTS), { forward: 0, strafe: 0, turn: 0, vertical: 0 })
    // expo: half the stick is well under half speed
    assert(padAxes({ lx: 0, ly: -0.5, rx: 0, ry: 0 }, dog, GAMEPAD_DEFAULTS).forward! < 0.4)
    // invert Y: up backs up
    assertEquals(padAxes({ lx: 0, ly: -1, rx: 0, ry: 0 }, dog, { ...GAMEPAD_DEFAULTS, invertY: true }).forward, -1)
    // a bigger dead zone swallows more
    assertEquals(padAxes({ lx: 0, ly: -0.25, rx: 0, ry: 0 }, dog, { ...GAMEPAD_DEFAULTS, deadZone: 0.3 }).forward, 0)
    // a drone: the right stick's y is up / down
    assertEquals(padAxes({ lx: 0, ly: 0, rx: 0, ry: -1 }, profileFor("drone"), GAMEPAD_DEFAULTS).vertical, 1)
})

Deno.test("a non-standard pad (a raw Steam Deck) is read with the common layout", () => {
    const deck = pad({ ly: -1, lt: 1, rt: 1, a: true }, { id: "28de-1205-Valve Software Steam Deck Controller", mapping: "" })
    const read = readPad(deck)
    assertEquals([read.ly, read.lt, read.rt, read.a], [-1, true, true, true])
    // a short or broken axes array reads as rest
    assertEquals(readPad({ ...deck, axes: [NaN] }).lx, 0)
})

Deno.test("at-rest gate: a pad connected with a stick held (or drifting) sends nothing until both sticks are at rest", () => {
    const { driver, log, moving } = rig()
    driver.poll([pad({ ly: -1 })])
    driver.poll([pad({ ly: -1 })])
    assertEquals(driver.status.get().connected, true)
    assertEquals(driver.status.get().ready, false)
    assert(!moving())
    assertEquals(log.axes.filter((axes) => axes.forward !== 0), [], "a held stick at connect never drives")
    // a trigger held at connect also keeps it waiting
    driver.poll([pad({ lt: 1 })])
    assertEquals(driver.status.get().ready, false)
    driver.poll([pad()])
    assertEquals(driver.status.get().ready, true)
    driver.poll([pad({ ly: -1 })])
    assert(moving(), "after rest, the stick drives")
})

Deno.test("LT + RT stops at once and holds the pad; A drives again, from the sticks at rest", () => {
    const { driver, log, moving } = rig()
    driver.poll([pad()])
    driver.poll([pad({ ly: -1 })])
    assert(moving())
    driver.poll([pad({ ly: -1, lt: 1, rt: 1 })])
    assertEquals(log.stops, 1)
    assert(!moving())
    assertEquals(driver.status.get().stopped, true)
    // still holding the combo, or one trigger: one stop, and the stick does nothing
    driver.poll([pad({ ly: -1, lt: 1, rt: 1 })])
    driver.poll([pad({ ly: -1, lt: 1 })])
    driver.poll([pad({ ly: -1 })])
    assertEquals(log.stops, 1)
    assert(!moving())
    // one trigger alone never stops
    driver.poll([pad({ rt: 1 })])
    assertEquals(log.stops, 1)
    // A: the hold lifts, but a stick still pushed waits for rest
    driver.poll([pad({ ly: -1, a: true })])
    assertEquals(driver.status.get().stopped, false)
    driver.poll([pad({ ly: -1 })])
    assert(!moving())
    driver.poll([pad()])
    driver.poll([pad({ ly: -1 })])
    assert(moving())
    assertEquals(log.confirms, 0, "A after a stop resumes, it doesn't press a button")
    // A with nothing to resume: the focused button
    driver.poll([pad({ a: true })])
    assertEquals(log.confirms, 1)
})

Deno.test("held by the link watch: the pad is ignored, A reconnects, and after it lets go only from rest", () => {
    const { driver, log, moving, setHalted } = rig()
    driver.poll([pad()])
    driver.poll([pad({ rx: -1 })])
    assert(moving())
    setHalted(true)
    driver.poll([pad({ rx: -1 })])
    assert(!moving())
    driver.poll([pad({ rx: -1, a: true })])
    assertEquals(log.reconnects, 1)
    setHalted(false)
    driver.poll([pad({ rx: -1 })])
    assert(!moving(), "the stick held through the hold doesn't drive when it lifts")
    driver.poll([pad()])
    driver.poll([pad({ rx: -1 })])
    assert(moving())
})

Deno.test("a disconnect or a blur zeroes it, and it waits for rest again", () => {
    const { driver, moving, log } = rig()
    driver.poll([pad()])
    driver.poll([pad({ ly: -1, rb: true })])
    assert(moving())
    assertEquals(log.boost, [true])
    // blur / hidden tab
    driver.release()
    assert(!moving())
    assertEquals(log.boost, [true, false], "boost lets go too")
    driver.poll([pad({ ly: -1 })])
    assert(!moving())
    driver.poll([pad()])
    driver.poll([pad({ ly: -1 })])
    assert(moving())
    // unplugged: zeros, and the strip shows no pad
    driver.poll([null])
    assert(!moving())
    assertEquals(driver.status.get().connected, false)
    // plugged back in with the stick pushed: still nothing
    driver.poll([pad({ ly: -1 })])
    assert(!moving())
})

Deno.test("arm format: the sticks don't drive; LT + RT stops the arm and A confirms", () => {
    const { driver, log, moving } = rig("arm")
    driver.poll([pad()])
    driver.poll([pad({ ly: -1, rx: 1 })])
    assert(!moving())
    driver.poll([pad({ lt: 1, rt: 1 })])
    assertEquals(log.stops, 1)
    assert(gamepadBindings(profileFor("arm")).some((binding) => /arm/.test(binding.action)))
    assert(gamepadBindings(profileFor("dog")).some((binding) => /strafe/.test(binding.action)))
})
