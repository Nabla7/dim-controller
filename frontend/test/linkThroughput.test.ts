// The link chip's throughput (core/transport.ts): wire bytes from the WebRTC transport, else the gateway's own count.
import { assertEquals } from "jsr:@std/assert@1"
import { throughputOf, transportBytesReceived } from "../src/core/transport.ts"

const fakePeer = (stats: Record<string, unknown>[], connectionState = "connected") =>
    ({ connectionState, getStats: async () => new Map(stats.map((stat, index) => [String(index), stat])) }) as unknown as RTCPeerConnection

Deno.test("wire bytes are the transport's bytesReceived (the largest, if several); none without a live peer", async () => {
    assertEquals(await transportBytesReceived(fakePeer([{ type: "transport", bytesReceived: 1200 }, { type: "inbound-rtp", bytesReceived: 900 }, { type: "transport", bytesReceived: 1500 }])), 1500)
    assertEquals(await transportBytesReceived(fakePeer([{ type: "inbound-rtp", bytesReceived: 900 }])), null)
    assertEquals(await transportBytesReceived(fakePeer([{ type: "transport", bytesReceived: 1 }], "closed")), null)
    assertEquals(await transportBytesReceived(null), null)
})

Deno.test("the gateway's count is its delivered data plus the video it sent", () => {
    assertEquals(throughputOf({ bandwidth: { deliveredBytesPerSec: 1000, videoSentBytesPerSec: 500 } }), 1500)
    assertEquals(throughputOf({ bandwidth: {} }), null)
})
