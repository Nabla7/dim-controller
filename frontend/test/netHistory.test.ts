// The Network panel's history (core/netHistory.ts): a ring of samples, the wire's parts from the page's WebRTC stats,
// and who's using the link.
import { assertEquals } from "jsr:@std/assert@1"
import { assignSlots, breakdown, CONTROL, HEARTBEAT, NetHistory, OTHER, partRates, RESENT, Ring, RTP_HEADERS, wireCounts } from "../src/core/netHistory.ts"


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
