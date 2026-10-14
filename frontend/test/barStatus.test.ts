// The one bar's problem chips (ui/barStatus.ts): the link only when it's a problem, "Disengaged" when the link watch
// stops driving, and the gamepad's state.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { disengagedShort, disengagedText, gamepadChip, linkChip, linkProblem, rateText, SLOW_RTT_MS } from "../src/ui/barStatus.ts"

const link = (state: "connecting" | "connected" | "degraded" | "lost", rttMs: number | null = 20, throughputBytesPerSec: number | null = 240000) => ({ state, rttMs, droppedPerSecond: 0, error: null, throughputBytesPerSec })

Deno.test("the link chip always shows live throughput and latency, coloured by the problem; lost or connecting say so", () => {
    assertEquals(linkChip(link("connected"), 89), { text: "\u2007\u20071.9 Mbps · \u2007\u200789 ms", tone: "ok", detail: "Link healthy. Throughput reaching this page and the control link's round trip" })
    assertEquals(linkChip(link("connected", 20, null), null).text, "\u2007\u2007\u2007\u2007— Mbps · \u2007\u2007\u2007— ms")
    assertEquals(linkChip(link("degraded"), 120).tone, "warn")
    assertEquals(linkChip(link("connected", SLOW_RTT_MS + 50), SLOW_RTT_MS + 50).tone, "warn")
    assertEquals(linkChip(link("connecting"), null).text, "Connecting")
    assertEquals(linkChip(link("lost"), null).tone, "bad")
    assertEquals([rateText(940), rateText(240_000), rateText(3_140_000), rateText(1e12)], ["\u2007\u20070.0 Mbps", "\u2007\u20071.9 Mbps", "\u200725.1 Mbps", "999.9 Mbps"])
})

Deno.test("the link chip shows only a problem: lost, connecting, degraded, slow", () => {
    assertEquals(linkProblem(link("connected")), null, "healthy: nothing (the Status panel has the numbers)")
    assertEquals(linkProblem(link("connected", null)), null)
    assertEquals(linkProblem(link("lost"))?.tone, "bad")
    assertEquals(linkProblem(link("connecting"))?.tone, "warn")
    assertEquals(linkProblem(link("degraded"))?.tone, "warn")
    const slow = linkProblem(link("connected", SLOW_RTT_MS + 50))
    assert(slow && slow.tone === "warn" && /300 ms/.test(slow.text))
})

Deno.test("driving stopped by the link watch reads Disengaged, with what to do", () => {
    assertEquals(disengagedText({ reason: "latency", latencyMs: 1240, maxMs: 1000 }), "Disengaged: latency 1240 ms > 1000 ms max. Reconnect to drive.")
    assertEquals(disengagedText({ reason: "latency", latencyMs: null, maxMs: 1000 }), "Disengaged: latency over 1000 ms max. Reconnect to drive.")
    assertEquals(disengagedText({ reason: "lost", latencyMs: null, maxMs: 1000 }), "Disengaged: link lost. Reconnect to drive.")
    assertEquals(disengagedShort({ reason: "latency", latencyMs: 1240, maxMs: 1000 }), "Disengaged · 1240 ms")
    assert(!/held/i.test(disengagedText({ reason: "lost", latencyMs: null, maxMs: 1 })))
})

Deno.test("the gamepad chip: none without a pad; ready, waiting for rest, or stopped until A", () => {
    assertEquals(gamepadChip({ connected: false, id: "", ready: false, stopped: false }), null)
    assertEquals(gamepadChip({ connected: true, id: "x", ready: true, stopped: false })?.tone, "ok")
    assertEquals(gamepadChip({ connected: true, id: "x", ready: false, stopped: false })?.text, "center sticks")
    assert(/A/.test(gamepadChip({ connected: true, id: "x", ready: false, stopped: true })!.detail))
})
