// A phone has no bar across the top or a dock (the thumb sticks and STOP take the bottom): the rails' drawers, Record
// and the palette sit over the main view's top corners, and the problem and gamepad chips between them.
import type { ViewerApp } from "../core/app.ts"
import { BarChips } from "./BarChips.tsx"
import { Icon } from "./icons.tsx"
import { openOverlay } from "./overlay.ts"
import { RecordControl } from "./RecordControl.tsx"
import type { WorkspaceApi } from "./Workspace.tsx"

export function PhoneCorners({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    return (
        <div className="phone-corners" data-testid="phone-corners">
            <button type="button" className={`dim-btn icon corner-button ${api.view.drawer === "left" ? "on" : ""}`} aria-label="Left panels" title="Left panels ([)" aria-expanded={api.view.drawer === "left"} onClick={() => api.toggleRail("left")}>
                <Icon name="panels" size={18} />
            </button>
            <div className="corner-chips"><BarChips app={app} api={api} /></div>
            <RecordControl app={app} />
            <button type="button" className="dim-btn icon corner-button" aria-label="Command palette" title="Command palette (/)" onClick={() => openOverlay("palette")} data-testid="open-palette">
                <Icon name="search" size={17} />
            </button>
            <button type="button" className={`dim-btn icon corner-button ${api.view.drawer === "right" ? "on" : ""}`} aria-label="Right panels" title="Right panels (])" aria-expanded={api.view.drawer === "right"} onClick={() => api.toggleRail("right")}>
                <Icon name="settings" size={18} />
            </button>
        </div>
    )
}
