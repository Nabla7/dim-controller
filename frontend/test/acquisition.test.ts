import { assertEquals } from "jsr:@std/assert@1"
import { AcquisitionOrder, acquisitionMs } from "../src/core/acquisition.ts"
import { VideoSources } from "../src/core/video.ts"
import { CloudStream } from "../src/core/cloudQuality.ts"
import type { Connection, Message, SubscribeOptions } from "../src/core/transport.ts"

Deno.test("a delayed old epoch or retired clock cannot restore pre-reset data", () => {
    const order = new AcquisitionOrder()
    const h = { clock_id: "first", epoch: 0n, time_ns: 100n }
    assertEquals(order.accept(h), true)
    assertEquals(order.accept({ ...h, epoch: 1n, time_ns: 0n }), true)
    assertEquals(order.accept(h), false)
    assertEquals(order.accept({ ...h, clock_id: "second", time_ns: 0n }), true)
    assertEquals(order.accept({ ...h, epoch: 2n }), false)
    assertEquals(acquisitionMs({ ...h, time_ns: 0n }), 0)
})

Deno.test("acquisition images use the existing video and lossless depth codecs", () => {
    for (const isDepth of [true, false]) {
        let options: SubscribeOptions | undefined, receive: ((m: Message) => void) | undefined, stopped = false
        const connection = { subscribe: (_key: string, o: SubscribeOptions, callback: (m: Message) => void) => {
            options = o; receive = callback; return () => { stopped = true }
        } } as unknown as Connection
        const sources = new VideoSources(connection)
        const name = isDepth ? "depth_image" : "color_image"
        const topic = { key: `dimos/${name}/sensor_msgs.Image`, name: `/${name}`, type: "sensor_msgs.Image" }
        const source = sources.acquire(topic)
        assertEquals(options?.encoding, isDepth ? "dimos_lcm_depth" : "dimos_lcm_image")
        const header = { stamp: 0, sec: 0, nanosec: 0, frameId: "g1/camera", acquisition: {
            clock_id: "sim-proof", epoch: 3n, time_ns: 0n, source_id: "camera", sequence: 7n,
        } }
        receive!({ key: topic.key, kind: "put", bytes: new Uint8Array(), seq: 0, timestamp: 99999, header,
            decoded: isDepth ? { width: 2, height: 1, encoding: "32FC1", data: new Float32Array([1.5, 2.5]) } : undefined,
        })
        assertEquals(source.frame.get().frameId, "g1/camera")
        if (isDepth) assertEquals([...source.depth.get().image!.data], [1.5, 2.5])
        sources.release(topic)
        assertEquals(stopped, true)
    }
})

Deno.test("cloud codec output keeps its acquisition header for TF placement and reset handling", () => {
    let options: SubscribeOptions | undefined, receive: ((m: Message) => void) | undefined, seen: Message | undefined
    const connection = { subscribe: (_key: string, o: SubscribeOptions, callback: (m: Message) => void) => {
        options = o; receive = callback; return () => {}
    } } as unknown as Connection
    const cloud = new CloudStream(connection, "dimos/global_map/sensor_msgs.PointCloud2", "balanced", m => { seen = m })
    assertEquals(options?.encoding, "dimos_lcm_pointcloud2")
    const message: Message = { key: "dimos/global_map/sensor_msgs.PointCloud2", kind: "put", bytes: new Uint8Array(), seq: 0, timestamp: 99999,
        header: { stamp: 0, sec: 0, nanosec: 0, frameId: "world", acquisition: { clock_id: "sim-proof", epoch: 3n, time_ns: 0n, source_id: "mid360", sequence: 7n } },
        decoded: { positions: new Float32Array([1, 2, 3]) },
    }
    receive!(message)
    assertEquals(seen, message)
    assertEquals(seen!.header!.acquisition!.epoch, 3n)
    cloud.close()
})
