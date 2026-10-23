import { assertEquals, assert } from "jsr:@std/assert@1"
import { actionAllowed, driveBlock, HEIGHT_RANGE, INITIAL_POLICY_STATE, modeName, PolicyControl, type PolicyState, type PolicyStatus } from "../src/core/policyControl.ts"

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

const live: PolicyStatus = { ...status, simulation: true, control_state: "control", dry_run: false, mode: 0, mode_override: 1, mode_queue: [] }
const options = { modes: { IDLE: 0, SLOW_WALK: 1, IDEL_KNEEL: 6 }, clips: ["wave"], height: true }

Deno.test("policy settings require live planner control and advertised capabilities", () => {
    const state: PolicyState = { ...ready, status: live, options }
    for (const action of ["mode", "height", "clip"] as const) {
        assert(actionAllowed(state, action))
        assert(!actionAllowed({ ...state, stale: true }, action))
        assert(!actionAllowed({ ...state, pending: "activate" }, action))
        assert(!actionAllowed({ ...state, status: { ...live, dry_run: true } }, action))
        assert(!actionAllowed({ ...state, status: { ...live, arm_pending: true } }, action))
        assert(!actionAllowed({ ...state, status: { ...live, fault_reason: "stale feedback" } }, action))
        assert(!actionAllowed({ ...state, status: { ...live, reference_source: "webxr" } }, action))
        assert(!actionAllowed({ ...state, status: { ...live, reference_source: "stream" } }, action))
        assert(!actionAllowed({ ...state, options: null }, action))
    }
    assert(!actionAllowed({ ...state, options: { ...options, clips: [] } }, "clip"))
    assert(!actionAllowed({ ...state, options: { ...options, modes: {} } }, "mode"))
    assert(!actionAllowed({ ...state, options: { ...options, height: false } }, "height"))
    assert(actionAllowed({ ...state, status: { ...live, reference_source: "webxr" } }, "stop-motion"))
    assertEquals(modeName(state, 6), "Kneel")
    assertEquals(modeName(state, undefined), "Unknown")
})

type Call = { module: string; method: string; body: { run_id: string; kwargs: Record<string, unknown> } }
async function withBackend(test: (control: PolicyControl, server: {
    run: string; feedback: PolicyStatus; calls: Call[]
    intercept: (call: Call) => Promise<Response> | Response | undefined
}) => Promise<void>) {
    const oldFetch = globalThis.fetch
    const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/apps/controller/") })
    const server = {
        run: "r1", feedback: { ...live }, calls: [] as Call[],
        intercept: (_call: Call): Promise<Response> | Response | undefined => undefined,
    }
    const methods = ["activate", "set_locomotion_mode", "list_locomotion_modes", "set_base_height", "play_motion_clip", "list_motion_clips"]
    globalThis.fetch = (async (input, init) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith("/active")) return Response.json({ running: true, runId: server.run })
        if (path.endsWith("/modules")) return Response.json({ modules: [
            { id: "policy", class: "G1SonicPolicyModule", namespace: null, rpcs: methods.map((name) => ({ name })) },
            { id: "movement", class: "MovementManager", namespace: null, rpcs: [] },
        ] })
        const [, module, method] = path.match(/\/modules\/([^/]+)\/rpcs\/(.+)$/)!
        const call = { module, method, body: JSON.parse(String(init?.body)) }
        server.calls.push(call)
        const intercepted = server.intercept(call)
        if (intercepted) return await intercepted
        if (call.body.run_id !== server.run) return Response.json({ error: "run changed" }, { status: 409 })
        const result = method === "status" ? server.feedback
            : method === "list_locomotion_modes" ? options.modes
            : method === "list_motion_clips" ? options.clips : true
        return Response.json({ ok: true, result })
    }) as typeof fetch
    const control = new PolicyControl(() => {})
    try { await test(control, server) }
    finally {
        control.dispose()
        globalThis.fetch = oldFetch
        if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation)
        else Reflect.deleteProperty(globalThis, "location")
    }
}

const mutations = (calls: Call[]) => calls.filter((call) => !["status", "list_locomotion_modes", "list_motion_clips"].includes(call.method))

