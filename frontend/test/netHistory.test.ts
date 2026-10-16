// The Network panel's history (core/netHistory.ts): a ring of samples, the wire's parts from the page's WebRTC stats,
// and who's using the link.
import { assertEquals } from "jsr:@std/assert@1"
import { assignSlots, averageOf, breakdown, CONTROL, HEARTBEAT, NetHistory, nearestIndex, netSummary, niceCeil, OTHER, partRates, percentile, RESENT, Ring, RTP_HEADERS, stableOrder, stackOf, streamTable, wireCounts } from "../src/core/netHistory.ts"


Deno.test("the ring keeps the newest items, oldest first", () => {
    const ring = new Ring<number>(3)
    assertEquals([ring.toArray(), ring.last()], [[], undefined])
    for (const n of [1, 2, 3, 4, 5]) {
        ring.push(n)
    }
    assertEquals([ring.toArray(), ring.length, ring.last()], [[3, 4, 5], 3, 5])
})

const report = (stats: Record<string, unknown>[]) => ({ forEach: (callback: (stat: Record<string, unknown>) => void) => stats.forEach(callback) })
const sub = (key: string, bytesReceived: number, mid?: string) => ({ type: "data-channel", label: JSON.stringify({ type: "sub", key, id: 1, opts: {}, ...(mid ? { mid } : {}) }), bytesReceived })

Deno.test("the wire's parts: each data channel under its key, control and heartbeat by name, video payload under its channel's key, RTP headers and resends", () => {
    const counts = wireCounts(report([
        { type: "transport", bytesReceived: 50_000 },
        sub("dimos/lidar/x.Y", 1000),
        sub("dimos/lidar/x.Y", 500),
        sub("dimos/cam/a.B", 40, "1"),
        { type: "data-channel", label: "control", bytesReceived: 300 },
        { type: "data-channel", label: JSON.stringify({ type: "heartbeat", opts: { hz: 10 } }), bytesReceived: 200 },
        { type: "inbound-rtp", mid: "1", bytesReceived: 30_000, headerBytesReceived: 1200, retransmittedBytesReceived: 2000 },
        { type: "inbound-rtp", mid: "7", bytesReceived: 10 },
    ]))
    assertEquals(counts, {
        wire: 50_000,
        parts: { "dimos/lidar/x.Y": 1500, "dimos/cam/a.B": 28_040, [CONTROL]: 300, [HEARTBEAT]: 200, [RTP_HEADERS]: 1200, [RESENT]: 2000, "video (mid 7)": 10 },
    })
    assertEquals(wireCounts(report([sub("a", 1)])).wire, null)
})

Deno.test("a part's rate is its growth over the elapsed time; a new or reset part has none", () => {
    assertEquals(partRates({ a: 1000, b: 500 }, { a: 3000, b: 100, c: 70 }, 500), { a: 4000 })
})

Deno.test("who's using the link: largest first, shares of the wire, the rest of the wire as other", () => {
    assertEquals(breakdown({ bytesPerSec: 1000, streams: { a: 200, b: 600, idle: 0 } }), [
        { key: "b", bytesPerSec: 600, share: 0.6 },
        { key: "a", bytesPerSec: 200, share: 0.2 },
        { key: OTHER, bytesPerSec: 200, share: 0.2 },
    ])
    assertEquals(breakdown({ bytesPerSec: 500, streams: { a: 1000 } }), [{ key: "a", bytesPerSec: 1000, share: 1 }])
    assertEquals(breakdown({ bytesPerSec: null, streams: {} }), [])
})

Deno.test("history samples the wire and parts between reports; no connection, no data", () => {
    const history = new NetHistory(10)
    history.sample(0, { wire: 0, parts: { a: 0 } }, 40)
    history.sample(1000, { wire: 3000, parts: { a: 2000 } }, 41)
    history.sample(2000, null, null)
    assertEquals(history.samples.toArray().map((sample) => [sample.bytesPerSec, sample.streams, sample.latencyMs]), [[null, {}, 40], [3000, { a: 2000 }, 41], [null, {}, null]])
})

Deno.test("colour slots follow the stream, not its rank; past the palette a stream has none", () => {
    const slots = new Map<string, number>()
    assignSlots(slots, ["a", "b", OTHER], 2)
    assignSlots(slots, ["c", "b", "a"], 2)
    assertEquals([...slots], [["a", 0], ["b", 1]])
    slots.delete("a")
    assignSlots(slots, ["c"], 2)
    assertEquals(slots.get("c"), 0)
})

