import { assertEquals, assert } from "jsr:@std/assert@1"
import { actionAllowed, driveBlock, INITIAL_POLICY_STATE, PolicyControl, type PolicyState, type PolicyStatus } from "../src/core/policyControl.ts"

const status: PolicyStatus = { active: true, control_state: "unarmed", arm_pending: false, dry_run: true, fault_reason: null, feedback_received: true, simulation: false, feedback_age_ms: 3, imu_age_ms: 4, feedback_timeout_ms: 200, reference_source: "planner" }
const ready: PolicyState = { ...INITIAL_POLICY_STATE, required: true, stale: false, status, target: { run: "r1", policy: "g1sonicpolicymodule", movement: "movementmanager", hardware: "g1wholebodyconnection" } }

Deno.test("activation needs fresh feedback; damping remains available with stale state and pending activation", () => {
    assert(actionAllowed(ready, "activate"))
    assert(!actionAllowed({ ...ready, status: { ...status, imu_age_ms: 250 } }, "activate"))
    assert(!actionAllowed({ ...ready, status: { ...status, arm_pending: true } }, "activate"))
    assert(actionAllowed({ ...ready, stale: true, pending: "activate" }, "damping-stop"))
    assert(!actionAllowed({ ...ready, stale: true }, "activate"))
    assertEquals(driveBlock({ ...ready, status: { ...status, control_state: "control", dry_run: false } }), null)
    assert(driveBlock({ ...ready, status: { ...status, control_state: "control", dry_run: false, reference_source: "webxr_pose" } }))
})

Deno.test("WebXR blueprint discovered by module; activation uses run-guarded RPCs, not native Pico or a custom control endpoint", async () => {
    const oldFetch = globalThis.fetch
    const calls: { path: string; body: Record<string, unknown> }[] = []
    let cleared = 0
    const policy = new PolicyControl(() => cleared++)
    const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/apps/controller/") })
    globalThis.fetch = ((input, init) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith("/active")) return Promise.resolve(Response.json({ running: true, runId: "r1", blueprint: "unitree-g1-sonic-webxr-teleop" }))
        if (path.endsWith("/modules")) return Promise.resolve(Response.json({ modules: [
            { id: "g1sonicpolicymodule", class: "G1SonicPolicyModule", namespace: null, rpcs: [{ name: "activate" }] },
            { id: "movementmanager", class: "MovementManager", namespace: null, rpcs: [] },
        ] }))
        const body = JSON.parse(String(init?.body))
        calls.push({ path, body })
        return Promise.resolve(Response.json({ ok: true, result: path.endsWith("/status") ? status : true }))
    }) as typeof fetch
    try {
        await policy.refresh()
        assertEquals(policy.state.get().target?.run, "r1")
        await policy.act("activate")
        assertEquals(calls.filter((call) => !call.path.endsWith("/status")).map((call) => call.path.split("/rpcs/")[1]), ["stop_motion", "activate"])
        assert(calls.every((call) => call.body.run_id === "r1"))
        assert(cleared > 0)
        globalThis.fetch = (() => Promise.resolve(Response.json({ error: "run changed" }, { status: 409 }))) as typeof fetch
        await policy.act("activate")
        assert(policy.state.get().stale)
        assert(policy.state.get().error?.includes("run changed"))
    } finally {
        policy.dispose()
        globalThis.fetch = oldFetch
        if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation)
        else Reflect.deleteProperty(globalThis, "location")
    }
})
