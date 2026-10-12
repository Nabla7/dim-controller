// Every panel's frame, the same everywhere: a header (its icon and title, a live note, then its buttons in the same
// place on every panel: collapse / expand, make it the main view, pop out / dock; shown while the panel is hovered, and
// always on a touch screen), an optional row of the panel's own tools over the top of its body (like its other in-panel
// buttons, .panel-chrome: shown while the panel is hovered, on touch for a few seconds after a tap), and its body. The workspace (ui/Workspace.tsx)
// gives it its box; dragging the header moves it (rails, main view, floating; ui/workspace.ts snaps it), a double-click
// on the header collapses it (on the main view: focus), and a floating panel resizes from its corner. Hidden (a shut
// drawer, a rail hidden by focus) it stays mounted, so its element is never rebuilt.
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Icon } from "./icons.tsx"
import { panelActions, type PanelAction } from "./commands.ts"
import { useWorkspaceApi } from "./Workspace.tsx"
import { arrange, clampFloat, FLOAT_MIN, movePanel, normalizeArrangement } from "./workspace.ts"
import { startPointerDrag } from "./panelDrag.ts"

const ACTION_ICONS: Record<PanelAction, (state: { collapsed: boolean; floating: boolean }) => string> = {
    collapse: ({ collapsed }) => collapsed ? "chevron-down" : "chevron-up",
    main: () => "main",
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
    const states = panelActions(api.arrangement, id, { mobile: api.mobile })
    const fromControl = (target: EventTarget) => !!(target as HTMLElement).closest("button, select, input, label, textarea, [role=tab]")
    const classes = ["lv-panel", `zone-${slot.zone}`, slot.collapsed ? "collapsed" : "", slot.hidden ? "hidden" : "", touched ? "touched" : "", className]
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
            <header
                className="panel-head"
                onPointerDown={(event) => !fromControl(event.target) && element.current && api.startDrag(id, event, element.current)}
                onDoubleClick={(event) => !fromControl(event.target) && (onStage ? api.toggleFocus() : api.act(id, "collapse"))}
                title={api.mobile ? undefined : "Drag to move: into a rail, onto the main view's middle, or anywhere to float"}
            >
                <span className="panel-title"><Icon name={icon} size={14} /><span>{title}</span></span>
                {info !== undefined && <span className="panel-info">{info}</span>}
                <span className="panel-actions" role="toolbar" aria-label={`${title} panel`}>
                    {states.map((state) => (
                        <button
                            key={state.action}
                            type="button"
                            className={`dim-btn icon icon-button panel-action action-${state.action}`}
                            data-action={state.action}
                            title={state.label}
                            aria-label={`${title}: ${state.label}`}
                            onClick={() => api.act(id, state.action)}
                        >
                            <Icon name={ACTION_ICONS[state.action]({ collapsed: slot.collapsed, floating })} size={14} />
                        </button>
                    ))}
                </span>
            </header>
            {tools && !slot.collapsed && <div className="panel-tools panel-chrome">{tools}</div>}
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

