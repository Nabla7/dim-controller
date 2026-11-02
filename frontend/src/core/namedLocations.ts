// dimos's NamedLocations module (dimos/navigation/named_locations): named poses it keeps in the prior map's `map` frame.
// It sends every location as one InteractiveMarkerUpdate on /location_labels (at start, after each change, and on each
// /location_labels_request, which the page sends on every connect). /set_location_label adds or moves poses by name,
// /delete_location_label removes a name (a rename is a set of the new name, then a delete of the old), and
// /go_to_location_label sends the robot to one.
// `state.locations` is null until a snapshot comes: then the module is there, and the 3D view's labels are these (core/labels.ts).
import { decode, encode } from "./lcm/lcm.ts"
import { Store } from "./store.ts"
import { type Connection, dimosKey } from "./transport.ts"
import type { LocationLabel } from "./labels.ts"

export const UPDATE_TYPE = "visualization_msgs.InteractiveMarkerUpdate"
export const STRING_TYPE = "std_msgs.String"
export const SNAPSHOT_KEY = dimosKey("/location_labels", UPDATE_TYPE)
export const SET_KEY = dimosKey("/set_location_label", UPDATE_TYPE)
export const DELETE_KEY = dimosKey("/delete_location_label", STRING_TYPE)
export const REQUEST_KEY = dimosKey("/location_labels_request", STRING_TYPE)
export const GO_TO_KEY = dimosKey("/go_to_location_label", STRING_TYPE)

/** A location to set: its name and pose (any frame TF relates to map). */
export type NamedPose = Pick<LocationLabel, "label" | "frame_id" | "position" | "orientation">

const stampOf = (nowMs: number) => ({ sec: Math.floor(nowMs / 1000), nsec: (nowMs % 1000) * 1_000_000 })

/** A snapshot's locations, as labels whose id is the name. */
export function snapshotLabels(bytes: Uint8Array): LocationLabel[] {
    const update = decode(UPDATE_TYPE, bytes)
    // deno-lint-ignore no-explicit-any
    return update.poses.map(({ header, pose, name }: any) => ({
        id: name,
        label: name,
        frame_id: header.frame_id,
        position: [pose.position.x, pose.position.y, pose.position.z],
        orientation: [pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w],
        created: header.stamp.sec * 1e9 + header.stamp.nsec,
    }))
}

/** A set: `poses` added or moved by name, stamped `nowMs`. */
export function setBytes(poses: NamedPose[], nowMs = Date.now()): Uint8Array {
    const stamp = stampOf(nowMs)
    return encode(UPDATE_TYPE, {
        server_id: "dim-controller",
        poses: poses.map(({ label, frame_id, position: [x, y, z], orientation: [qx, qy, qz, qw] }) => ({
            header: { stamp, frame_id },
            pose: { position: { x, y, z }, orientation: { x: qx, y: qy, z: qz, w: qw } },
            name: label,
        })),
    })
}

export const stringBytes = (data: string) => encode(STRING_TYPE, { data })

export class NamedLocations {
    readonly state = new Store<{ locations: LocationLabel[] | null }>({ locations: null })

    constructor(readonly connection: Connection) {
        const subscription = connection.subscribe(SNAPSHOT_KEY, { delivery: "reliable" }, (message) => this.state.set({ locations: snapshotLabels(message.bytes) }))
        let state = connection.status.get().state
        connection.status.subscribe(() => {
            const next = connection.status.get().state
            // each (re)connect asks for the snapshot once its subscription is up, so the answer can't miss it
            if (next === "connected" && state !== "connected") {
                subscription.ready().then(() => this.#put(REQUEST_KEY, stringBytes(""))).catch(() => {})
            }
            state = next
        })
    }

    async #put(key: string, bytes: Uint8Array) {
        const client = this.connection.client
        if (!client || client.state === "lost") {
            throw new Error("not connected to the gateway")
        }
        await client.put(key, bytes)
    }

    /** Adds or moves `poses` by name; the module answers with a fresh snapshot. */
    set(poses: NamedPose[]): Promise<void> {
        return this.#put(SET_KEY, setBytes(poses))
    }

    remove(name: string): Promise<void> {
        return this.#put(DELETE_KEY, stringBytes(name))
    }

    /** The new name at the same pose first, then the old one deleted, so it's never gone. */
    async rename(location: NamedPose, name: string) {
        await this.set([{ ...location, label: name }])
        if (name !== location.label) {
            await this.remove(location.label)
        }
    }

    /** Sends the robot to a location (a command: the drive lease covers it). */
    goTo(name: string): Promise<void> {
        this.connection.command(GO_TO_KEY)
        return this.#put(GO_TO_KEY, stringBytes(name))
    }
}
