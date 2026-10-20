// The 3D view's chase camera: following a frame, the camera turns with the frame's heading (yaw) only, so the world
// stays level (no pitch or roll from the frame), like a third-person game camera. Orbit and zoom stay an offset from it.
import * as THREE from "three"

/** a frame that looks straight up or down this nearly (its forward axis' share on the ground) has no heading to follow */
const MIN_GROUND_SHARE = 0.1
/** how quickly the camera catches up with a turn, seconds (a low-pass: TF arrives at 10-20 Hz, frames at 60-120) */
const TURN_SECONDS = 0.2
/** a gap this long (seconds) is a fresh start: no gliding there */
const SNAP_GAP_SECONDS = 1

/** Whether a TF frame is a ROS optical frame (z forward, x right, y down) rather than a body frame (x forward, z up). */
export function isOpticalFrame(frame: string): boolean {
    return /optical/i.test(frame)
}

/**
 * Which way a frame faces on the ground, radians about the fixed frame's z (0 = +x, counterclockwise), or null when
 * it looks (nearly) straight up or down. Its forward axis is z for an optical frame, x for a body frame.
 */
export function headingOf(pose: THREE.Matrix4, frame: string): number | null {
    const e = pose.elements
    // column 2 (z) or column 0 (x) of the rotation, in the fixed frame
    const [x, y, z] = isOpticalFrame(frame) ? [e[8], e[9], e[10]] : [e[0], e[1], e[2]]
    const ground = Math.hypot(x, y)
    if (ground < MIN_GROUND_SHARE * Math.hypot(x, y, z)) {
        return null
    }
    return Math.atan2(y, x)
}

/** `angle` wrapped to (-π, π] */
export function wrapAngle(angle: number): number {
    const wrapped = angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI))
    return wrapped === -Math.PI ? Math.PI : wrapped
}

/**
 * The followed frame's heading, low-passed between TF updates; `step()` says how far to turn the camera this frame.
 * The first heading after a `reset()` turns nothing (the view keeps its angle and follows the turns from there).
 */
export class ChaseHeading {
    #smoothed: number | null = null

    /** this frame's turn (radians about z) for the frame's latest heading; null heading (looking up or down): no turn */
    step(heading: number | null, dtSeconds: number): number {
        if (heading === null) {
            return 0
        }
        if (this.#smoothed === null || dtSeconds > SNAP_GAP_SECONDS) {
            this.#smoothed = heading
            return 0
        }
        const turn = wrapAngle(heading - this.#smoothed) * (1 - Math.exp(-Math.max(dtSeconds, 0) / TURN_SECONDS))
        this.#smoothed = wrapAngle(this.#smoothed + turn)
        return turn
    }

    /** the heading the camera is turned to now, or null before one */
    get heading(): number | null {
        return this.#smoothed
    }

    reset() {
        this.#smoothed = null
    }
}

/** Turns the camera `angle` radians about the world's up (z) around `pivot`, so the view stays level. */
export function turnAbout(camera: THREE.Object3D, pivot: THREE.Vector3, angle: number) {
    const offset = camera.position.clone().sub(pivot).applyAxisAngle(new THREE.Vector3(0, 0, 1), angle)
    camera.position.copy(pivot).add(offset)
}

/** Where the camera goes to look at `target` from behind `heading`, `distance` away and `elevation` radians above. */
export function behind(target: THREE.Vector3, heading: number, distance: number, elevation = 0.45): THREE.Vector3 {
    const ground = distance * Math.cos(elevation)
    return new THREE.Vector3(target.x - ground * Math.cos(heading), target.y - ground * Math.sin(heading), target.z + distance * Math.sin(elevation))
}

/** Whether `frame` is the robot's base frame or rides on it (below it in the TF tree): it moves and turns with the robot. */
export function ridesOn(frame: string, base: string, parentOf: (frame: string) => string | null): boolean {
    const seen = new Set<string>()
    for (let current: string | null = frame; current && !seen.has(current); current = parentOf(current)) {
        if (current === base) {
            return true
        }
        seen.add(current)
    }
    return false
}
