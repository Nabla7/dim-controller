// The 3D view's right-click menu: label the clicked spot (a text label at that point in the fixed frame, written into
// the recording if one runs) or remove the label under the cursor. A right-drag still pans: only a right click that
// barely moved opens it (a long press on touch). "Go here" publishes clicked_point: it sends the spot to the nav stack
// (one message).
import { useEffect, useRef, useState } from "react"
import { Button, Column, Panel, Row, Text, TextInput, useToast } from "dimos-react"
import type { ControllerApp } from "../logic/controller.ts"
import type { LocationLabel } from "../logic/labels.ts"
import { recorder } from "../logic/recorder.ts"
import { clickedPoint } from "../logic/clickedPoint.ts"
import { createRightClickTip, narrate, RIGHT_CLICK_TIP_TEXT } from "../logic/rightClickTip.ts"
import { useStore } from "../logic/settings.ts"

interface Point {
    x: number
    y: number
    z: number
}

interface Menu {
    x: number
    y: number
    point: Point | null
    on: string
    near: LocationLabel | null
    /** typing the label's text */
    editing: boolean
}

const fmt = (value: number) => value.toFixed(2)

export function SceneMenu({ app }: { app: ControllerApp }) {
    const [menu, setMenu] = useState<Menu | null>(null)
    const [text, setText] = useState("")
    const box = useRef<HTMLDivElement>(null)
    const toast = useToast()
    const { ready } = useStore(app.sceneReady)

    useEffect(() => {
        const viewer = ready ? app.scene?.viewer : null
        if (!viewer) {
            return
        }
        const canvas: HTMLCanvasElement = viewer.renderer.domElement
        let down: { x: number; y: number } | null = null
        let leftDown: { x: number; y: number } | null = null
        const tip = createRightClickTip({
            show: () => narrate(RIGHT_CLICK_TIP_TEXT).then((narrated) => !narrated && toast.info(RIGHT_CLICK_TIP_TEXT)),
        })
        const open = (x: number, y: number) => {
            tip.rightClicked()
            const picked = viewer.pick(x, y)
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
    }, [app, ready])

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

    const save = async () => {
        if (!menu?.point || !text.trim()) {
            return
        }
        const { point } = menu
        setMenu(null)
        try {
            const { recorded } = await app.labels.create(text.trim(), point)
            toast.ok(recorded ? "Label saved to the recording" : "Label added (no recording running)")
            recorder.refresh()
        } catch (error) {
            toast.error(`Couldn't add the label: ${error instanceof Error ? error.message : error}`)
        }
    }

    const remove = async (label: LocationLabel) => {
        setMenu(null)
        try {
            await app.labels.remove(label.id)
        } catch (error) {
            toast.error(`Couldn't remove the label: ${error instanceof Error ? error.message : error}`)
        }
    }

    const publishClickedPoint = async (point: Point) => {
        setMenu(null)
        const client = app.connection.client
        if (!client || client.state === "lost") {
            toast.error("Couldn't publish clicked_point: not connected to the gateway")
            return
        }
        const frame = app.fixedFrame
        const { key, bytes } = clickedPoint(point, frame)
        try {
            await client.put(key, bytes)
            toast.ok(`Published clicked_point ${fmt(point.x)}, ${fmt(point.y)}, ${fmt(point.z)} (${frame})`)
        } catch (error) {
            toast.error(`Couldn't publish clicked_point: ${error instanceof Error ? error.message : error}`)
        }
    }

    if (!menu) {
        return null
    }
    // keep the menu on screen
    const left = Math.min(menu.x, innerWidth - 250)
    const top = Math.min(menu.y, innerHeight - 175)
    return (
        <div ref={box} className="scene-menu" style={{ left, top }} role="menu" onContextMenu={(event) => event.preventDefault()}>
            <Panel glass>
                {menu.point && (
                    <Text mono small muted>
                        {fmt(menu.point.x)}, {fmt(menu.point.y)}, {fmt(menu.point.z)} · {app.fixedFrame}
                        {menu.on === "ground" ? " · ground" : ""}
                    </Text>
                )}
                {menu.editing
                    ? (
                        <Row gap={6}>
                            <TextInput autoFocus placeholder="What happened here?" value={text} onChange={setText} onEnter={save} />
                            <Button variant="primary" size="sm" disabled={!text.trim()} onClick={save}>Add</Button>
                        </Row>
                    )
                    : (
                        <Column gap={2}>
                            <Button variant="ghost" block role="menuitem" disabled={!menu.point} onClick={() => publishClickedPoint(menu.point!)}>Go here</Button>
                            <Button variant="ghost" block role="menuitem" disabled={!menu.point} onClick={() => setMenu({ ...menu, editing: true })}>Label this location…</Button>
                            {menu.near && <Button variant="ghost" block role="menuitem" onClick={() => remove(menu.near!)}>Remove label “{menu.near.label}”</Button>}
                        </Column>
                    )}
            </Panel>
        </div>
    )
}
