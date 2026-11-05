import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { TfTree, type Viewer } from "dimos-react/three"
import { Vector3 } from "three"
import { decode, encode } from "../src/core/lcm/lcm.ts"
import { Store } from "../src/core/store.ts"
import { feedTf } from "../src/core/tfFeed.ts"
import { TfHistory } from "../src/core/tfHistory.ts"
import type { Connection, Message, SubscribeOptions } from "../src/core/transport.ts"
import fixtures from "./fixtures/lcm.json" with { type: "json" }

Deno.test("DimOS standard-header TF bytes populate the live tree and update its history", () => {
    const topic = { key: "dimos/tf/tf2_msgs.TFMessage", name: "/tf", type: "tf2_msgs.TFMessage" }
    let receive: ((message: Message) => void) | undefined
    const connection = {
        status: new Store({ topics: [topic] }),
        subscribe(key: string, options: SubscribeOptions, callback: (message: Message) => void) {
            assertEquals(key, topic.key)
            assertEquals(options.delivery, "reliable")
            receive = callback
            return () => {}
        },
    } as unknown as Connection
    const tree = new TfTree()
    const history = new TfHistory(tree)
    const arrivals: number[] = []
    const viewer = { noteData: (stamp: number) => arrivals.push(stamp) } as unknown as Viewer
    feedTf(connection, tree, viewer, history)

    // The fixture was encoded by Python's DimOS TFMessage, not this decoder.
    const bytes = Uint8Array.from(atob(fixtures[topic.type as keyof typeof fixtures]), char => char.charCodeAt(0))
    const message: Message = { key: topic.key, kind: "put", bytes, timestamp: 1000, seq: 1 }
    receive!(message)
    assert(tree.has("base_link"), "standard TF must not be silently discarded")
    assertAlmostEquals(new Vector3().applyMatrix4(tree.lookup("base_link", "world")!).x, 1)

    const next = decode(topic.type, bytes)
    next.transforms[0].transform.translation.x = 3
    receive!({ ...message, bytes: encode(topic.type, next), timestamp: 1100, seq: 2 })
    assertAlmostEquals(new Vector3().applyMatrix4(tree.lookup("base_link", "world")!).x, 3)
    // The compact cloud and TF feeds both use gateway milliseconds for historical placement.
    assertAlmostEquals(new Vector3().applyMatrix4(history.lookupAt("base_link", "world", 1050)!).x, 2)
    assertEquals(arrivals, [1000, 1100])
})
