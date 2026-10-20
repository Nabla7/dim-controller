// The hidden zoom debug overlay (core/zoomDebug.ts): the last events on a camera and every zoom change with its cause.
import { useEffect, useState } from "react"
import { useStore } from "../core/store.ts"
import { zoomDebug } from "../core/zoomDebug.ts"

const ON_CAMERA = ["pointerdown", "pointerup", "pointercancel", "pointerleave", "pointerout", "gotpointercapture", "lostpointercapture", "pointermove", "touchstart", "touchend", "touchcancel", "touchmove", "mousedown", "mouseup", "click", "contextmenu", "selectstart", "dragstart"]
const ON_PAGE = ["visibilitychange", "blur", "focus", "resize", "pagehide", "orientationchange"]
const MOVES = new Set(["pointermove", "touchmove"])

function describe(event: Event): string {
    const parts = [event.type]
    if (event instanceof PointerEvent) {
        parts.push(`${event.pointerType}#${event.pointerId}`, `btn${event.button}`, `${event.clientX | 0},${event.clientY | 0}`)
    } else if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
        parts.push(`touches=${event.touches.length}`)
    }
    const target = event.target instanceof Element ? event.target : null
    if (target) {
        parts.push(`on ${target.tagName.toLowerCase()}.${String(target.getAttribute("class") ?? "").split(" ")[0]}`)
    }
    if (event.defaultPrevented) {
        parts.push("(prevented)")
    }
    if (!event.isTrusted) {
        parts.push("(synthetic)")
    }
    return parts.join(" ")
}

/** the media's touch-action and its ancestors' that aren't auto: what the browser may still take over */
function touchActions(): string {
    const media = [...document.querySelectorAll(".camera-media")].find((element) => element.getBoundingClientRect().width > 0)
    const found: string[] = []
    for (let element = media ?? null; element; element = element.parentElement) {
        const value = getComputedStyle(element).touchAction
        if (value !== "auto" || element === media) {
            found.push(`${element.tagName.toLowerCase()}.${String(element.getAttribute("class") ?? "").split(" ")[0]}=${value}`)
        }
    }
    return media ? found.join(" ") : "no camera on screen"
}

export function ZoomDebug() {
    const { enabled, lines } = useStore(zoomDebug)
    const [header, setHeader] = useState("")
    useEffect(() => {
        if (!enabled) {
            return
        }
        let lastMove = ""
        const onCamera = (event: Event) => {
            if (!(event.target instanceof Element) || !event.target.closest(".camera-body")) {
                return
            }
            // after the handlers ran, so defaultPrevented is theirs; one line per run of moves
            setTimeout(() => {
                if (MOVES.has(event.type) && lastMove === event.type) {
                    return
                }
                lastMove = MOVES.has(event.type) ? event.type : ""
                zoomDebug.log(describe(event))
            })
        }
        const onPage = (event: Event) => zoomDebug.log(`${event.type}${event.type === "visibilitychange" ? ` ${document.visibilityState}` : ""}`)
        ON_CAMERA.forEach((type) => addEventListener(type, onCamera, { capture: true, passive: true }))
        ON_PAGE.forEach((type) => (type === "visibilitychange" ? document : globalThis).addEventListener(type, onPage, true))
        const refresh = () => setHeader(`${innerWidth}x${innerHeight} iframe=${globalThis.top !== globalThis.self} | ${touchActions()} | ${navigator.userAgent}`)
        refresh()
        const timer = setInterval(refresh, 2000)
        return () => {
            ON_CAMERA.forEach((type) => removeEventListener(type, onCamera, { capture: true }))
            ON_PAGE.forEach((type) => (type === "visibilitychange" ? document : globalThis).removeEventListener(type, onPage, true))
            clearInterval(timer)
        }
    }, [enabled])
    if (!enabled) {
        return null
    }
    return (
        <div className="zoom-debug" data-testid="zoom-debug">
            <div className="zoom-debug-head">zoom debug (triple tap a camera to hide) · {header}</div>
            {lines.map((line, index) => <div key={index}>{line}</div>)}
        </div>
    )
}
