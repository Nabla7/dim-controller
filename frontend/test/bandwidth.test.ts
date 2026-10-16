// Network → Bandwidth Consumers (core/bandwidth.ts, core/transport.ts's LiveSubscription): this viewer's per-stream
// overrides go on top of the app's options; a pause closes the gateway subscription and a resume opens it again; what
// the gateway changes in place goes as an update, the rest (delivery) as a new subscription.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { applyOverride, defaultBandwidthPriority, heatOf, isVideoOptions, levelOf, migrateOverrides, normalizeOverride, optionDiff, patchOverrides, PRIORITY_LAST, priorityLabel, stepPriority, withChanges } from "../src/core/bandwidth.ts"
import { LiveSubscription, type SubscribeOptions, type SubscriptionUpdate } from "../src/core/transport.ts"
import { streamTable } from "../src/core/netHistory.ts"

Deno.test("an override goes on top of the app's options; delivery only off video, maxBitrate only on it", () => {
    const camera: SubscribeOptions = { delivery: "latest", encoding: "dimos_lcm_image", maxResolution: [640, 360] }
    assert(isVideoOptions(camera))
    assert(!isVideoOptions({ encoding: "dimos_lcm_depth" }))
    assert(isVideoOptions({}, "video-h264"))
    assertEquals(applyOverride(camera, { paused: true, priorityOffset: 2, delivery: "reliable", maxBitrate: 2e6 }), { ...camera, bandwidthPriority: 4, maxBitrate: 2e6 })
    assertEquals(applyOverride({ delivery: "latest", maxHz: 2 }, { delivery: "reliable", maxBitrate: 2e6, maxHz: 10, qualityToHzTradeoff: 0 }), { delivery: "reliable", maxHz: 10, qualityToHzTradeoff: 0 })
    assertEquals(applyOverride({ maxHz: 2 }, undefined), { maxHz: 2 })
})

Deno.test("what changes in place is an update (null back to the default); delivery or encoding takes a new subscription", () => {
    assertEquals(optionDiff({ maxHz: 2, bandwidthPriority: 4 }, { maxHz: 5 }), { update: { maxHz: 5, bandwidthPriority: null }, resubscribe: false })
    assertEquals(optionDiff({ delivery: "latest" }, { delivery: "reliable" }).resubscribe, true)
    assertEquals(optionDiff({ encoding: "a" }, { encoding: "b" }).resubscribe, true)
    assertEquals(optionDiff({ encodeOptions: { quality: 1 } }, { encodeOptions: { quality: 0.25 } }), { update: { encodeOptions: { quality: 0.25 } }, resubscribe: false })
    assertEquals(optionDiff({ maxResolution: [640, 360] }, { maxResolution: [640, 360] }), { update: {}, resubscribe: false })
    assertEquals(withChanges({ maxHz: 2, encodeOptions: { quality: 1 } }, { maxHz: null, encodeOptions: { quality: 0.5 } }), { encodeOptions: { quality: 0.5 } })
})

Deno.test("a priority offset is levels on top of the page's own priority: +1 doubles it, last gives up first", () => {
    assertEquals([stepPriority(0, 1), stepPriority(0, -1), stepPriority(3, 1), stepPriority(PRIORITY_LAST, -1)], [1, -1, 3, PRIORITY_LAST])
    assertEquals([PRIORITY_LAST, -2, 0, 1, 3].map(priorityLabel), ["last", "-2", "0", "+1", "+3"])
    // the main camera (the default 1) at +1 runs at 2; a side camera (0.5) at +1 runs at the main camera's 1
    assertEquals(applyOverride({ bandwidthPriority: 1 }, { priorityOffset: 1 }).bandwidthPriority, 2)
    assertEquals(applyOverride({ bandwidthPriority: 0.5 }, { priorityOffset: 1 }).bandwidthPriority, 1)
    assertEquals(applyOverride({}, { priorityOffset: PRIORITY_LAST }).bandwidthPriority, 0)
    assertEquals([levelOf(0), levelOf(0.25), levelOf(4)], [PRIORITY_LAST, -2, 2])
    // saved before offsets: an absolute priority becomes levels from the default
    assertEquals(migrateOverrides({ a: { bandwidthPriority: 2, maxHz: 3 }, b: { bandwidthPriority: 1 } }), { a: { maxHz: 3, priorityOffset: 1 } })
})

Deno.test("streams the page sets no priority for: small state above the default, maps below", () => {
    assertEquals(["sensor_msgs.JointState", "nav_msgs.Odometry", "geometry_msgs.PoseStamped", "nav_msgs.OccupancyGrid", "sensor_msgs.PointCloud2"].map(defaultBandwidthPriority), [4, 4, 4, 0.25, undefined])
})

Deno.test("overrides drop unset fields and empty streams; heat is against the busiest", () => {
    assertEquals(normalizeOverride({ paused: false, maxHz: undefined }), null)
    let overrides = patchOverrides({}, "k", { paused: true })
    assertEquals(overrides, { k: { paused: true } })
    overrides = patchOverrides(overrides, "k", { priorityOffset: 1 })
    assertEquals(overrides, { k: { paused: true, priorityOffset: 1 } })
    overrides = patchOverrides(overrides, "k", { paused: undefined, priorityOffset: 0 })
    assertEquals(overrides, {})
    assertEquals(patchOverrides({ k: { maxHz: 3 } }, "k", null), {})
    assertEquals([heatOf(0, 10), heatOf(10, 10), heatOf(2.5, 10), heatOf(20, 10), heatOf(5, 0)], [0, 1, 0.5, 1, 0])
})

