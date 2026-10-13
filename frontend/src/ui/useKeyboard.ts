// The page's keyboard (decisions in ui/keymap.ts): hold the profile's keys to drive (WASD/QE and the arrows; release
// stops), Shift boosts, Space stops always, `/` opens the palette, `?` the shortcut list, Escape closes what's open and
// stops, `[` `]` `\` show and hide the rails. Keys drive whenever the page has the focus (no arming), never while
// typing in a field or with an overlay open; leaving the window or hiding the page releases everything and stops.
// Listening in the capture phase, so Escape reaches the page before Desktop's shell. The held drive keys, Shift and Space
// also go out as Joy (core/joy.ts: KeyboardTeleop's layout), on each change. A profile's joint keys (R/F on a wheeled
// base) hold-jog the joint control's pick through `arm` (core/baseJoint.ts); their release holds it.
import { useEffect, useRef } from "react"
import type { ArmControl } from "../core/arm.ts"
import { jogPicked } from "../core/baseJoint.ts"
import type { Drive } from "../core/drive.ts"
import { type JoyPublisher, keyboardJoy } from "../core/joy.ts"
import type { Axes, RobotProfile } from "../profile/types.ts"
import { isTypingTarget, routeKeyDown } from "./keymap.ts"
import { closeOverlay, openOverlay, overlay } from "./overlay.ts"
import { type Side, workspaceView } from "./workspace.ts"

export function useKeyboard(drive: Drive | null, profile: RobotProfile | null, panels: { toggleRail: (side: Side) => void; toggleFocus: () => void }, joy: JoyPublisher | null = null, arm: ArmControl | null = null) {
    // the latest callbacks, without re-binding (a re-bind mid-hold would forget the held keys)
    const latest = useRef(panels)
    latest.current = panels
    useEffect(() => {
        const held = new Set<string>()
        const joyKeys = { shift: false, space: false }
        /** the joint keys' jog now (-1, 0, 1) */
        let jointSign = 0
        const apply = () => {
            joy?.sample("keyboard", keyboardJoy(held, { ...joyKeys, ctrl: false }))
            if (!drive || !profile) {
                return
            }
            const axes: Partial<Axes> = {}
            let joint = 0
            for (const code of held) {
                const action = profile.drive.keys[code]
                if (action && "axis" in action) {
                    axes[action.axis] = (axes[action.axis] ?? 0) + action.value
                } else if (action && "joint" in action) {
                    joint += action.joint
                }
            }
            drive.setAxes("keys", axes)
            if (arm && Math.sign(joint) !== jointSign) {
                jointSign = Math.sign(joint)
                if (jointSign) {
                    jogPicked(arm, drive, jointSign)
                } else {
                    arm.releaseJoint()
                }
            }
        }
        /** let go of every key (an overlay opened): nothing keeps moving, the agent's command isn't touched */
        const release = () => {
            held.clear()
            joyKeys.shift = false
            joyKeys.space = false
            apply()
            drive?.setBoost(false)
        }
        const down = (event: KeyboardEvent) => {
            const open = overlay.get().open
            const decision = routeKeyDown(event, {
                typing: isTypingTarget(event.target),
                overlay: open ?? (workspaceView.get().drawer ? "drawer" : null),
                driveKeys: profile?.drive.keys ?? {},
            })
            switch (decision.kind) {
                case "stop":
                    if (decision.consume) {
                        event.preventDefault()
                    }
                    held.clear()
                    joyKeys.space ||= event.code === "Space"
                    apply()
                    drive?.stop()
                    return
                case "close":
                    held.clear()
                    drive?.stop()
                    if (open) {
                        event.preventDefault()
                        event.stopPropagation()
                        closeOverlay()
                    } else if (workspaceView.get().drawer) {
                        event.preventDefault()
                        workspaceView.set({ ...workspaceView.get(), drawer: null })
                    }
                    return
                case "palette":
                case "help":
                    event.preventDefault()
                    release()
                    openOverlay(open === decision.kind ? null : decision.kind)
                    return
                case "boost":
                    drive?.setBoost(true)
                    if (!joyKeys.shift) {
                        joyKeys.shift = true
                        apply()
                    }
                    return
                case "rail":
                    event.preventDefault()
                    latest.current.toggleRail(decision.side)
                    return
                case "focus":
                    event.preventDefault()
                    latest.current.toggleFocus()
                    return
                case "drive": {
                    event.preventDefault()
                    const action = profile?.drive.keys[event.code]
                    if (!drive || !profile || !action) {
                        return
                    }
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
                    return
                }
            }
        }
        const up = (event: KeyboardEvent) => {
            if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
                drive?.setBoost(event.shiftKey)
                joyKeys.shift = event.shiftKey
                apply()
                return
            }
            if (event.code === "Space" && joyKeys.space) {
                joyKeys.space = false
                apply()
                return
            }
            if (held.delete(event.code)) {
                apply()
            }
        }
        const reset = () => {
            held.clear()
            jointSign = 0
            joyKeys.shift = false
            joyKeys.space = false
            joy?.release("keyboard")
            drive?.setBoost(false)
            drive?.stop()
        }
        // an overlay opening lets go of the keys (their keyup would go to the overlay's field)
        const unsubscribe = overlay.subscribe(() => overlay.get().open && release())
        addEventListener("keydown", down, true)
        addEventListener("keyup", up, true)
        addEventListener("blur", reset)
        document.addEventListener("visibilitychange", reset)
        return () => {
            // a profile or drive change mid-hold: what was held is let go
            release()
            unsubscribe()
            removeEventListener("keydown", down, true)
            removeEventListener("keyup", up, true)
            removeEventListener("blur", reset)
            document.removeEventListener("visibilitychange", reset)
        }
    }, [drive, profile, joy, arm])
}
