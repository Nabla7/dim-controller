// Every panel's frame, the same everywhere: a header (its icon and title, a live note, then its buttons in the same
// place on every panel: collapse / expand, make it the main view, pop out / dock; shown while the panel is hovered, and
// always on a touch screen), an optional row of the panel's own tools over the top of its body (like its other in-panel
// buttons, .panel-chrome: shown while the panel is hovered, on touch for a few seconds after a tap), and its body. The workspace (ui/Workspace.tsx)
// gives it its box; dragging the header moves it (rails, main view, floating; ui/workspace.ts snaps it), a double-click
// on the header collapses it (on the main view: focus), and a floating panel resizes from its corner. Hidden (a shut
// drawer, a rail hidden by focus) it stays mounted, so its element is never rebuilt. A phone's main view has no header
// (the top bar's view switch picks it): its live note sits in the tools row.
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Button } from "dimos-react"
import { Icon } from "./icons.tsx"
import { panelActions, type PanelAction } from "./commands.ts"
import { useWorkspaceApi } from "./Workspace.tsx"
import { arrange, clampFloat, FLOAT_MIN, movePanel, normalizeArrangement, homeOf } from "./workspace.ts"
import { DRAG_SLOP } from "./panelDrag.ts"
import { startPointerDrag } from "./panelDrag.ts"

const ACTION_ICONS: Record<PanelAction, (state: { collapsed: boolean; floating: boolean; zone: string; home: string }) => string> = {
    collapse: ({ collapsed }) => collapsed ? "chevron-down" : "chevron-up",
    // make it the main view: a chevron toward the middle of the screen, where the main view is (a left rail's points
    // right); unlike fit / fill's frames, nothing here looks like a picture
    main: ({ zone }) => zone === "left" ? "chevron-right" : "chevron-left",
    // the main view back to its rail: a chevron toward that rail
    minimize: ({ home }) => home === "left" ? "chevron-left" : "chevron-right",
    popout: ({ floating }) => floating ? "dock" : "float",
}

/** how long a tap keeps a panel's in-panel buttons shown */
const TOUCH_SHOW_MS = 4000

export function Panel({ id, title, icon, info, tools, children, className = "", bodyClassName = "", testid, onBodyClick }: {
    id: string
    title: string
    icon: string
    /** a short live note in the header (resolution, rate, source) */
    info?: ReactNode
    /** the panel's own controls: a row under the header (not while folded) */
    tools?: ReactNode
    children?: ReactNode
    className?: string
    bodyClassName?: string
    testid?: string
    onBodyClick?: () => void
}) {
    const api = useWorkspaceApi()
    const element = useRef<HTMLDivElement>(null)
    const pressedAt = useRef<{ x: number; y: number } | null>(null)
    // touch has no hover: a tap on the panel shows its in-panel buttons (.panel-chrome) for a few seconds
    const [touched, setTouched] = useState(false)
    const untouch = useRef<ReturnType<typeof setTimeout>>(undefined)
    useEffect(() => () => clearTimeout(untouch.current), [])
    const onTouch = (event: { pointerType: string }) => {
        if (event.pointerType !== "mouse") {
            setTouched(true)
            clearTimeout(untouch.current)
            untouch.current = setTimeout(() => setTouched(false), TOUCH_SHOW_MS)
        }
    }
    const slot = api.layout.slots[id]
    if (!slot) {
        return null
    }
    const onStage = slot.zone === "stage"
    const floating = slot.zone === "float"
    const headless = api.mobile && onStage
    const states = panelActions(api.arrangement, id, { mobile: api.mobile })
    const fromControl = (target: EventTarget) => !!(target as HTMLElement).closest("button, select, input, label, textarea, [role=tab]")
    const classes = ["lv-panel", `zone-${slot.zone}`, slot.collapsed ? "collapsed" : "", slot.hidden ? "hidden" : "", touched ? "touched" : "", headless ? "headless" : "", className]
    return (
        <section
            ref={element}
            className={classes.filter(Boolean).join(" ")}
            style={{ left: slot.rect.x, top: slot.rect.y, width: slot.rect.width, height: slot.rect.height }}
            data-panel={id}
            data-testid={testid}
            aria-hidden={slot.hidden || undefined}
            aria-label={title}
            onPointerDownCapture={onTouch}
        >
            {!headless && <header
                className="panel-head"
                onPointerDown={(event) => {
                    pressedAt.current = { x: event.clientX, y: event.clientY }
                    return !fromControl(event.target) && element.current && api.startDrag(id, event, element.current)
                }}
                // a click (not the end of a drag) folds or unfolds a rail or floating panel; the main view's double-click focuses
                onClick={(event) => {
                    const press = pressedAt.current
                    const moved = !press || Math.hypot(event.clientX - press.x, event.clientY - press.y) >= DRAG_SLOP
                    if (!onStage && !moved && !fromControl(event.target)) {
                        api.act(id, "collapse")
                    }
                }}
                onDoubleClick={(event) => onStage && !fromControl(event.target) && api.toggleFocus()}
                title={api.mobile ? undefined : "Drag to move: into a rail, onto the main view's middle, or anywhere to float"}
            >
                <span className="panel-title"><Icon name={icon} size={14} /><span>{title}</span></span>
                {info !== undefined && <span className="panel-info">{info}</span>}
                <span className="panel-actions" role="toolbar" aria-label={`${title} panel`}>
                    {states.map((state) => (
                        <Button
                            key={state.action}
                            className={`dr-btn--icon icon-button panel-action action-${state.action}`}
                            data-action={state.action}
                            title={state.label}
                            aria-label={`${title}: ${state.label}`}
                            onClick={() => api.act(id, state.action)}
                        >
                            <Icon name={ACTION_ICONS[state.action]({ collapsed: slot.collapsed, floating, zone: slot.zone, home: homeOf(id).side })} size={14} />
                        </Button>
                    ))}
                </span>
            </header>}
            {(tools || headless && info) && !slot.collapsed && (
                <div className="panel-tools panel-chrome">{tools}{headless && info !== undefined && <span className="panel-info">{info}</span>}</div>
            )}
            <div className={`panel-content ${bodyClassName}`} onClick={onBodyClick}>{children}</div>
            {floating && !slot.collapsed && !api.mobile && (
                <div
                    className="panel-resize"
                    title="Drag to resize"
                    aria-label="Resize"
                    onPointerDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        const start = slot.rect
                        startPointerDrag(event, (dx, dy) => {
                            const box = clampFloat({ ...start, width: Math.max(FLOAT_MIN.width, start.width + dx), height: Math.max(FLOAT_MIN.height, start.height + dy) }, api.layout.area)
                            arrange((current) => movePanel(normalizeArrangement(current, api.ids), id, { zone: "float", box: { ...box, x: start.x, y: start.y } }))
                        })
                    }}
                />
            )}
        </section>
    )
}

