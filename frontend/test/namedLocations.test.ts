// dimos's NamedLocations wire contract (dimos/navigation/named_locations/module.py): its snapshot read as labels, and
// the set, delete, request and go to the page sends.
import { assertEquals } from "jsr:@std/assert@1"
import { decode } from "../src/core/lcm/lcm.ts"
import { Store } from "../src/core/store.ts"
import type { Connection } from "../src/core/transport.ts"
import { DELETE_KEY, GO_TO_KEY, NamedLocations, REQUEST_KEY, SET_KEY, setBytes, SNAPSHOT_KEY, snapshotLabels, stringBytes, UPDATE_TYPE } from "../src/core/namedLocations.ts"

// dimos's own encoding of a snapshot: InteractiveMarkerUpdate([named_pose("kitchen", PoseStamped(ts=1700000000.5,
// frame_id="map", position=[1, 2, 0], orientation=[0, 0, 0.7071067811865476, 0.7071067811865476])), named_pose("dock",
// PoseStamped(ts=1700000001.0, frame_id="map", position=[-3.5, 0.25, 0.1]))], server_id="NamedLocations", seq_num=7).lcm_encode()
const DIMOS_SNAPSHOT = "e498190e0276d93d0000000000000002000000000000000f4e616d65644c6f636174696f6e7300000000000000000701000000016553f1001dcd6500000000046d6170003ff000000000000040000000000000000000000000000000000000000000000000000000000000003fe6a09e667f3bcd3fe6a09e667f3bcd000000086b69746368656e00000000016553f10100000000000000046d617000c00c0000000000003fd00000000000003fb999999999999a0000000000000000000000000000000000000000000000003ff000000000000000000005646f636b00"
const hex = (text: string) => new Uint8Array(text.match(/../g)!.map((pair) => parseInt(pair, 16)))

Deno.test("the module's topics", () => {
    assertEquals(SNAPSHOT_KEY, "dimos/location_labels/visualization_msgs.InteractiveMarkerUpdate")
    assertEquals(SET_KEY, "dimos/set_location_label/visualization_msgs.InteractiveMarkerUpdate")
    assertEquals(DELETE_KEY, "dimos/delete_location_label/std_msgs.String")
    assertEquals(REQUEST_KEY, "dimos/location_labels_request/std_msgs.String")
    assertEquals(GO_TO_KEY, "dimos/go_to_location_label/std_msgs.String")
})

Deno.test("a dimos snapshot reads as labels keyed by name, in map", () => {
    const labels = snapshotLabels(hex(DIMOS_SNAPSHOT))
    assertEquals(labels.map((label) => [label.id, label.label, label.frame_id]), [["kitchen", "kitchen", "map"], ["dock", "dock", "map"]])
    assertEquals(labels[0].position, [1, 2, 0])
    assertEquals(labels[0].orientation, [0, 0, 0.7071067811865476, 0.7071067811865476])
    assertEquals(labels[1].position, [-3.5, 0.25, 0.1])
    assertEquals(labels[0].created, 1_700_000_000.5e9)
})

Deno.test("an empty snapshot is an empty list (the module is there)", () => {
    assertEquals(snapshotLabels(setBytes([])), [])
})

Deno.test("a set carries poses only, stamped, in the frame given", () => {
    const bytes = setBytes([{ label: "galley", frame_id: "odom", position: [1, 2, 0], orientation: [0, 0, 0, 1] }], 1_700_000_123_456)
    assertEquals(Array.from(bytes.slice(0, 8)), Array.from(hex(DIMOS_SNAPSHOT).slice(0, 8)), "dimos's fingerprint")
    const update = decode(UPDATE_TYPE, bytes)
    assertEquals([update.erases, update.markers, update.poses.length], [[], [], 1])
    const [pose] = update.poses
    assertEquals(pose.name, "galley")
    assertEquals(pose.header.frame_id, "odom")
    assertEquals(pose.header.stamp, { sec: 1_700_000_123, nsec: 456_000_000 })
    assertEquals(pose.pose.position, { x: 1, y: 2, z: 0 })
    assertEquals(pose.pose.orientation, { x: 0, y: 0, z: 0, w: 1 })
})

Deno.test("a rename sets the new name at the same pose, then deletes the old; delete and go to are names", async () => {
    const sent: { key: string; bytes: Uint8Array }[] = []
    const client = { state: "connected", put: (key: string, bytes: Uint8Array) => (sent.push({ key, bytes }), Promise.resolve()) }
    const connection = { client, status: new Store({ state: "connecting" }), subscribe: () => Object.assign(() => {}, { ready: () => Promise.resolve() }), command: () => {} } as unknown as Connection
    const named = new NamedLocations(connection)
    await named.rename({ label: "kitchen", frame_id: "map", position: [1, 2, 0], orientation: [0, 0, 0, 1] }, "galley")
    await named.goTo("galley")
    assertEquals(sent.map((one) => one.key), [SET_KEY, DELETE_KEY, GO_TO_KEY])
    const set = decode(UPDATE_TYPE, sent[0].bytes)
    assertEquals([set.poses[0].name, set.poses[0].header.frame_id, set.poses[0].pose.position], ["galley", "map", { x: 1, y: 2, z: 0 }])
    assertEquals(decode("std_msgs.String", sent[1].bytes).data, "kitchen")
    assertEquals(decode("std_msgs.String", sent[2].bytes).data, "galley")
})

Deno.test("each connect asks for the snapshot", async () => {
    const sent: string[] = []
    const status = new Store({ state: "connecting" })
    const client = { state: "connected", put: (key: string) => (sent.push(key), Promise.resolve()) }
    const connection = { client, status, subscribe: () => Object.assign(() => {}, { ready: () => Promise.resolve() }), command: () => {} } as unknown as Connection
    new NamedLocations(connection)
    status.set({ state: "connected" })
    status.set({ state: "lost" })
    status.set({ state: "connected" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assertEquals(sent, [REQUEST_KEY, REQUEST_KEY])
})

Deno.test("strings are std_msgs.String", () => {
    assertEquals(decode("std_msgs.String", stringBytes("kitchen")).data, "kitchen")
})
