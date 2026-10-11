// Fixtures in fixtures/lcm.json are dimos's own lcm_encode() output (made with the dimos venv).
import { assertAlmostEquals, assertEquals, assertThrows } from "jsr:@std/assert@1"
import { decode, encode, fingerprint, headerFrameId } from "../src/lcm.ts"
import fixtures from "./fixtures/lcm.json" with { type: "json" }

const bytes = (type: keyof typeof fixtures) => Uint8Array.from(atob(fixtures[type]), (char) => char.charCodeAt(0))
const hex = (data: Uint8Array) => [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("")

Deno.test("fingerprints match dimos's", () => {
    for (const type of Object.keys(fixtures) as (keyof typeof fixtures)[]) {
        assertEquals(hex(fingerprint(type)), hex(bytes(type).subarray(0, 8)), type)
    }
})

Deno.test("encode reproduces dimos's Twist bytes", () => {
    const twist = { linear: { x: 0.5, y: -0.25, z: 0 }, angular: { x: 0, y: 0, z: 1 } }
    assertEquals(hex(encode("geometry_msgs.Twist", twist)), hex(bytes("geometry_msgs.Twist")))
})

Deno.test("decodes stamped, nested and variable-length messages", () => {
    const odom = decode("nav_msgs.Odometry", bytes("nav_msgs.Odometry"))
    assertEquals(odom.header.frame_id, "odom")
    assertEquals(odom.child_frame_id, "base_link")
    assertEquals([odom.pose.pose.position.x, odom.pose.pose.position.y, odom.pose.pose.position.z], [4, 5, 6])
    const tf = decode("tf2_msgs.TFMessage", bytes("tf2_msgs.TFMessage"))
    assertEquals(tf.transforms[0].child_frame_id, "base_link")
    assertAlmostEquals(tf.transforms[0].transform.translation.z, 0.3)
    const path = decode("nav_msgs.Path", bytes("nav_msgs.Path"))
    assertEquals(path.poses.map((pose: { pose: { position: { x: number } } }) => pose.pose.position.x), [0, 1, 2])
    const info = decode("sensor_msgs.CameraInfo", bytes("sensor_msgs.CameraInfo"))
    assertEquals([info.width, info.height, info.K[0], info.K[2]], [640, 480, 500, 320])
    const marker = decode("visualization_msgs.Marker", bytes("visualization_msgs.Marker"))
    assertEquals([marker.text, marker.id, marker.type, marker.points[0].z], ["hello", 7, 9, 3])
})

Deno.test("another type's bytes are refused", () => {
    assertThrows(() => decode("nav_msgs.Path", bytes("nav_msgs.Odometry")), Error, "fingerprint")
})

Deno.test("headerFrameId reads only the header", () => {
    assertEquals(headerFrameId("geometry_msgs.PoseStamped", bytes("geometry_msgs.PoseStamped")), "map")
    assertEquals(headerFrameId("sensor_msgs.CameraInfo", bytes("sensor_msgs.CameraInfo")), "camera_optical")
})

Deno.test("encode/decode round trip", () => {
    const value = { header: { frame_id: "base_link", stamp: { sec: 3, nsec: 4 } }, point: { x: 1, y: 2, z: 3 } }
    const decoded = decode("geometry_msgs.PointStamped", encode("geometry_msgs.PointStamped", value))
    assertEquals(decoded.header.frame_id, "base_link")
    assertEquals(decoded.point, { x: 1, y: 2, z: 3 })
})