Deno.test("gait, height and clips use installed options and run-bound RPCs after cancelling navigation", async () => {
    await withBackend(async (control, server) => {
        await control.refresh()
        await control.refresh()
        assertEquals(control.state.get().options, options)
        assertEquals(server.calls.filter((call) => call.method === "list_motion_clips").length, 1)
        await control.act({ action: "mode", mode: "IDEL_KNEEL" })
        await control.act({ action: "height", height: 0.4 })
        assertEquals(control.state.get().notice, "Requested pelvis height 0.40 m")
        await control.act({ action: "height", height: null })
        await control.act({ action: "clip", name: "wave" })
        assertEquals(mutations(server.calls).map(({ module, method, body }) => [module, method, body.kwargs]), [
            ["movement", "stop_motion", {}], ["policy", "set_locomotion_mode", { mode: "IDEL_KNEEL" }],
            ["movement", "stop_motion", {}], ["policy", "set_base_height", { height: 0.4 }],
            ["movement", "stop_motion", {}], ["policy", "set_base_height", { height: -1 }],
            ["movement", "stop_motion", {}], ["policy", "play_motion_clip", { name: "wave" }],
        ])
        assert(server.calls.every((call) => call.body.run_id === "r1"))
        server.run = "r2"
        await control.refresh()
        assertEquals(control.state.get().notice, null)
        assertEquals(server.calls.filter((call) => call.method === "list_motion_clips").length, 2)
        assertEquals(mutations(server.calls).length, 8) // discovering a new run never reapplies commands
    })
})

Deno.test("invalid options, out-of-range heights and stale or WebXR-owned state send no mutations", async () => {
    await withBackend(async (control, server) => {
        await control.refresh()
        await control.act({ action: "mode", mode: "IDEL_LYING_FACE_DOWN" })
        await control.act({ action: "clip", name: "../../unknown" })
        for (const height of [NaN, Infinity, -1, HEIGHT_RANGE.min - 0.01, HEIGHT_RANGE.max + 0.01]) await control.act({ action: "height", height })
        control.state.update({ stale: true })
        await control.act({ action: "mode", mode: "SLOW_WALK" })
        control.state.update({ stale: false, status: { ...live, reference_source: "webxr" } })
        await control.act({ action: "clip", name: "wave" })
        assertEquals(mutations(server.calls), [])
    })
})

Deno.test("option discovery failures do not disable lifecycle controls and are retried read-only", async () => {
    await withBackend(async (control, server) => {
        server.intercept = ({ method }) => method === "list_motion_clips" ? Response.json({ ok: false, error: "catalog unavailable" }) : undefined
        await control.refresh()
        assert(!control.state.get().stale)
        assert(control.state.get().optionsError?.includes("catalog unavailable"))
        assert(actionAllowed(control.state.get(), "stop-motion"))
        assert(!actionAllowed(control.state.get(), "clip"))
        server.intercept = () => undefined
        await control.refresh()
        assertEquals(control.state.get().options, options)
        assertEquals(control.state.get().optionsError, null)
        assertEquals(mutations(server.calls), [])
    })
})

Deno.test("changing runs during an action rejects the old run without replaying it on the new robot", async () => {
    await withBackend(async (control, server) => {
        await control.refresh()
        server.intercept = ({ module }) => { if (module === "movement") server.run = "r2"; return undefined }
        await control.act({ action: "clip", name: "wave" })
        assert(control.state.get().stale)
        assert(control.state.get().error?.includes("run changed"))
        assertEquals(mutations(server.calls).map((call) => call.method), ["stop_motion"])
        await control.refresh()
        assertEquals(control.state.get().target?.run, "r2")
        assertEquals(mutations(server.calls).length, 1)
    })
})

Deno.test("damping stop preempts a clip request waiting on navigation; RPC failures are surfaced", async () => {
    await withBackend(async (control, server) => {
        await control.refresh()
        let release!: (response: Response) => void
        server.intercept = ({ module }) => module === "movement" ? new Promise<Response>((resolve) => { release = resolve }) : undefined
        const playing = control.act({ action: "clip", name: "wave" })
        assertEquals(control.state.get().pending, "clip")
        await control.act("damping-stop")
        release(Response.json({ ok: true, result: true }))
        await playing
        assertEquals(mutations(server.calls).map((call) => call.method), ["stop_motion", "halt_robot"])
        assertEquals(control.state.get().pending, null)
        server.intercept = ({ method }) => method === "play_motion_clip" ? Response.json({ ok: false, error: "missing joint_pos.csv" }) : undefined
        await control.act({ action: "clip", name: "wave" })
        assert(control.state.get().error?.includes("missing joint_pos.csv"))
        assert(control.state.get().stale)
        assertEquals(control.state.get().notice, null)
    })
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