Deno.test("the table lists every subscription and paused stream, at 0 without traffic, below the busy ones", () => {
    const samples = Array.from({ length: 10 }, (_, index) => ({ at: index * 1000, bytesPerSec: 1000, latencyMs: 5, streams: { "dimos/a/x.Y": 800 } }))
    const rows = streamTable(samples, [], 10, 60, ["dimos/paused/x.Y", "dimos/a/x.Y"])
    assertEquals(rows.map((row) => [row.key, Math.round(row.bytesPerSec)]), [["dimos/a/x.Y", 800], ["other", 200], ["dimos/paused/x.Y", 0]])
})

/** A gateway client whose subscriptions the test sees: opened, closed and every update. */
function fakeClient({ refuseUpdates = false } = {}) {
    const opened: { options: SubscribeOptions; updates: SubscriptionUpdate[]; closed: boolean }[] = []
    const client = {
        subscribe(_key: string, options: SubscribeOptions) {
            const record = { options, updates: [] as SubscriptionUpdate[], closed: false }
            opened.push(record)
            return {
                channelName: isVideoOptions(options) ? "video-h264" : "data",
                state: "open",
                rejectionReason: null,
                ready: () => Promise.resolve(),
                update: (changes: SubscriptionUpdate) => {
                    record.updates.push(changes)
                    return refuseUpdates ? Promise.reject(new Error("no updates")) : Promise.resolve()
                },
                close: () => (record.closed = true),
            }
        },
    }
    return { client: client as never, opened }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

Deno.test("a pause closes the gateway subscription and a resume opens it again, with the override", async () => {
    const { client, opened } = fakeClient()
    const subscription = new LiveSubscription("dimos/lidar/sensor_msgs.PointCloud2", { delivery: "latest", maxHz: 1 }, () => {}, () => {}, () => client)
    subscription.open(client)
    assertEquals(opened.length, 1)
    subscription.setOverride({ paused: true, priorityOffset: 1 })
    await settle()
    assert(opened[0].closed && !subscription.isOpen)
    subscription.setOverride({ priorityOffset: 1 })
    await settle()
    assertEquals(opened.length, 2)
    assertEquals(opened[1].options, { delivery: "latest", maxHz: 1, bandwidthPriority: 2 })
})

Deno.test("a paused key never opens (also when the connection opens it), and waits for the lease gate on resume", async () => {
    const { client, opened } = fakeClient()
    let gate: unknown = null
    const subscription = new LiveSubscription("dimos/color_image/sensor_msgs.Image", { delivery: "latest", encoding: "dimos_lcm_image" }, () => {}, () => {}, () => gate as never, { paused: true })
    subscription.open(client)
    assertEquals(opened.length, 0)
    subscription.setOverride(undefined)
    await settle()
    assertEquals(opened.length, 0)
    gate = client
    subscription.open(client)
    assertEquals(opened.length, 1)
})

Deno.test("priority and tradeoff change in place; delivery resubscribes; a refused update resubscribes", async () => {
    const { client, opened } = fakeClient()
    const subscription = new LiveSubscription("dimos/tf/tf2_msgs.TFMessage", { delivery: "reliable" }, () => {}, () => {}, () => client)
    subscription.open(client)
    subscription.setOverride({ priorityOffset: 2, qualityToHzTradeoff: 0 })
    await settle()
    assertEquals(opened[0].updates, [{ bandwidthPriority: 4, qualityToHzTradeoff: 0 }])
    subscription.setOverride({ priorityOffset: 2, qualityToHzTradeoff: 0, delivery: "latest" })
    await settle()
    assert(opened[0].closed)
    assertEquals(opened[1].options, { delivery: "latest", bandwidthPriority: 4, qualityToHzTradeoff: 0 })
    subscription.setOverride(undefined)
    await settle()
    assertEquals(opened[2].options, { delivery: "reliable" })

    const refusing = fakeClient({ refuseUpdates: true })
    const other = new LiveSubscription("dimos/x/a.B", { maxHz: 1 }, () => {}, () => {}, () => refusing.client)
    other.open(refusing.client)
    other.setOverride({ maxHz: 5 })
    await settle()
    assertEquals(refusing.opened.length, 2)
    assertEquals(refusing.opened[1].options, { maxHz: 5 })
})

Deno.test("the app's own changes keep the override on top (a preset dropping maxBitrate doesn't drop the viewer's)", async () => {
    const { client, opened } = fakeClient()
    const subscription = new LiveSubscription("dimos/color_image/sensor_msgs.Image", { delivery: "latest", encoding: "dimos_lcm_image", maxBitrate: 6e6, qualityToHzTradeoff: 0 }, () => {}, () => {}, () => client, { maxBitrate: 1e6 })
    subscription.open(client)
    assertEquals(opened[0].options.maxBitrate, 1e6)
    await subscription.update({ maxBitrate: null, qualityToHzTradeoff: null, maxResolution: [640, 360] })
    assertEquals(opened[0].updates, [{ qualityToHzTradeoff: null, maxResolution: [640, 360] }])
    assertEquals(subscription.base, { delivery: "latest", encoding: "dimos_lcm_image", maxResolution: [640, 360] })
})
