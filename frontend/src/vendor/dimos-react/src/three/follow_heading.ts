// The chase camera (ported from dim-controller core/followHeading.ts): following a frame, the camera turns with the
// frame's heading (yaw) only, so the world stays level (no pitch or roll from the frame), like a third-person game
// camera. Orbit and zoom stay an offset from it.
import * as THREE from "three"

/** a frame that looks straight up or down this nearly (its forward axis' share on the ground) has no heading to follow */
const MIN_GROUND_SHARE = 0.1
/** the chase spring's smoothing time, seconds: a critically damped spring, so turns ease in and out with no overshoot */
const SMOOTH_SECONDS = 0.6
/** a heading this far (radians) from where the camera points is a turn worth following; less is gait sway and TF noise */
const DEADBAND = THREE.MathUtils.degToRad(12)
/** ...once it's held that far off this long, seconds (a debounce: a wobble out and back doesn't move the camera) */
const DEBOUNCE_SECONDS = 0.35
/** a heading this far off is followed at once, no debounce */
const FOLLOW_NOW = THREE.MathUtils.degToRad(45)
/** the chase ends when the camera's within this of the heading and has stopped turning (radians, radians/second) */
const SETTLED = THREE.MathUtils.degToRad(1)
const SETTLED_RATE = THREE.MathUtils.degToRad(2)
/** a gap this long (seconds) is a fresh start: no gliding there */
const SNAP_GAP_SECONDS = 1

const up = new THREE.Vector3(0, 0, 1)

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
    if (Math.hypot(x, y) < MIN_GROUND_SHARE * Math.hypot(x, y, z)) {
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
 * Where the camera turns to, chasing the followed frame's heading; `step()` says how far to turn the camera this
 * frame. Small or brief turns (gait sway, a wobble out and back) are ignored; a held turn is chased by a critically
 * damped spring until the camera settles on it. The first heading after a `reset()` turns nothing (the view keeps its
 * angle and follows the turns from there).
 */
export class ChaseHeading {
    /** the heading the camera points along now */
    #camera: number | null = null
    /** where the spring is pulling the camera */
    #target = 0
    /** the camera's turn rate, radians/second */
    #rate = 0
    #chasing = false
    /** how long the heading has been past the deadband without a chase, seconds */
    #offFor = 0

    /** this frame's turn (radians about z) for the frame's latest heading; null heading (looking up or down): no turn */
    step(heading: number | null, dtSeconds: number): number {
        if (heading === null) {
            return 0
        }
        const dt = Math.max(dtSeconds, 0)
        if (this.#camera === null || dt > SNAP_GAP_SECONDS) {
            this.#camera = this.#target = heading
            this.#rate = 0
            this.#chasing = false
            this.#offFor = 0
            return 0
        }
        const off = Math.abs(wrapAngle(heading - this.#camera))
        if (!this.#chasing) {
            this.#offFor = off > DEADBAND ? this.#offFor + dt : 0
            this.#chasing = off > FOLLOW_NOW || this.#offFor >= DEBOUNCE_SECONDS
        }
        if (this.#chasing) {
            this.#target = heading
            this.#offFor = 0
        }
        const turn = this.#spring(this.#camera, dt)
        if (this.#chasing && off < SETTLED && Math.abs(this.#rate) < SETTLED_RATE) {
            this.#chasing = false
        }
        return turn
    }

    /** One step of a critically damped spring from the camera to the target (Game Programming Gems 4, 1.10). */
    #spring(camera: number, dt: number): number {
        const omega = 2 / SMOOTH_SECONDS
        const x = omega * dt
        const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
        const error = wrapAngle(camera - this.#target)
        const pull = (this.#rate + omega * error) * dt
        this.#rate = (this.#rate - omega * pull) * decay
        const turn = wrapAngle(this.#target + (error + pull) * decay - camera)
        this.#camera = wrapAngle(camera + turn)
        return turn
    }

    /** the heading the camera is turned to now, or null before one */
    get heading(): number | null {
        return this.#camera
    }

    reset() {
        this.#camera = null
    }
}

/** Turns the camera `angle` radians about the world's up (z) around `pivot`, so the view stays level. */
export function turnAbout(camera: THREE.Object3D, pivot: THREE.Vector3, angle: number) {
    const offset = camera.position.clone().sub(pivot).applyAxisAngle(up, angle)
    camera.position.copy(pivot).add(offset)
}
