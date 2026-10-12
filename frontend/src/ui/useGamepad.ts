// The gamepad in the page (core/gamepad.ts has the mapping and the safety rules): polled while one is connected, zeroed
// when the window loses focus (to another window or app; Desktop's shell around the page counts as the page) or the tab
// is hidden. `gamepadStatus` is what the bar's gamepad chip shows.
import { useEffect } from "react"
import type { ViewerApp } from "../core/app.ts"
import { GamepadDriver, type GamepadStatus, gamepadSettings, noPad, type PadLike } from "../core/gamepad.ts"
import { Store } from "../core/store.ts"
import { releaseAllSticks } from "./Joystick.tsx"

export const gamepadStatus = new Store<GamepadStatus>(noPad())

/**
 * The page has the user's focus: this document, or, inside Desktop's shell (a same-origin frame), the shell around it
 * (a Steam Deck user never clicks into the frame: the shell's focus counts). Another window or app: no.
 */
function pageHasFocus(): boolean {
    if (document.hasFocus()) {
        return true
    }
    try {
        return window.top !== window && !!window.top?.document.hasFocus()
    } catch {
        // a cross-origin parent: only this document's own focus counts
        return false
    }
}

/** how often a connected pad is read (ms; the drive publishes at its own rate) */
const POLL_MS = 30

export function useGamepad(app: ViewerApp | null) {
    useEffect(() => {
        if (!app || typeof navigator === "undefined" || !navigator.getGamepads) {
            return
        }
        const driver = new GamepadDriver({
            profile: () => app.profile,
            settings: () => gamepadSettings.get(),
            setAxes: (axes) => app.drive.setAxes("gamepad", axes),
            setBoost: (boost) => app.drive.setBoost(boost),
            stop: () => {
                releaseAllSticks()
                app.profile.type === "arm" ? app.arm.stop() : app.drive.stop()
            },
            halted: () => !!app.drive.state.get().halt,
            reconnect: () => void app.reconnect(),
            confirm: () => {
                const focused = document.activeElement
                if (focused instanceof HTMLButtonElement && !focused.disabled) {
                    focused.click()
                }
            },
        }, gamepadStatus)
        const pads = () => [...navigator.getGamepads()] as (PadLike | null)[]
        let timer: ReturnType<typeof setInterval> | null = null
        const poll = () => {
            // not this window's (another app, a hidden tab): zero, and the sticks must come back to rest after
            if (document.hidden || !pageHasFocus()) {
                driver.release()
            } else {
                driver.poll(pads())
            }
            if (!pads().some((pad) => pad?.connected) && timer !== null) {
                clearInterval(timer)
                timer = null
            }
        }
        const start = () => {
            if (timer === null) {
                timer = setInterval(poll, POLL_MS)
            }
            poll()
        }
        const release = () => driver.release()
        const hidden = () => document.hidden && driver.release()
        addEventListener("gamepadconnected", start)
        addEventListener("gamepaddisconnected", poll)
        addEventListener("blur", release)
        document.addEventListener("visibilitychange", hidden)
        // inside Desktop's shell the connect event may go to the shell's frame instead: look once a second as well
        const look = setInterval(() => timer === null && pads().some((pad) => pad?.connected) && start(), 1000)
        if (pads().some((pad) => pad?.connected)) {
            start()
        }
        return () => {
            removeEventListener("gamepadconnected", start)
            removeEventListener("gamepaddisconnected", poll)
            removeEventListener("blur", release)
            document.removeEventListener("visibilitychange", hidden)
            if (timer !== null) {
                clearInterval(timer)
            }
            clearInterval(look)
            driver.release()
        }
    }, [app])
}
