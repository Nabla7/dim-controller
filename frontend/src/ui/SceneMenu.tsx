// The 3D view's right-click menu: label the clicked spot (a text label at that point in the fixed frame, written into
// the recording if one runs) or remove the label under the cursor. A right-drag still pans: only a right click that
// barely moved opens it (a long press on touch). "Go here" publishes clicked_point: it sends the spot to the nav stack (one message).
import { useEffect, useRef, useState } from "react"
import type * as THREE from "three"
import type { ViewerApp } from "../core/app.ts"
import type { LocationLabel } from "../core/labels.ts"
import { recorder } from "../core/recorder.ts"
import { clickedPoint } from "../core/clickedPoint.ts"
import { createRightClickTip, narrate, RIGHT_CLICK_TIP_TEXT } from "../core/rightClickTip.ts"

interface Menu {
    x: number
    y: number
    point: THREE.Vector3 | null
    on: string
    near: LocationLabel | null
    /** typing the label's text */
    editing: boolean
}

const fmt = (value: number) => value.toFixed(2)

export function SceneMenu({ app }: { app: ViewerApp }) {
    const [menu, setMenu] = useState<Menu | null>(null)
    const [text, setText] = useState("")
    const [note, setNote] = useState<string | null>(null)
    const box = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const canvas = app.viewer.canvas
        let down: { x: number; y: number } | null = null
        let leftDown: { x: number; y: number } | null = null
        const tip = createRightClickTip({
            show: () => narrate(RIGHT_CLICK_TIP_TEXT).then((narrated) => !narrated && setNote(RIGHT_CLICK_TIP_TEXT)),
        })
        const open = (x: number, y: number) => {
            tip.rightClicked()
            const picked = app.viewer.pick(x, y)
            setText("")
            setMenu({ x, y, point: picked?.point ?? null, on: picked?.on ?? "", near: app.labels.near(x, y), editing: false })
        }
        const onDown = (event: PointerEvent) => {
            if (event.button === 2 && event.pointerType === "mouse") {
                down = { x: event.clientX, y: event.clientY }
            } else if (event.button === 0) {
                setMenu(null)
                leftDown = event.pointerType === "mouse" ? { x: event.clientX, y: event.clientY } : null
            }
        }
        const onUp = (event: PointerEvent) => {
            // a left click that barely moved (an orbit drag isn't one) counts toward the double-click tip
            if (event.button === 0 && leftDown && Math.hypot(event.clientX - leftDown.x, event.clientY - leftDown.y) < 5) {
                tip.click(event.timeStamp)
            }
            if (event.button === 0) {
                leftDown = null
            }
            if (event.button === 2 && down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5) {
                open(event.clientX, event.clientY)
            }
            down = null
        }
        // touch: a long press is a contextmenu event (mice are handled on pointerup, so a right-drag pan isn't one)
        const onContext = (event: MouseEvent) => {
            event.preventDefault()
            if ((event as PointerEvent).pointerType === "touch") {
                open(event.clientX, event.clientY)
            }
        }
        canvas.addEventListener("pointerdown", onDown)
        canvas.addEventListener("pointerup", onUp)
        canvas.addEventListener("contextmenu", onContext)
        return () => {
            canvas.removeEventListener("pointerdown", onDown)
            canvas.removeEventListener("pointerup", onUp)
            canvas.removeEventListener("contextmenu", onContext)
        }
    }, [app])

    useEffect(() => {
        if (!menu) {
            return
        }
        const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenu(null)
        const onOutside = (event: PointerEvent) => !box.current?.contains(event.target as Node) && setMenu(null)
        addEventListener("keydown", onKey)
        addEventListener("pointerdown", onOutside, true)
        return () => {
            removeEventListener("keydown", onKey)
            removeEventListener("pointerdown", onOutside, true)
        }
    }, [menu])

    useEffect(() => {
        if (!note) {
            return
        }
        const timer = setTimeout(() => setNote(null), 3000)
        return () => clearTimeout(timer)
    }, [note])

    const save = async () => {
        if (!menu?.point || !text.trim()) {
            return
        }
        const { point } = menu
        setMenu(null)
        try {
            const { recorded } = await app.labels.create(text.trim(), point)
            setNote(recorded ? "Label saved to the recording" : "Label added (no recording running)")
            recorder.refresh()
        } catch (error) {
            setNote(`Couldn't add the label: ${error instanceof Error ? error.message : error}`)
        }
    }

    const remove = async (label: LocationLabel) => {
        setMenu(null)
        try {
            await app.labels.remove(label.id)
        } catch (error) {
            setNote(`Couldn't remove the label: ${error instanceof Error ? error.message : error}`)
        }
    }

    const publishClickedPoint = async (point: THREE.Vector3) => {
        setMenu(null)
        const client = app.connection.client
        if (!client || client.state === "lost") {
            setNote("Couldn't publish clicked_point: not connected to the gateway")
            return
        }
        const frame = app.viewer.fixedFrame
        const { key, bytes } = clickedPoint(point, frame)
        try {
            await client.put(key, bytes)
            setNote(`Published clicked_point ${fmt(point.x)}, ${fmt(point.y)}, ${fmt(point.z)} (${frame})`)
        } catch (error) {
            setNote(`Couldn't publish clicked_point: ${error instanceof Error ? error.message : error}`)
        }
    }

    // keep the menu on screen
    const left = menu ? Math.min(menu.x, innerWidth - 250) : 0
    const top = menu ? Math.min(menu.y, innerHeight - 175) : 0
    return (
        <>
            {menu && (
                <div ref={box} className="dim-panel scene-menu" style={{ left, top }} role="menu" onContextMenu={(event) => event.preventDefault()}>
                    {menu.point && (
                        <div className="scene-menu-where dim-mono">
                            {fmt(menu.point.x)}, {fmt(menu.point.y)}, {fmt(menu.point.z)} · {app.viewer.fixedFrame}
                            {menu.on === "ground" ? " · ground" : ""}
                        </div>
                    )}
                    {menu.editing ? (
                        <form
                            className="scene-menu-edit"
                            onSubmit={(event) => {
                                event.preventDefault()
                                save()
                            }}
                        >
                            <input className="dim-input" autoFocus placeholder="What happened here?" value={text} onChange={(event) => setText(event.target.value)} />
                            <button type="submit" className="dim-btn primary" disabled={!text.trim()}>Add</button>
                        </form>
                    ) : (
                        <>
                            <button type="button" role="menuitem" className="scene-menu-item" disabled={!menu.point} onClick={() => publishClickedPoint(menu.point!)}>
                                Go here
                            </button>
                            <button type="button" role="menuitem" className="scene-menu-item" disabled={!menu.point} onClick={() => setMenu({ ...menu, editing: true })}>
                                Label this location…
                            </button>
                            {menu.near && (
                                <button type="button" role="menuitem" className="scene-menu-item" onClick={() => remove(menu.near!)}>
                                    Remove label “{menu.near.label}”
                                </button>
                            )}
                        </>
                    )}
                </div>
            )}
            {note && <div className="dim-panel scene-note">{note}</div>}
        </>
    )
}
