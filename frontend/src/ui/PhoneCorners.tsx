// A phone has no bar across the top or a dock (the thumb sticks and STOP take the bottom): the panel list, Record, Go
// to (dimos's named locations, when it has them), the palette and Settings sit over the main view's top corners, and the problem and gamepad chips between them. A phone
// shows one panel at a time (no layout): the list switches between one of each kind.
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
import { GoToNamed } from "./GoToNamed.tsx"
import type { WorkspaceApi } from "./Workspace.tsx"
import { phonePanel } from "./workspace.ts"
import { kindOf, PANEL_KINDS, type PanelKind } from "./panelCatalog.ts"
import { addCameraPanel } from "./CameraPanels.tsx"
import { addPlot } from "./PlotPanel.tsx"
import { useStore } from "../core/store.ts"

export function PhoneCorners({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    const shown = phonePanel(api.arrangement)
    return (
        <div className="phone-corners" data-testid="phone-corners">
            <PanelList app={app} api={api} />
            <div className="corner-chips"><BarChips app={app} api={api} /></div>
            <RecordControl app={app} />
            <GoToNamed app={app} className="corner-button" />
            <Button className="dr-btn--icon corner-button" aria-label="Command palette" title="Command palette (/)" onClick={() => openOverlay("palette")} data-testid="open-palette">
                <Icon name="search" size={17} />
            </Button>
            <Button className="dr-btn--icon corner-button" pressed={shown === "settings"} aria-label="Settings" title="Settings" onClick={() => api.act(shown === "settings" ? api.arrangement.previousStage ?? firstOf(api, "camera") ?? "settings" : "settings", "main")}>
                <Icon name="settings" size={18} />
            </Button>
        </div>
    )
}

/** the first open panel of this kind (cameras and plots can be many: the phone shows the first) */
const firstOf = (api: WorkspaceApi, kind: PanelKind) => api.ids.find((id) => kindOf(id) === kind) ?? null

/** One of each kind of panel (a phone's main view has no header): a tap shows it, making a camera or plot if there's none. */
function PanelList({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    const [open, setOpen] = useState(false)
    const button = useRef<HTMLButtonElement>(null)
    const { topics } = useStore(app.connection.status)
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
    const shown = phonePanel(api.arrangement)
    const shownKind = shown ? kindOf(shown) : null
    const pick = (kind: PanelKind) => {
        const id = firstOf(api, kind) ?? (kind === "camera" ? addCameraPanel(topics, app.profile.cameras.preferred) : kind === "plot" ? addPlot() : kind)
        api.act(id, "main")
        setOpen(false)
    }
    // nothing to show: a phone starts on a camera
    useEffect(() => {
        if (!shown) {
            pick("camera")
        }
    }, [shown])
    const iconOfKind = (kind: PanelKind | null) => PANEL_KINDS.find((one) => one.kind === kind)?.icon ?? "panels"
    return (
        <>
            <Button
                ref={button}
                className="dr-btn--icon corner-button view-switch"
                pressed={open}
                aria-label="Panels"
                title={`Panels${shown ? `: showing ${panelTitle(shown)}` : ""}`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                data-testid="panel-list"
            >
                <Icon name={iconOfKind(shownKind)} size={17} />
                <Icon name="chevron-down" size={12} />
            </Button>
            {open && createPortal(
                <Card padded={false} className="quality-menu view-menu" role="menu" aria-label="Panels" style={popoverPosition(button.current, 260)}>
                    {PANEL_KINDS.map(({ kind, title, icon }) => (
                        <div key={kind} className={`view-row ${shownKind === kind ? "on" : ""}`}>
                            <button
                                type="button"
                                role="menuitemradio"
                                aria-checked={shownKind === kind}
                                className={`quality-option ${shownKind === kind ? "on" : ""}`}
                                data-kind={kind}
                                onClick={() => pick(kind)}
                            >
                                <span className="quality-name"><Icon name={icon} size={14} />{title}</span>
                            </button>
                        </div>
                    ))}
                </Card>,
                document.body,
            )}
        </>
    )
}
