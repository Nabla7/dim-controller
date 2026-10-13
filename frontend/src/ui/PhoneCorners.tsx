// A phone has no bar across the top or a dock (the thumb sticks and STOP take the bottom): the rails' drawers, the view
// switch, Record and the palette sit over the main view's top corners, and the problem and gamepad chips between them.
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { cameraTabs } from "../core/cameraChoice.ts"
import { BarChips } from "./BarChips.tsx"
import { Button, Card } from "dimos-react"
import { cameraLayout, cameraPanels, useCameraActions } from "./CameraPanels.tsx"
import { Icon } from "./icons.tsx"
import { openOverlay } from "./overlay.ts"
import { popoverPosition } from "./panelDrag.ts"
import { RecordControl } from "./RecordControl.tsx"
import type { WorkspaceApi } from "./Workspace.tsx"
import { cameraId, isCamera } from "./workspace.ts"

export function PhoneCorners({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    return (
        <div className="phone-corners" data-testid="phone-corners">
            <Button className="dr-btn--icon corner-button" pressed={api.view.drawer === "left"} aria-label="Left panels" title="Left panels ([)" aria-expanded={api.view.drawer === "left"} onClick={() => api.toggleRail("left")}>
                <Icon name="panels" size={18} />
            </Button>
            <ViewSwitch app={app} api={api} />
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

/** What the main view shows (a phone's main view has no header): any camera on the bus, the 3D view or the map. */
function ViewSwitch({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    const { topics } = useStore(app.connection.status)
    const layout = useStore(cameraLayout)
    const cameras = useCameraActions(app)
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
    const stageKey = stage && isCamera(stage) ? cameraPanels(layout).find((panel) => cameraId(panel.id) === stage)?.key : undefined
    const showCamera = (key: string) => {
        // showTopic points the main camera (camera 1 when the main view isn't a camera), which then takes the main view
        cameras.showTopic(key)
        if (!stage || !isCamera(stage)) {
            api.act(cameraId(1), "main")
        }
    }
    const options = [
        ...cameraTabs(topics).map((tab) => ({ id: tab.topic.key, label: tab.label, about: `${tab.depth ? "depth · " : ""}${tab.topic.name === `/${tab.label}` ? "" : tab.topic.name}`, icon: "camera", on: tab.topic.key === stageKey, run: () => showCamera(tab.topic.key) })),
        ...(["scene", "map"] as const).map((id) => ({ id, label: id === "scene" ? "3D view" : "Map", about: "", icon: id === "scene" ? "cube" : "map", on: stage === id, run: () => api.act(id, "main") })),
    ]
    const current = options.find((option) => option.on)
    return (
        <>
            <Button
                ref={button}
                className="dr-btn--icon corner-button view-switch"
                pressed={open}
                aria-label="Switch view"
                title={`Switch view${current ? `: ${current.label}` : ""}`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <Icon name={current?.icon ?? (stage && isCamera(stage) ? "camera" : "main")} size={17} />
                <Icon name="chevron-down" size={12} />
            </Button>
            {open && createPortal(
                <Card padded={false} className="quality-menu view-menu" role="menu" aria-label="Switch view" style={popoverPosition(button.current, 260)}>
                    <div className="quality-title">Main view</div>
                    {options.map((option) => (
                        <button
                            type="button"
                            key={option.id}
                            role="menuitemradio"
                            aria-checked={option.on}
                            className={`quality-option ${option.on ? "on" : ""}`}
                            onClick={() => {
                                option.run()
                                setOpen(false)
                            }}
                        >
                            <span className="quality-name">{option.label}</span>
                            {option.about && <span className="quality-about">{option.about}</span>}
                        </button>
                    ))}
                </Card>,
                document.body,
            )}
        </>
    )
}
