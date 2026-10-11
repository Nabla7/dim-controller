// The clicked_point the 3D view's menu publishes: the key and bytes dimos's nav stack reads.
import { assertEquals } from "jsr:@std/assert@1"
import { decode } from "../src/lcm.ts"
import { clickedPoint } from "../src/logic/clickedPoint.ts"

Deno.test("clicked_point is a PointStamped on dimos/clicked_point", () => {
    const { key, bytes } = clickedPoint({ x: 1.5, y: -2.25, z: 0.1 }, "world", 1_700_000_123_456)
    assertEquals(key, "dimos/clicked_point/geometry_msgs.PointStamped")
    const message = decode("geometry_msgs.PointStamped", bytes)
    assertEquals(message.header.frame_id, "world")
    assertEquals(message.header.stamp, { sec: 1_700_000_123, nsec: 456_000_000 })
    assertEquals(message.point, { x: 1.5, y: -2.25, z: 0.1 })
})
