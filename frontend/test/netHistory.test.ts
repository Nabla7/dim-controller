// The Network panel's history (core/netHistory.ts): a ring of samples, each stream's rate from the gateway's bytesSent,
// and who's using the link.
import { assertEquals } from "jsr:@std/assert@1"
import { assignSlots, breakdown, NetHistory, OTHER, Ring, STREAM_STALE_MS, streamRates } from "../src/core/netHistory.ts"

const sub = (id: number | null, key: string, bytesSent: number, type = "sub") => ({ id, type, key, stats: { bytesSent } })

Deno.test("the ring keeps the newest items, oldest first", () => {
    const ring = new Ring<number>(3)
    assertEquals([ring.toArray(), ring.last()], [[], undefined])
    for (const n of [1, 2, 3, 4, 5]) {
        ring.push(n)
    }
    assertEquals([ring.toArray(), ring.length, ring.last()], [[3, 4, 5], 3, 5])
})

Deno.test("a stream's rate is its bytesSent growth between two stats replies, summed per key; new, reset or publisher channels have none", () => {
    const before = new Map([[1, 1000], [2, 500], [3, 9000], [4, 0]])
    const channels = [sub(1, "dimos/lidar/x.Y", 3000), sub(2, "dimos/lidar/x.Y", 1500), sub(3, "dimos/cam/a.B", 100), sub(4, "dimos/cmd/a.B", 800, "pub"), sub(5, "dimos/new/a.B", 70)]
    assertEquals(streamRates(before, channels, 500), { "dimos/lidar/x.Y": 6000 })
    assertEquals(streamRates(null, channels, 500), {})
})

Deno.test("who's using the link: largest first, shares of the wire, the rest of the wire as other", () => {
    assertEquals(breakdown({ bytesPerSec: 1000, streams: { a: 200, b: 600 } }), [
        { key: "b", bytesPerSec: 600, share: 0.6 },
        { key: "a", bytesPerSec: 200, share: 0.2 },
        { key: OTHER, bytesPerSec: 200, share: 0.2 },
    ])
    // the gateway's count ahead of the wire sample: shares of the streams' sum, no other
    assertEquals(breakdown({ bytesPerSec: 500, streams: { a: 1000 } }), [{ key: "a", bytesPerSec: 1000, share: 1 }])
    assertEquals(breakdown({ bytesPerSec: null, streams: {} }), [])
})

Deno.test("history samples carry the latest stream rates, dropped once the stats go stale", () => {
    const history = new NetHistory(10)
    history.recordStats([sub(1, "a", 0)], 0)
    history.recordStats([sub(1, "a", 2000)], 1000)
    history.sample(1500, 2500, 40)
    history.sample(1000 + STREAM_STALE_MS + 1, 2500, 40)
    assertEquals(history.samples.toArray().map((sample) => sample.streams), [{ a: 2000 }, {}])
    assertEquals(history.samples.last()?.latencyMs, 40)
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
