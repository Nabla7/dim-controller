// The keyboard on an arm: the profile maps KeyboardEvent.code to end-effector axes (held) or a gripper opening
// (pressed), as dimos's keyboard arm teleop does. Never while typing; Space stops; leaving the page releases everything.
import { useEffect } from "react"
import type { ArmControl } from "./arm.ts"
import type { EeAxis, RobotProfile } from "../profile/types.ts"

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))

export function useArmKeys(arm: ArmControl | null, profile: RobotProfile | null) {
    useEffect(() => {
        const keys = profile?.arm?.keys
        if (!arm || !keys) {
            return
        }
        const held = new Set<string>()
        const apply = () => {
            const axes: Partial<Record<EeAxis, number>> = {}
            for (const code of held) {
                const action = keys[code]
                if (action && "ee" in action) {
                    axes[action.ee] = (axes[action.ee] ?? 0) + action.value
                }
            }
            arm.setEe("keys", axes)
        }
        const down = (event: KeyboardEvent) => {
            if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
                return
            }
            if (event.code === "Space") {
                event.preventDefault()
                held.clear()
                arm.stop()
                return
            }
            const action = keys[event.code]
            if (!action) {
                return
            }
            event.preventDefault()
            if ("gripper" in action) {
                if (!event.repeat) {
                    arm.setGripper(action.gripper)
                }
                return
            }
            held.add(event.code)
            apply()
        }
        const up = (event: KeyboardEvent) => {
            if (held.delete(event.code)) {
                apply()
            }
        }
        const reset = () => {
            held.clear()
            apply()
            arm.releaseJoint()
        }
        addEventListener("keydown", down)
        addEventListener("keyup", up)
        addEventListener("blur", reset)
        document.addEventListener("visibilitychange", reset)
        return () => {
            reset()
            removeEventListener("keydown", down)
            removeEventListener("keyup", up)
            removeEventListener("blur", reset)
            document.removeEventListener("visibilitychange", reset)
        }
    }, [arm, profile])
}
