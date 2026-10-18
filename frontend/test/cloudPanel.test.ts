// The 3D panel's point clouds (core/cloudQuality.ts, layers/pointcloud.tsx, LayerManager.setPaused): each cloud's
// bandwidth preset reaches the bridge as subscription options and is remembered per viewer; a preset change updates
// the subscription in place where the gateway can, else opens the new one before closing the old; the panel's off
// switch leaves nothing subscribed and on brings back exactly the clouds that were on.
import { assertEquals } from "jsr:@std/assert@1"
import { CLOUD_PRESETS, cloudOptions, cloudPreset, cloudQualities, cloudQualityOf, CloudStream, setCloudQuality } from "../src/core/cloudQuality.ts"
import { LayerManager } from "../src/core/layers/manager.ts"
import { Store } from "../src/core/store.ts"
import type { Connection, SubscribeOptions, Topic } from "../src/core/transport.ts"
import "../src/layers/pointcloud.tsx"

interface FakeSubscription {
    key: string
    options: SubscribeOptions
    open: boolean
    openBefore: number
    updates: Record<string, unknown>[]
    deliver: (message: unknown) => void
}

function fakeConnection({ inPlace }: { inPlace: boolean }) {
    const subscriptions: FakeSubscription[] = []
    const status = new Store<{ topics: Topic[] }>({ topics: [] })
    const connection = {
        status,
        subscribe(key: string, options: SubscribeOptions, onMessage: (message: unknown) => void) {
            const entry: FakeSubscription = { key, options, open: true, openBefore: subscriptions.filter((other) => other.open).length, updates: [], deliver: onMessage }
            subscriptions.push(entry)
            const stop = () => (entry.open = false)
            return inPlace ? Object.assign(stop, { update: (changes: Record<string, unknown>) => (entry.updates.push(changes), Promise.resolve()) }) : stop
        },
    }
    const open = () => subscriptions.filter((entry) => entry.open)
    return { connection: connection as unknown as Connection, subscriptions, status, open }
}

function fakeViewer() {
    const added = new Set<unknown>()
    return {
        added,
        viewer: {
            scene: { add: (object: unknown) => added.add(object), remove: (object: unknown) => added.delete(object) },
            onFrame: () => () => {},
            requestRender: () => {},
            noteData: () => {},
            pixelsPerMeter: { value: 100 },
            fixedFrame: "world",
        },
    }
}

const lidar: Topic = { key: "dimos/lidar/sensor_msgs.PointCloud2", name: "/lidar", type: "sensor_msgs.PointCloud2" }
const globalMap: Topic = { key: "dimos/global_map/sensor_msgs.PointCloud2", name: "/global_map", type: "sensor_msgs.PointCloud2" }
const cloudKeys = (subscriptions: FakeSubscription[]) => subscriptions.filter((entry) => entry.options.encoding === "dimos_lcm_pointcloud2").map((entry) => entry.key).sort()

Deno.test("each cloud keeps its own preset, per viewer, and Balanced is the default", () => {
    localStorage.clear()
    cloudQualities.set({})
    assertEquals(cloudQualityOf(lidar.key), "balanced")
    setCloudQuality(lidar.key, "low")
    setCloudQuality(globalMap.key, "full")
    assertEquals([cloudQualityOf(lidar.key), cloudQualityOf(globalMap.key)], ["low", "full"])
    assertEquals(JSON.parse(localStorage.getItem("lv.clouds.quality")!), { [lidar.key]: "low", [globalMap.key]: "full" })
    assertEquals(cloudPreset("nonsense").id, "balanced")
    // fewer points and scans as the preset goes down
    const [low, balanced, full] = CLOUD_PRESETS
    assertEquals(low.quality < balanced.quality && low.maxHz < balanced.maxHz && balanced.maxHz <= full.maxHz, true)
    assertEquals(cloudOptions(full).minQuality, 1, "Full is never thinned")
    assertEquals(cloudOptions(balanced).minQuality, undefined)
})

