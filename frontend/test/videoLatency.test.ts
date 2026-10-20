// Video latency, source to screen (core/videoLatency.ts): the gateway's stats parsed (nothing from an older gateway),
// the slowest camera picked, and the chip's and Network panel's text.
import { assertEquals } from "jsr:@std/assert@1"
import { gatewayVideoLatency, latencyStages, slowestVideo, spreadParts, spreadText, videoChipText, type VideoLatency } from "../src/core/videoLatency.ts"
import { linkChip } from "../src/ui/barStatus.ts"

const latency = (p50: number, p95: number, extra: Partial<VideoLatency> = {}): VideoLatency => ({
    frames: 150,
    unmatched: 0,
    total: { p50, p95 },
    stages: { toGateway: { p50: 2, p95: 4 }, encoding: { p50: 8, p95: 12 }, toTrack: { p50: 1, p95: 3 }, trackToShown: { p50: p50 - 11, p95: p95 - 19 } },
    ...extra,
})

Deno.test("the gateway's video stages: 0.5.21's videoLatency, nothing from an older gateway or a data stream", () => {
    assertEquals(gatewayVideoLatency({ bytesSent: 10, videoLatency: { sourceToReceivedMs: 2.5, receivedToEncodedMs: 9, encodedToWrittenMs: 1, pacerP50Ms: 4, pacerP95Ms: 11 } }), { sourceToReceivedMs: 2.5, receivedToEncodedMs: 9, encodedToWrittenMs: 1, pacerP50Ms: 4, pacerP95Ms: 11 })
    assertEquals(gatewayVideoLatency({ videoLatency: { sourceToReceivedMs: 2, receivedToEncodedMs: 9, encodedToWrittenMs: 1, pacerP50Ms: null, pacerP95Ms: null } })?.pacerP50Ms, null)
    assertEquals(gatewayVideoLatency({ bytesSent: 10 }), null)
    assertEquals(gatewayVideoLatency({ videoLatency: null }), null)
    assertEquals(gatewayVideoLatency(null), null)
})

Deno.test("the slowest camera by p50; none measured is null", () => {
    assertEquals(slowestVideo([latency(80, 120), null, latency(300, 400), latency(90, 900)])?.total, { p50: 300, p95: 400 })
    assertEquals(slowestVideo([null, undefined]), null)
})

Deno.test("the chip shows the video's typical ms and its spike beside the control round trip, and nothing before it's measured", () => {
    assertEquals(spreadParts({ p50: 119.6, p95: 180.2 }), { typical: "120", spike: "spike 180" })
    assertEquals(spreadParts(null), { typical: "—", spike: null })
    assertEquals(spreadText({ p50: 119.6, p95: 180.2 }), "120 ms (spike 180)")
    assertEquals(spreadText(null), "—")
    assertEquals(videoChipText(latency(120, 180)), { typical: "120", spike: "spike 180" })
    assertEquals(videoChipText(null), null)
    const connection = { state: "connected" as const, rttMs: 6, droppedPerSecond: 0, error: null, throughputBytesPerSec: 250_000 }
    const chip = linkChip(connection, 6, latency(1840, 2400))
    assertEquals([chip.text, chip.video], ["  2.0 Mbps ·    6 ms", { typical: "1840", spike: "spike 2400" }])
    assertEquals("video" in linkChip(connection, 6), false)
})

Deno.test("a camera's details: each stage, the browser's split where it reports one, the in-packet check and the gateway's pacer", () => {
    const names = (rows: { name: string }[]) => rows.map((row) => row.name)
    assertEquals(names(latencyStages(latency(120, 180), null)), ["source → screen", "to the gateway", "encoding", "to the track", "track → screen"])
    const full = latencyStages(
        latency(120, 180, { stages: { toGateway: { p50: 2, p95: 4 }, encoding: { p50: 8, p95: 12 }, toTrack: { p50: 1, p95: 3 }, trackToShown: { p50: 109, p95: 161 }, toReceived: { p50: 60, p95: 90 }, receivedToShown: { p50: 49, p95: 71 } }, captureToShown: { p50: 121, p95: 179 } }),
        { sourceToReceivedMs: 2, receivedToEncodedMs: 8.4, encodedToWrittenMs: 1, pacerP50Ms: 5, pacerP95Ms: 14 },
    )
    assertEquals(full.map((row) => [row.name, row.value, row.spike]).slice(-5), [["· to this browser", "60", "spike 90"], ["· received → shown", "49", "spike 71"], ["check: in-packet stamp", "121", "spike 179"], ["gateway: RTP pacer", "5", "spike 14"], ["gateway: stages", "2 · 8 · 1", null]])
    assertEquals([full[0].value, full[0].spike], ["120", "spike 180"])
    // a pacer not measured yet: a dash, no spike
    assertEquals(latencyStages(null, { sourceToReceivedMs: 2, receivedToEncodedMs: 8, encodedToWrittenMs: 1, pacerP50Ms: null, pacerP95Ms: null })[0], { name: "gateway: RTP pacer", value: "—", spike: null, detail: "first packet into the gateway's RTP pacer to the last out (its latest 128 frames)" })
    // an older gateway: nothing to show
    assertEquals(latencyStages(null, null), [])
})
