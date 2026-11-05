// Keeps the TF tree fed: every tf2_msgs.TFMessage topic named tf or tf_static (namespaced too: /robot/tf) on the bridge,
// always (the tf layer only draws it); one named like tf_static is treated as static (exempt from staleness). Other
// TFMessage topics are side channels, not the tree: a planner's own tip frames (manipulation_tf) would give links a
// second parent.
import { decode } from "./lcm/lcm.ts"
import type { Connection } from "./transport.ts"
import type { TfTree } from "dimos-react/three"
import type { Viewer } from "dimos-react/three"
import type { TfHistory } from "./tfHistory.ts"

export function feedTf(connection: Connection, tf: TfTree, viewer: Viewer, history: TfHistory) {
    const subscribed = new Set<string>()
    const sync = () => {
        for (const topic of connection.status.get().topics) {
            if (topic.type !== "tf2_msgs.TFMessage" || !isTreeTopic(topic.name) || subscribed.has(topic.key)) {
                continue
            }
            subscribed.add(topic.key)
            const isStatic = /static/i.test(topic.name)
            // reliable: one tf topic often carries different edges from different publishers, so none may be dropped
            connection.subscribe(topic.key, { delivery: "reliable" }, (message) => {
                let decoded
                try {
                    decoded = decode("tf2_msgs.TFMessage", message.bytes)
                } catch {
                    return
                }
                for (const stamped of decoded.transforms ?? []) {
                    const { translation, rotation } = stamped.transform ?? {}
                    if (!translation || !rotation) {
                        continue
                    }
                    const parent = stamped.header?.frame_id ?? "", child = stamped.child_frame_id ?? ""
                    const position: [number, number, number] = [translation.x, translation.y, translation.z]
                    const quaternion: [number, number, number, number] = [rotation.x, rotation.y, rotation.z, rotation.w]
                    tf.set(parent, child, position, quaternion, isStatic)
                    history.record(parent, child, position, quaternion, message.timestamp, isStatic)
                }
                viewer.noteData(message.timestamp)
            })
        }
    }
    connection.status.subscribe(sync)
    sync()
}

/** A tf tree topic: its last path part is tf or tf_static. */
export function isTreeTopic(name: string): boolean {
    return /^tf(_static)?$/.test(name.split("/").filter(Boolean).pop() ?? "")
}