Deno.test("a preset change updates the running subscription in place when the gateway can", async () => {
    const { connection, subscriptions } = fakeConnection({ inPlace: true })
    const stream = new CloudStream(connection, lidar.key, "balanced", () => {})
    assertEquals(subscriptions[0].options, { delivery: "latest", encoding: "dimos_lcm_pointcloud2", maxHz: 20, encodeOptions: { quality: 1 } })
    await stream.setQuality("low")
    assertEquals(subscriptions.length, 1, "no resubscribe")
    assertEquals(subscriptions[0].updates, [{ maxHz: 5, minQuality: null, encodeOptions: { quality: 0.25 } }])
    await stream.setQuality("full")
    assertEquals(subscriptions[0].updates[1], { maxHz: 30, minQuality: 1, encodeOptions: { quality: 1 } })
    stream.close()
    assertEquals(subscriptions[0].open, false)
})

Deno.test("without in-place updates a preset change opens the new subscription before closing the old", async () => {
    const { connection, subscriptions } = fakeConnection({ inPlace: false })
    const stream = new CloudStream(connection, lidar.key, "balanced", () => {})
    await stream.setQuality("low")
    assertEquals(subscriptions.length, 2)
    assertEquals(subscriptions[1].openBefore, 1)
    assertEquals(subscriptions[0].open, false)
    assertEquals(subscriptions[1].options.maxHz, 5)
    assertEquals(subscriptions[1].options.encodeOptions, { quality: 0.25 })
})

Deno.test("a stream counts scans, points and bytes a second", () => {
    const { connection, subscriptions } = fakeConnection({ inPlace: true })
    let delivered = 0
    const stream = new CloudStream(connection, lidar.key, "balanced", () => delivered++, 0)
    for (let index = 0; index < 4; index++) {
        subscriptions[0].deliver({ decoded: { positions: new Float32Array(3000) }, bytes: new Uint8Array(500) })
    }
    assertEquals(delivered, 4)
    assertEquals(stream.sample(2000), { hz: 2, pointsPerSecond: 2000, bytesPerSecond: 1000 })
    assertEquals(stream.sample(3000), { hz: 0, pointsPerSecond: 0, bytesPerSecond: 0 })
})

Deno.test("off unsubscribes every cloud; on resubscribes only the clouds that were on, each at its preset", async () => {
    localStorage.clear()
    cloudQualities.set({})
    setCloudQuality(globalMap.key, "low")
    const { connection, status, open } = fakeConnection({ inPlace: true })
    const { viewer, added } = fakeViewer()
    const manager = new LayerManager(viewer as never, { lookup: () => null } as never, {} as never, connection, {} as never, {} as never)
    status.set({ topics: [lidar, globalMap] })
    assertEquals(cloudKeys(open()), [globalMap.key, lidar.key], "both clouds drawn, each subscribed")
    assertEquals(open().find((entry) => entry.key === globalMap.key && entry.options.encoding)!.options.maxHz, 5, "the map at its own preset")
    manager.setEnabled(lidar.key, false)
    assertEquals(cloudKeys(open()), [globalMap.key], "a cloud switched off is unsubscribed")

    manager.setPaused(true)
    assertEquals(open().length, 0, "off: nothing subscribed (no stream, no frame_id read)")
    assertEquals(added.size, 0, "and nothing in the scene")
    // a cloud showing up, or switched on, while off stays unsubscribed
    manager.setEnabled(lidar.key, true)
    status.set({ topics: [lidar, globalMap, { ...lidar, key: "dimos/terrain/sensor_msgs.PointCloud2", name: "/terrain" }] })
    assertEquals(open().length, 0)

    manager.setPaused(false)
    assertEquals(cloudKeys(open()), [globalMap.key, lidar.key, "dimos/terrain/sensor_msgs.PointCloud2"])
    await new Promise((resolve) => setTimeout(resolve, 0))
    manager.setPaused(true)
    assertEquals(open().length, 0)
})
