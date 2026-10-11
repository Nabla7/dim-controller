// The keyboard as a drive source: the profile maps KeyboardEvent.code to axes or controls; Shift boosts, Space stops.
// Keys drive whenever the page has focus (no arming), never while typing in a field. Escape, blur and hiding the page stop.
import { useEffect } from "react"
import type { Drive } from "./drive.ts"
import type { Axes, RobotProfile } from "../profile/types.ts"

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))

export function useDriveKeys(drive: Drive | null, profile: RobotProfile | null) {
    useEffect(() => {
        if (!drive || !profile) {
            return
        }
        const held = new Set<string>()
        const apply = () => {
            const axes: Partial<Axes> = {}
            for (const code of held) {
                const action = profile.drive.keys[code]
                if (action && "axis" in action) {
                    axes[action.axis] = (axes[action.axis] ?? 0) + action.value
                }
            }
            drive.setAxes("keys", axes)
        }
        const down = (event: KeyboardEvent) => {
            if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
                return
            }
            if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
                drive.setBoost(true)
                return
            }
            if (event.code === "Space" || event.code === "Escape") {
                event.preventDefault()
                held.clear()
                drive.stop()
                return
            }
            const action = profile.drive.keys[event.code]
            if (!action) {
                return
            }
            event.preventDefault()
            if ("control" in action) {
                if (!event.repeat) {
                    const control = profile.controls.find((other) => other.id === action.control)
                    if (control?.kind === "button") {
                        drive.pressButton(control.id)
                    } else if (control) {
                        drive.stepControl(control.id, action.step ?? control.step)
                    }
                }
                return
            }
            held.add(event.code)
            apply()
        }
        const up = (event: KeyboardEvent) => {
            if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
                drive.setBoost(event.shiftKey)
                return
            }
            if (held.delete(event.code)) {
                apply()
            }
        }
        const reset = () => {
            held.clear()
            drive.setBoost(false)
            drive.stop()
        }
        addEventListener("keydown", down)
        addEventListener("keyup", up)
        addEventListener("blur", reset)
        document.addEventListener("visibilitychange", reset)
        return () => {
            removeEventListener("keydown", down)
            removeEventListener("keyup", up)
            removeEventListener("blur", reset)
            document.removeEventListener("visibilitychange", reset)
        }
    }, [drive, profile])
}
