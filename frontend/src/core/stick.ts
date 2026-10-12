// On-screen stick math, kept out of the component so it's tested: a thumb's offset → a shaped -1..1 value
// (dead zone, then an expo curve for fine control near the center), and the smoothing that eases a value toward
// where the thumb is. A release never goes through smoothing: it is zero at once (ui/Joystick.tsx).

/** below this share of the radius a resting thumb sends nothing */
export const DEAD_ZONE = 0.12
/** >1 flattens the middle: small moves are finer, the edge is still full speed */
export const EXPO = 1.6
/** how quickly a held stick's output follows the thumb (time constant, ms) */
export const SMOOTH_MS = 70

/** Which directions a stick drives: both, or only one (its other axis is ignored, with its own dead zone). */
export type StickAxes = "xy" | "x" | "y"

/**
 * The thumb's offset from the stick's center (px, screen y down) → x and y in -1..1 (up = +y).
 * Two-axis sticks use a radial dead zone (no snapping to an axis); one-axis sticks look at that axis alone. A gamepad
 * passes its own dead zone (Settings → Drive → Gamepad).
 */
export function shapeStick(dx: number, dy: number, radius: number, axes: StickAxes = "xy", deadZone = DEAD_ZONE): { x: number; y: number } {
    if (!(radius > 0)) {
        return { x: 0, y: 0 }
    }
    let x = dx / radius
    let y = -dy / radius
    if (axes === "x") {
        return { x: shape1(x, deadZone), y: 0 }
    }
    if (axes === "y") {
        return { x: 0, y: shape1(y, deadZone) }
    }
    const length = Math.hypot(x, y)
    if (length <= deadZone) {
        return { x: 0, y: 0 }
    }
    const clamped = Math.min(1, length)
    const scaled = Math.pow((clamped - deadZone) / (1 - deadZone), EXPO)
    x = (x / length) * scaled
    y = (y / length) * scaled
    return { x: clean(x), y: clean(y) }
}

function shape1(value: number, deadZone: number): number {
    const size = Math.min(1, Math.abs(value))
    if (size <= deadZone) {
        return 0
    }
    return clean(Math.sign(value) * Math.pow((size - deadZone) / (1 - deadZone), EXPO))
}

/** rounds away float dust (and -0) so a twist reads exactly 0 or a tidy number */
const clean = (value: number) => Math.round(value * 1000) / 1000 || 0

/**
 * One smoothing step: `current` eased toward `target` over `dtMs` (exponential, time constant SMOOTH_MS). Snaps when
 * close, and a target of exactly zero is returned as zero (releasing is never smoothed).
 */
export function smoothToward(current: number, target: number, dtMs: number, tauMs = SMOOTH_MS): number {
    if (target === 0) {
        return 0
    }
    const next = current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs))
    return Math.abs(next - target) < 0.005 ? target : clean(next)
}
