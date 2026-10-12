// A thumb stick for driving from a phone. The whole zone (a big share of the screen's bottom) takes the thumb, and the
// stick centers where it lands, so it never needs aiming. The output is shaped (dead zone, expo: core/stick.ts) and
// eased toward the thumb while held. Safety: anything that could mean "the thumb is gone" (lift, cancel, a lost
// capture, another app or tab, the page hiding, a rotation, the STOP button) zeroes it at once, without easing.
import { useEffect, useRef, useState } from "react"
import { shapeStick, smoothToward, type StickAxes } from "../core/stick.ts"

/** STOP (and anything else that must override a held thumb) fires this: every stick lets go until lifted. */
export const stickReleases = new EventTarget()
export function releaseAllSticks() {
    stickReleases.dispatchEvent(new Event("release"))
}

interface Props {
    label: string
    side: "left" | "right"
    axes: StickAxes
    onMove: (x: number, y: number) => void
}

export function Joystick({ label, side, axes, onMove }: Props) {
    const zone = useRef<HTMLDivElement>(null)
    const base = useRef<HTMLDivElement>(null)
    const onMoveRef = useRef(onMove)
    onMoveRef.current = onMove
    const [view, setView] = useState<{ active: boolean; origin: { x: number; y: number } | null; knob: { x: number; y: number } }>({ active: false, origin: null, knob: { x: 0, y: 0 } })
    const live = useRef({ pointer: null as number | null, origin: { x: 0, y: 0 }, radius: 1, target: { x: 0, y: 0 }, current: { x: 0, y: 0 }, frame: 0, last: 0 })

    const emit = (x: number, y: number) => {
        const state = live.current
        if (x !== state.current.x || y !== state.current.y) {
            state.current = { x, y }
            onMoveRef.current(x, y)
        }
    }

    const release = () => {
        const state = live.current
        cancelAnimationFrame(state.frame)
        state.frame = 0
        const wasActive = state.pointer !== null
        state.pointer = null
        state.target = { x: 0, y: 0 }
        if (wasActive || state.current.x !== 0 || state.current.y !== 0) {
            state.current = { x: 0, y: 0 }
            onMoveRef.current(0, 0)
        }
        setView({ active: false, origin: null, knob: { x: 0, y: 0 } })
    }
    const releaseRef = useRef(release)
    releaseRef.current = release

    // eases the output toward the thumb each frame while held
    const step = (now: number) => {
        const state = live.current
        if (state.pointer === null) {
            return
        }
        const dt = state.last ? now - state.last : 16
        state.last = now
        emit(smoothToward(state.current.x, state.target.x, dt), smoothToward(state.current.y, state.target.y, dt))
        state.frame = requestAnimationFrame(step)
    }

    const track = (clientX: number, clientY: number) => {
        const state = live.current
        let dx = clientX - state.origin.x
        let dy = clientY - state.origin.y
        const length = Math.hypot(dx, dy)
        if (length > state.radius) {
            dx *= state.radius / length
            dy *= state.radius / length
        }
        if (axes === "x") {
            dy = 0
        } else if (axes === "y") {
            dx = 0
        }
        state.target = shapeStick(dx, dy, state.radius, axes)
        if (state.target.x === 0 && state.target.y === 0) {
            // back in the dead zone: stop now, not after the easing
            emit(0, 0)
        }
        setView((old) => ({ ...old, knob: { x: dx, y: dy } }))
    }

    const down = (event: React.PointerEvent) => {
        const state = live.current
        if (state.pointer !== null || (event.pointerType === "mouse" && event.button !== 0)) {
            return
        }
        event.preventDefault()
        const box = zone.current!.getBoundingClientRect()
        const ring = base.current!.offsetWidth / 2 || 60
        state.radius = ring
        // the stick centers under the thumb, kept far enough inside the zone that the ring fits
        const x = Math.max(box.left + ring, Math.min(box.right - ring, event.clientX))
        const y = Math.max(box.top + ring, Math.min(box.bottom - ring, event.clientY))
        state.origin = { x, y }
        state.pointer = event.pointerId
        state.last = 0
        zone.current!.setPointerCapture?.(event.pointerId)
        setView({ active: true, origin: { x: x - box.left, y: y - box.top }, knob: { x: 0, y: 0 } })
        track(event.clientX, event.clientY)
        state.frame = requestAnimationFrame(step)
    }
    const move = (event: React.PointerEvent) => {
        if (event.pointerId === live.current.pointer) {
            event.preventDefault()
            track(event.clientX, event.clientY)
        }
    }
    const up = (event: React.PointerEvent) => {
        if (event.pointerId === live.current.pointer) {
            release()
        }
    }

    useEffect(() => {
        const element = zone.current!
        const letGo = () => releaseRef.current()
        // touch events too, in case a browser drops the pointer events: no finger left on this stick → zero
        const touchEnd = (event: TouchEvent) => {
            if (event.targetTouches.length === 0) {
                letGo()
            }
        }
        const hidden = () => {
            if (document.visibilityState !== "visible") {
                letGo()
            }
        }
        // STOP: let go; the thumb has to lift and touch again to drive
        const stop = letGo
        element.addEventListener("touchend", touchEnd)
        element.addEventListener("touchcancel", letGo)
        addEventListener("blur", letGo)
        addEventListener("pagehide", letGo)
        addEventListener("orientationchange", letGo)
        document.addEventListener("visibilitychange", hidden)
        stickReleases.addEventListener("release", stop)
        return () => {
            element.removeEventListener("touchend", touchEnd)
            element.removeEventListener("touchcancel", letGo)
            removeEventListener("blur", letGo)
            removeEventListener("pagehide", letGo)
            removeEventListener("orientationchange", letGo)
            document.removeEventListener("visibilitychange", hidden)
            stickReleases.removeEventListener("release", stop)
            letGo()
        }
    }, [])

    const { active, origin, knob } = view
    return (
        <div
            ref={zone}
            className={`stick-zone ${side} ${active ? "active" : ""}`}
            data-testid={`stick-${side}`}
            aria-label={label}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onLostPointerCapture={up}
            onContextMenu={(event) => event.preventDefault()}
        >
            <div ref={base} className="stick-base" style={origin ? { left: origin.x, top: origin.y } : undefined}>
                <span className="stick-label">{label}</span>
                <span className={`stick-guide ${axes}`} />
                <div className="stick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
            </div>
        </div>
    )
}
