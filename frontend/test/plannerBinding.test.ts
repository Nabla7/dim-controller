import { assertEquals } from "jsr:@std/assert@1"
import { Manipulation } from "../src/core/manipulation.ts"

const binding = { run_id: "sim-run", module: "planner:left", session: "session-1" }
const target = { groups: ["left"], joints: { left1: 0.1 }, poses: {}, source: "joints" }

Deno.test("an old run's event cannot replace the inspected target", () => {
    const planner = new Manipulation()
    planner.state.update({ binding })
    planner.applyEvent({ binding: { ...binding, session: "old-session" }, target })
    assertEquals(planner.state.get().target, null)
    planner.applyEvent({ target })
    assertEquals(planner.state.get().target, null)
    planner.applyEvent({ binding, target })
    assertEquals(planner.state.get().target, target)
})

Deno.test("a changed planner discards targets, previews and plans before accepting its state", async () => {
    const fetchBefore = globalThis.fetch
    Object.defineProperty(globalThis, "location", { value: new URL("http://localhost/"), configurable: true })
    const planner = new Manipulation()
    planner.state.update({ binding, target: target as never, selected: ["left"], preview: { id: "p", startedAt: 1 } })
    try {
        globalThis.fetch = (() => Promise.resolve(Response.json({ available: true,
            binding: { ...binding, session: "session-2" }, state: { groups: {} }, groups: [], target: null, plan: null }))) as typeof fetch
        await planner.refresh()
        assertEquals(planner.state.get().binding?.session, "session-2")
        assertEquals(planner.state.get().target, null)
        assertEquals(planner.state.get().preview, null)
        assertEquals(planner.state.get().plan, null)
    } finally { globalThis.fetch = fetchBefore; Reflect.deleteProperty(globalThis, "location") }
})
