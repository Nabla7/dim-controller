// Phone layout when the screen is narrow or the only pointer is a finger.
import { useEffect, useState } from "react"

const QUERY = "(max-width: 720px), (pointer: coarse) and (max-width: 1024px)"
/** a phone on its side: the main view fills the screen under the thumb sticks (styles.css repeats this query) */
export const PHONE_LANDSCAPE = "(orientation: landscape) and (max-height: 520px)"

export function useMobile(): boolean {
    const [mobile, setMobile] = useState(() => matchMedia(QUERY).matches)
    useEffect(() => {
        const media = matchMedia(QUERY)
        const onChange = () => setMobile(media.matches)
        media.addEventListener("change", onChange)
        return () => media.removeEventListener("change", onChange)
    }, [])
    return mobile
}

/** The places a finger may still scroll on a phone (panels, menus, dialogs like Network, the 3D view's layers menu); everywhere else is the view or a stick. */
const SCROLLABLE = ".panel-body, .record-options, .record-topics, .quality-menu, .dr-modal-body, .cloud-menu, select"

/**
 * While driving from a phone the page must never pan or zoom under a thumb: iOS ignores user-scalable=no, so pinch
 * (gesture*) and a moving finger are stopped here outside the panels that scroll; double-tap zoom is touch-action's.
 */
export function useLockedViewport(enabled: boolean) {
    useEffect(() => {
        if (!enabled) {
            return
        }
        const outsideScrollable = (event: Event) => !(event.target instanceof Element && event.target.closest(SCROLLABLE))
        const gesture = (event: Event) => event.preventDefault()
        const touchMove = (event: TouchEvent) => {
            if (event.touches.length > 1 || outsideScrollable(event)) {
                event.preventDefault()
            }
        }
        document.addEventListener("gesturestart", gesture, { passive: false })
        document.addEventListener("gesturechange", gesture, { passive: false })
        document.addEventListener("touchmove", touchMove, { passive: false })
        document.documentElement.classList.add("locked-viewport")
        return () => {
            document.removeEventListener("gesturestart", gesture)
            document.removeEventListener("gesturechange", gesture)
            document.removeEventListener("touchmove", touchMove)
            document.documentElement.classList.remove("locked-viewport")
        }
    }, [enabled])
}
