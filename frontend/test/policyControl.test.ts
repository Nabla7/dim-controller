import { assertEquals, assertMatch } from "jsr:@std/assert@1"
import { stub } from "jsr:@std/testing@1/mock"
import { FakeTime } from "jsr:@std/testing@1/time"
import { actionAllowed, driveBlock, PolicyControl, type PolicyState, type PolicyStatus } from "../src/core/policyControl.ts"

const status = (extra: Partial<PolicyStatus> = {}): PolicyStatus => ({
    available: true, run_id: "run-1", controller: { id: "policy", name: "SONIC", robot: "G1", model: "sonic_v1_1", teleop_topic: "/tele_cmd_vel", capabilities: ["base_velocity"] },
    phase: "pose-hold", dry_run: true, fault: null, reason: null, can_activate: true, can_deactivate: false,
    command_source: "idle", feedback_age_ms: 3, command_age_ms: 10, motor_rate_hz: 500,
    actions: ["activate", "deactivate", "stop-motion", "damping-stop"], ...extra,
})
const state = (extra: Partial<PolicyState> = {}): PolicyState => ({ required: true, status: status(), stale: false, error: null, pending: null, ...extra })

const response = (body: unknown, code = 200): Response => ({ ok: code < 400, status: code, json: () => Promise.resolve(body) }) as Response

Deno.test("driving requires fresh live balancing; damping remains available during stale state or an outstanding action", () => {
    assertEquals(driveBlock(state({ required: false })), null)
    assertEquals(driveBlock(state()), "Activate the policy to drive")
    const live = state({ status: status({ phase: "balancing", dry_run: false, can_activate: false, can_deactivate: true }) })
    assertEquals(driveBlock(live), null)
    assertEquals(driveBlock({ ...live, stale: true }), "Waiting for fresh policy state")
    assertEquals(driveBlock({ ...live, status: status({ phase: "fault", fault: "feedback timeout" }) }), "feedback timeout")
    assertEquals(actionAllowed(state({ stale: true }), "activate"), false)
    assertEquals(actionAllowed(state({ pending: "activate" }), "activate"), false)
    assertEquals(actionAllowed(state({ pending: "activate", stale: true }), "damping-stop"), true)
    assertEquals(actionAllowed(state({ status: null }), "damping-stop"), false)
})

async function withControl(run: (control: PolicyControl, time: FakeTime) => Promise<void>) {
    const location = Object.getOwnPropertyDescriptor(globalThis, "location")
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://controller.test/apps/dim-controller/") })
    const time = new FakeTime()
    const control = new PolicyControl(() => {})
    try {
        await run(control, time)
    } finally {
        control.dispose()
        time.restore()
        if (location) Object.defineProperty(globalThis, "location", location)
        else Reflect.deleteProperty(globalThis, "location")
    }
}

Deno.test("opening the panel only reads; an action targets the displayed run once and late polling cannot overwrite it", async () => {
    await withControl(async (control, time) => {
        let reads = 0
        let finishPoll!: (response: Response) => void
        const actions: unknown[] = []
        using fetch = stub(globalThis, "fetch", (_url, options) => {
            if (options?.method === "POST") {
                actions.push(JSON.parse(options.body as string))
                return Promise.resolve(response(status({ phase: "activating", dry_run: false, can_activate: false, can_deactivate: true })))
            }
            if (++reads === 2) return new Promise((resolve) => { finishPoll = resolve })
            return Promise.resolve(response(status()))
        })
        control.setRunning(["unitree-g1-sonic-wbc"])
        await time.tickAsync(0)
        assertEquals(actions, [])
        assertEquals(control.state.get().status?.phase, "pose-hold")
        await time.tickAsync(1000)
        await control.act("activate")
        finishPoll(response(status()))
        await time.tickAsync(0)
        assertEquals(control.state.get().status?.phase, "activating")
        assertEquals(actions, [{ run_id: "run-1", controller_id: "policy", action: "activate" }])
    })
})

Deno.test("failed actions are not retried and their error survives the next status poll", async () => {
    await withControl(async (control, time) => {
        let actions = 0
        using fetch = stub(globalThis, "fetch", (_url, options) => {
            if (options?.method === "POST") {
                actions++
                return Promise.resolve(response({ error: "The robot stack changed" }, 409))
            }
            return Promise.resolve(response(status()))
        })
        control.setRunning(["unitree-g1-sonic-wbc"])
        await time.tickAsync(0)
        await control.act("activate")
        assertEquals(control.state.get().stale, true)
        await time.tickAsync(1000)
        await time.runMicrotasks()
        assertEquals(control.state.get().stale, false)
        assertMatch(control.state.get().error!, /robot stack changed/)
        assertEquals(actions, 1)
    })
})

Deno.test("a hung status request disables driving before the request timeout", async () => {
    await withControl(async (control, time) => {
        let reads = 0
        using fetch = stub(globalThis, "fetch", () => ++reads === 1
            ? Promise.resolve(response(status({ phase: "balancing", dry_run: false })))
            : new Promise<Response>(() => {}))
        control.setRunning(["unitree-g1-sonic-wbc"])
        await time.tickAsync(0)
        assertEquals(driveBlock(control.state.get()), null)
        await time.tickAsync(3500)
        assertEquals(driveBlock(control.state.get()), "Waiting for fresh policy state")
    })
})
