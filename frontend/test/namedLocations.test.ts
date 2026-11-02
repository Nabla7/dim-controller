// dimos's NamedLocations wire contract (dimos/navigation/named_locations/module.py): its snapshot read as labels, and
// the whole lists, request and go to the page sends.
import { assertEquals } from "jsr:@std/assert@1"
import { decode } from "../src/core/lcm/lcm.ts"
import { GO_TO_KEY, listBytes, NamedLocations, type NamedPose, renamedLocation, REQUEST_KEY, SNAPSHOT_KEY, snapshotLabels, stringBytes, UPDATE_TYPE, withLocation, withoutLocation } from "../src/core/namedLocations.ts"
import { Store } from "../src/core/store.ts"
import type { Connection } from "../src/core/transport.ts"

// dimos's own encoding of a snapshot: InteractiveMarkerUpdate([named_pose("kitchen", PoseStamped(ts=1700000000.5,
// frame_id="map", position=[1, 2, 0], orientation=[0, 0, 0.7071067811865476, 0.7071067811865476])), named_pose("dock",
// PoseStamped(ts=1700000001.0, frame_id="map", position=[-3.5, 0.25, 0.1]))], server_id="NamedLocations", seq_num=7).lcm_encode()
const DIMOS_SNAPSHOT = "e498190e0276d93d0000000000000002000000000000000f4e616d65644c6f636174696f6e7300000000000000000701000000016553f1001dcd6500000000046d6170003ff000000000000040000000000000000000000000000000000000000000000000000000000000003fe6a09e667f3bcd3fe6a09e667f3bcd000000086b69746368656e00000000016553f10100000000000000046d617000c00c0000000000003fd00000000000003fb999999999999a0000000000000000000000000000000000000000000000003ff000000000000000000005646f636b00"
const hex = (text: string) => new Uint8Array(text.match(/../g)!.map((pair) => parseInt(pair, 16)))

const at = (label: string, x: number): NamedPose => ({ label, frame_id: "map", position: [x, 0, 0], orientation: [0, 0, 0, 1] })
const names = (list: NamedPose[]) => list.map((one) => [one.label, one.position[0]])

/** A connection whose puts are recorded and whose /named_locations subscription the test feeds. */
function fakeConnection() {
    const sent: { key: string; bytes: Uint8Array }[] = []
    const status = new Store({ state: "connecting" })
    let deliver: (message: { bytes: Uint8Array }) => void = () => {}
    const client = { state: "connected", put: (key: string, bytes: Uint8Array) => (sent.push({ key, bytes }), Promise.resolve()) }
    const connection = {
        client,
        status,
        command: () => {},
        subscribe: (_key: string, _options: unknown, onMessage: typeof deliver) => {
            deliver = onMessage
            return Object.assign(() => {}, { ready: () => Promise.resolve() })
        },
    } as unknown as Connection
    return { connection, sent, status, deliver: (bytes: Uint8Array) => deliver({ bytes }) }
}

Deno.test("the module's topics", () => {
    assertEquals(SNAPSHOT_KEY, "dimos/named_locations/visualization_msgs.InteractiveMarkerUpdate")
    assertEquals(REQUEST_KEY, "dimos/named_locations_request/std_msgs.String")
    assertEquals(GO_TO_KEY, "dimos/go_to_named_location/std_msgs.String")
})

Deno.test("a dimos list reads as labels keyed by name, in map", () => {
    const labels = snapshotLabels(hex(DIMOS_SNAPSHOT))
    assertEquals(labels.map((label) => [label.id, label.label, label.frame_id]), [["kitchen", "kitchen", "map"], ["dock", "dock", "map"]])
    assertEquals(labels[0].position, [1, 2, 0])
    assertEquals(labels[0].orientation, [0, 0, 0.7071067811865476, 0.7071067811865476])
    assertEquals(labels[1].position, [-3.5, 0.25, 0.1])
    assertEquals(labels[0].created, 1_700_000_000.5e9)
})

Deno.test("an empty list is an empty list (the module is there)", () => {
    assertEquals(snapshotLabels(listBytes([])), [])
})

Deno.test("a published list is the whole list, poses only, stamped", () => {
    const bytes = listBytes([at("galley", 1), at("dock", 2)], 1_700_000_123_456)
    assertEquals(Array.from(bytes.slice(0, 8)), Array.from(hex(DIMOS_SNAPSHOT).slice(0, 8)), "dimos's fingerprint")
    const update = decode(UPDATE_TYPE, bytes)
    assertEquals([update.erases, update.markers], [[], []])
    // deno-lint-ignore no-explicit-any
    assertEquals(update.poses.map((pose: any) => [pose.name, pose.header.frame_id, pose.pose.position.x]), [["galley", "map", 1], ["dock", "map", 2]])
    assertEquals(update.poses[0].header.stamp, { sec: 1_700_000_123, nsec: 456_000_000 })
    assertEquals(update.poses[0].pose.orientation, { x: 0, y: 0, z: 0, w: 1 })
})

Deno.test("add, move, rename and delete are new whole lists, in order", () => {
    const list = [at("kitchen", 1), at("dock", 2)]
    assertEquals(names(withLocation(list, at("hall", 3))), [["kitchen", 1], ["dock", 2], ["hall", 3]])
    assertEquals(names(withLocation(list, at("kitchen", 5))), [["kitchen", 5], ["dock", 2]])
    assertEquals(names(renamedLocation(list, "kitchen", "galley")), [["galley", 1], ["dock", 2]])
    assertEquals(names(withoutLocation(list, "dock")), [["kitchen", 1]])
})

Deno.test("the page draws the latest list heard (its own included) and publishes whole lists on the one topic", async () => {
    const fake = fakeConnection()
    const named = new NamedLocations(fake.connection)
    assertEquals(named.state.get().locations, null, "no module yet")
    fake.deliver(listBytes([at("kitchen", 1)]))
    await named.publish(renamedLocation(named.current, "kitchen", "galley"))
    assertEquals(named.current.map((one) => one.label), ["kitchen"], "drawn only once it comes back on the topic")
    assertEquals(fake.sent.map((one) => one.key), [SNAPSHOT_KEY])
    fake.deliver(fake.sent[0].bytes)
    assertEquals(named.current.map((one) => one.label), ["galley"])
    await named.goTo("galley")
    assertEquals([fake.sent[1].key, decode("std_msgs.String", fake.sent[1].bytes).data], [GO_TO_KEY, "galley"])
})

Deno.test("each connect asks for the list", async () => {
    const fake = fakeConnection()
    new NamedLocations(fake.connection)
    fake.status.set({ state: "connected" })
    fake.status.set({ state: "lost" })
    fake.status.set({ state: "connected" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assertEquals(fake.sent.map((one) => one.key), [REQUEST_KEY, REQUEST_KEY])
})

Deno.test("strings are std_msgs.String", () => {
    assertEquals(decode("std_msgs.String", stringBytes("kitchen")).data, "kitchen")
})
