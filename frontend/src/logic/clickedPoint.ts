// The 3D view's "Publish clicked_point": one geometry_msgs.PointStamped on /clicked_point, the stream dimos's Go2 nav
// stack listens to by default (ReplanningAStarPlanner and MovementManager take it as a goal). One put per click.
import { encode } from "../lcm.ts"
import { dimosKey } from "./connection.ts"

export const CLICKED_POINT_TOPIC = "/clicked_point"
export const POINT_STAMPED = "geometry_msgs.PointStamped"

/** The zenoh key and LCM bytes for a clicked point in `frameId`, stamped `nowMs`. */
export function clickedPoint(point: { x: number; y: number; z: number }, frameId: string, nowMs = Date.now()): { key: string; bytes: Uint8Array } {
    const stamp = { sec: Math.floor(nowMs / 1000), nsec: (nowMs % 1000) * 1_000_000 }
    const bytes = encode(POINT_STAMPED, { header: { stamp, frame_id: frameId }, point: { x: point.x, y: point.y, z: point.z } })
    return { key: dimosKey(CLICKED_POINT_TOPIC, POINT_STAMPED), bytes }
}
