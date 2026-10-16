// Dragging a panel by its header (ui/Panel.tsx): while dragged it takes its floating size under the pointer, and the
// workspace shows where it would land (ui/workspace.ts dropTarget: a rail slot, the main view, or a snapped floating
// box). Releasing applies that; Escape (or a press that never moved: a click) puts everything back. And where a panel's
// popover menu goes.
import type { CSSProperties } from "react"
import type { DropTarget, Rect } from "./workspace.ts"

/** a press has to move this far before it's a drag (a click or double-click stays one) */
export const DRAG_SLOP = 5

export interface DragPlan {
    /** the box it has while dragged */
    size: { width: number; height: number }
    /** where the pointer holds it, from its top-left corner */
    grab: { x: number; y: number }
    /** where it would land with the pointer here and its box at `box` */
    target: (pointer: { x: number; y: number }, box: Rect) => DropTarget
    /** show (or, null, clear) the landing preview */
    preview: (target: DropTarget | null) => void
    drop: (target: DropTarget) => void
}

/** Starts a header drag from its pointerdown. */
export function startHeaderDrag(event: { clientX: number; clientY: number }, element: HTMLElement, plan: DragPlan) {
    const start = { x: event.clientX, y: event.clientY }
    const before = element.style.cssText
    let dragging = false
    let target: DropTarget | null = null
    const move = (pointer: PointerEvent) => {
        if (!dragging && Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) < DRAG_SLOP) {
            return
        }
        dragging = true
        element.classList.add("dragging")
        globalThis.document?.body.classList.add("panel-dragging")
        const box = { x: pointer.clientX - plan.grab.x, y: pointer.clientY - plan.grab.y, ...plan.size }
        Object.assign(element.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` })
        target = plan.target({ x: pointer.clientX, y: pointer.clientY }, box)
        plan.preview(target)
    }
    const finish = (apply: boolean) => {
        removeEventListener("pointermove", move)
        removeEventListener("pointerup", up)
        removeEventListener("pointercancel", cancel)
        removeEventListener("keydown", key, true)
        // React placed it: its own inline box back, then the arrangement change places it again
        element.style.cssText = before
        element.classList.remove("dragging")
        globalThis.document?.body.classList.remove("panel-dragging")
        plan.preview(null)
        if (apply && dragging && target) {
            plan.drop(target)
        }
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const key = (pressed: KeyboardEvent) => {
        if (pressed.key === "Escape" && dragging) {
            pressed.preventDefault()
            pressed.stopPropagation()
            finish(false)
        }
    }
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
    addEventListener("pointercancel", cancel)
    addEventListener("keydown", key, true)
}

/** A drag on a splitter, a rail's edge or a resize corner: `onMove` gets how far the pointer went (px) since the press,
 * at most once a frame and once more on release. */
export function startPointerDrag(event: { clientX: number; clientY: number }, onMove: (dx: number, dy: number) => void) {
    const start = { x: event.clientX, y: event.clientY }
    let frame = 0
    let last = { x: 0, y: 0 }
    const move = (pointer: PointerEvent) => {
        last = { x: pointer.clientX - start.x, y: pointer.clientY - start.y }
        if (!frame) {
            frame = requestAnimationFrame(() => {
                frame = 0
                onMove(last.x, last.y)
            })
        }
    }
    const up = () => {
        removeEventListener("pointermove", move)
        removeEventListener("pointerup", up)
        removeEventListener("pointercancel", up)
        cancelAnimationFrame(frame)
        globalThis.document?.body.classList.remove("panel-dragging")
        onMove(last.x, last.y)
    }
    globalThis.document?.body.classList.add("panel-dragging")
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
    addEventListener("pointercancel", up)
}

/**
 * A popover menu's place (fixed, so a panel's clipping never cuts it): under the button that opened it, its right edge
 * on the button's, or above the button when there's more room there; always inside the window.
 */
export function popoverPosition(anchor: Element | null | undefined, width: number, viewport = { width: globalThis.innerWidth || 1280, height: globalThis.innerHeight || 800 }): CSSProperties {
    const box = anchor?.getBoundingClientRect()
    if (!box) {
        return { position: "fixed", right: 8, top: 8, width, zIndex: 40 }
    }
    const left = Math.round(Math.max(8, Math.min(box.right - width, viewport.width - width - 8)))
    const below = viewport.height - box.bottom - 8, above = box.top - 8
    return below >= Math.min(320, above)
        ? { position: "fixed", left, top: Math.round(box.bottom + 4), width, maxHeight: Math.max(120, below - 4), zIndex: 40 }
        : { position: "fixed", left, bottom: Math.round(viewport.height - box.top + 4), width, maxHeight: Math.max(120, above - 4), zIndex: 40 }
}
