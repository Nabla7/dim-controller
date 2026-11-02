// dimos's NamedLocations module (dimos/navigation/named_locations): named poses it keeps in the prior map's `map` frame.
// /named_locations is the whole list, one InteractiveMarkerUpdate, and anyone may publish it: the module publishes its
// list at start and on /named_locations_request (which the page sends on every connect), and adopts any list that
// differs from its own without echoing it. So an add, move, rename or delete is a new whole list (poses in map), and
// the page draws the latest list heard on the topic, its own included. /go_to_named_location sends the robot to one.
// `state.locations` is null until a list comes: then the module is there, and the 3D view's labels are these (core/labels.ts).
import { decode, encode } from "./lcm/lcm.ts"
import { Store } from "./store.ts"
import { type Connection, dimosKey } from "./transport.ts"
import type { LocationLabel } from "./labels.ts"

export const UPDATE_TYPE = "visualization_msgs.InteractiveMarkerUpdate"
export const STRING_TYPE = "std_msgs.String"
export const SNAPSHOT_KEY = dimosKey("/named_locations", UPDATE_TYPE)
export const REQUEST_KEY = dimosKey("/named_locations_request", STRING_TYPE)
/** the frame the module keeps (and publishes) its list in */
export const MAP_FRAME = "map"
export const GO_TO_KEY = dimosKey("/go_to_named_location", STRING_TYPE)

/** A location in a list: its name and pose (in map, when published). */
export type NamedPose = Pick<LocationLabel, "label" | "frame_id" | "position" | "orientation">

const stampOf = (nowMs: number) => ({ sec: Math.floor(nowMs / 1000), nsec: (nowMs % 1000) * 1_000_000 })

/** A list's locations, as labels whose id is the name. */
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

/** The whole list, stamped `nowMs`. */
export function listBytes(poses: NamedPose[], nowMs = Date.now()): Uint8Array {
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

/** `list` with `location` added, or moved if its name is there (in place, so the order stays). */
export function withLocation(list: NamedPose[], location: NamedPose): NamedPose[] {
    const at = list.findIndex((one) => one.label === location.label)
    return at === -1 ? [...list, location] : list.map((one, index) => (index === at ? location : one))
}

export const withoutLocation = (list: NamedPose[], name: string) => list.filter((one) => one.label !== name)

/** `list` with `from` called `to`, where it was. */
export const renamedLocation = (list: NamedPose[], from: string, to: string) => list.map((one) => (one.label === from ? { ...one, label: to } : one))

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

    /** The list now (empty before one came). */
    get current(): NamedPose[] {
        return this.state.get().locations ?? []
    }

    /** Publishes a new whole list; it's drawn when it comes back on the topic, like anyone's. */
    publish(list: NamedPose[]): Promise<void> {
        return this.#put(SNAPSHOT_KEY, listBytes(list))
    }

    /** Sends the robot to a location (a command: the drive lease covers it). */
    goTo(name: string): Promise<void> {
        this.connection.command(GO_TO_KEY)
        return this.#put(GO_TO_KEY, stringBytes(name))
    }
}
