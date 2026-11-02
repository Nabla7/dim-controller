// dimos's NamedLocations module (dimos/navigation/named_locations): named poses it keeps in the prior map's `map` frame.
// It sends every location as one InteractiveMarkerUpdate on /named_locations (at start, after each edit, and on each
// /named_locations_request, which the page sends on every connect); edits go back on /named_location_edits (erases
// first, then poses set by name: a rename is both in one message) and /go_to_named_location sends the robot to one.
// `state.locations` is null until a snapshot comes: then the module is there, and the 3D view's labels are these (core/labels.ts).
import { decode, encode } from "./lcm/lcm.ts"
import { Store } from "./store.ts"
import { type Connection, dimosKey } from "./transport.ts"
import type { LocationLabel } from "./labels.ts"

export const UPDATE_TYPE = "visualization_msgs.InteractiveMarkerUpdate"
export const STRING_TYPE = "std_msgs.String"
export const SNAPSHOT_KEY = dimosKey("/named_locations", UPDATE_TYPE)
export const EDITS_KEY = dimosKey("/named_location_edits", UPDATE_TYPE)
export const REQUEST_KEY = dimosKey("/named_locations_request", STRING_TYPE)
export const GO_TO_KEY = dimosKey("/go_to_named_location", STRING_TYPE)

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

/** One edit: `erases` (names) are removed first, then `poses` are added or moved by name, stamped `nowMs`. */
export function editBytes(erases: string[], poses: NamedPose[], nowMs = Date.now()): Uint8Array {
    const stamp = stampOf(nowMs)
    return encode(UPDATE_TYPE, {
        server_id: "dim-controller",
        erases,
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

    /** Erases `erases`, then sets `poses`; the module answers with a fresh snapshot. */
    edit(erases: string[], poses: NamedPose[]): Promise<void> {
        return this.#put(EDITS_KEY, editBytes(erases, poses))
    }

    /** Sends the robot to a location (a command: the drive lease covers it). */
    goTo(name: string): Promise<void> {
        this.connection.command(GO_TO_KEY)
        return this.#put(GO_TO_KEY, stringBytes(name))
    }
}