Deno.test("the table's average: the wire and each stream averaged over the samples, a stream missing from one counts as zero there", () => {
    const average = averageOf([
        { bytesPerSec: 100, streams: { a: 60, b: 40 } },
        { bytesPerSec: 300, streams: { a: 60 } },
        { bytesPerSec: null, streams: {} },
    ])
    assertEquals(average.bytesPerSec, 200)
    assertEquals(average.streams, { a: 40, b: 40 / 3 })
    assertEquals(averageOf([]), { bytesPerSec: null, streams: {} })
})

Deno.test("axis tops round up to a few round steps × 10^n; nothing gets 1", () => {
    assertEquals([0.3, 1, 1.2, 4.9, 5, 7, 270, 0, NaN].map(niceCeil), [0.3, 1, 1.5, 5, 5, 8, 300, 1, 1])
})

Deno.test("percentile by nearest rank", () => {
    assertEquals([percentile([], 0.95), percentile([5], 0.95), percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), percentile([3, 1, 2], 0.5)], [null, 5, 10, 2])
})

Deno.test("the dashboard's numbers: the newest, the last minute's mean, the peak; latency's p95 and max; gaps skipped", () => {
    const samples = [
        { at: 0, bytesPerSec: 9000, latencyMs: 100, streams: {} },
        { at: 70_000, bytesPerSec: 1000, latencyMs: 20, streams: {} },
        { at: 71_000, bytesPerSec: null, latencyMs: null, streams: {} },
        { at: 72_000, bytesPerSec: 3000, latencyMs: 30, streams: {} },
    ]
    assertEquals(netSummary(samples), { rateNow: 3000, rateAverage: 2000, ratePeak: 9000, latencyNow: 30, latencyP95: 100, latencyMax: 100 })
    assertEquals(netSummary([]), { rateNow: null, rateAverage: null, ratePeak: null, latencyNow: null, latencyP95: null, latencyMax: null })
})

Deno.test("the table's order holds until a row clearly passes the one above; gone rows drop, new ones join at the bottom and climb", () => {
    assertEquals(stableOrder([], { a: 1, b: 3, c: 2 }), ["b", "c", "a"])
    assertEquals(stableOrder(["b", "c", "a"], { a: 1, b: 2, c: 2.4 }), ["b", "c", "a"])
    assertEquals(stableOrder(["b", "c", "a"], { a: 1, b: 2, c: 2.6 }), ["c", "b", "a"])
    assertEquals(stableOrder(["b", "c", "a"], { a: 1, c: 2, d: 9 }), ["d", "c", "a"])
    assertEquals(stableOrder(["b", "a"], { a: 0, b: 0 }), ["b", "a"])
})

Deno.test("the sample nearest a moment", () => {
    assertEquals([nearestIndex([], 5), nearestIndex([{ at: 0 }, { at: 1000 }, { at: 2000 }], 1400), nearestIndex([{ at: 0 }, { at: 1000 }], 9e9)], [-1, 1, 1])
})

Deno.test("a sample's stack: each slot's streams, the unslotted and the wire's remainder on top", () => {
    const slots = new Map([["a", 0], ["b", 1]])
    assertEquals(stackOf({ bytesPerSec: 1000, streams: { a: 100, b: 200, c: 50 } }, slots, 2), [100, 200, 700])
    assertEquals(stackOf({ bytesPerSec: null, streams: { a: 100 } }, slots, 2), [100, 0, 0])
})

Deno.test("the streams table: the short average's values in the long average's stable order; a stream gone quiet stays at 0", () => {
    const sample = (at: number, streams: Record<string, number>) => ({ at, bytesPerSec: null, latencyMs: null, streams })
    const samples = [sample(0, { a: 100, quiet: 900 }), sample(1000, { a: 100, b: 120 }), sample(2000, { a: 100, b: 120 })]
    assertEquals(streamTable(samples, [], 2, 3).map((row) => [row.key, row.bytesPerSec]), [["quiet", 0], ["a", 100], ["b", 120]])
    assertEquals(streamTable(samples, ["a", "b"], 2, 2).map((row) => row.key), ["a", "b"])
})
