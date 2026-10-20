// A phone has no bar across the top or a dock (the thumb sticks and STOP take the bottom): the panel list, Record, the
// palette and the right drawer sit over the main view's top corners, and the problem and gamepad chips between them.
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ViewerApp } from "../core/app.ts"
import { BarChips } from "./BarChips.tsx"
import { Button, Card } from "dimos-react"
import { panelTitle } from "./commands.ts"
import { Icon } from "./icons.tsx"
import { openOverlay } from "./overlay.ts"
import { popoverPosition } from "./panelDrag.ts"
import { RecordControl } from "./RecordControl.tsx"
import type { WorkspaceApi } from "./Workspace.tsx"
import { isCamera } from "./workspace.ts"

export function PhoneCorners({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    return (
        <div className="phone-corners" data-testid="phone-corners">
            <PanelList api={api} />
            <div className="corner-chips"><BarChips app={app} api={api} /></div>
            <RecordControl app={app} />
            <Button className="dr-btn--icon corner-button" aria-label="Command palette" title="Command palette (/)" onClick={() => openOverlay("palette")} data-testid="open-palette">
                <Icon name="search" size={17} />
            </Button>
            <Button className="dr-btn--icon corner-button" pressed={api.view.drawer === "right"} aria-label="Right panels" title="Right panels (])" aria-expanded={api.view.drawer === "right"} onClick={() => api.toggleRail("right")}>
                <Icon name="settings" size={18} />
            </Button>
        </div>
    )
}

const PANEL_ICONS: Record<string, string> = { scene: "cube", map: "map", status: "signal", settings: "settings", arms: "arm", tf: "tree" }

/** Every panel (a phone's main view has no header): a tap makes one the main view, its float button floats it over the main view. */
function PanelList({ api }: { api: WorkspaceApi }) {
    const [open, setOpen] = useState(false)
    const button = useRef<HTMLButtonElement>(null)
    useEffect(() => {
        if (!open) {
            return
        }
        const close = (event: Event) => {
            if (!(event.target as HTMLElement).closest?.(".view-switch, .view-menu")) {
                setOpen(false)
            }
        }
        addEventListener("pointerdown", close, true)
        return () => removeEventListener("pointerdown", close, true)
    }, [open])
    const stage = api.arrangement.stage
    const iconOf = (id: string) => isCamera(id) ? "camera" : PANEL_ICONS[id] ?? "panels"
    const floating = (id: string) => api.arrangement.floating.some((box) => box.id === id)
    return (
        <>
            <Button
                ref={button}
                className="dr-btn--icon corner-button view-switch"
                pressed={open}
                aria-label="Panels"
                title={`Panels${stage ? `: ${panelTitle(stage)} is the main view` : ""}`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                data-testid="panel-list"
            >
                <Icon name={stage ? iconOf(stage) : "panels"} size={17} />
                <Icon name="chevron-down" size={12} />
            </Button>
            {open && createPortal(
                <Card padded={false} className="quality-menu view-menu" role="menu" aria-label="Panels" style={popoverPosition(button.current, 260)}>
                    {api.ids.map((id) => (
                        <div key={id} className={`view-row ${stage === id ? "on" : ""}`}>
                            <button
                                type="button"
                                role="menuitemradio"
                                aria-checked={stage === id}
                                className={`quality-option ${stage === id ? "on" : ""}`}
                                title="Make this the main view"
                                onClick={() => {
                                    api.act(id, "main")
                                    setOpen(false)
                                }}
                            >
                                <span className="quality-name"><Icon name={iconOf(id)} size={14} />{panelTitle(id)}</span>
                            </button>
                            <Button
                                className="dr-btn--icon icon-button view-float"
                                pressed={floating(id)}
                                disabled={stage === id}
                                title={floating(id) ? "Close its floating window" : "Float it over the main view"}
                                aria-label={`${panelTitle(id)}: ${floating(id) ? "close its floating window" : "float"}`}
                                onClick={() => {
                                    api.act(id, "popout")
                                    setOpen(false)
                                }}
                            >
                                <Icon name="float" size={15} />
                            </Button>
                        </div>
                    ))}
                </Card>,
                document.body,
            )}
        </>
    )
}
