// A phone has no bar across the top or a dock (the thumb sticks and STOP take the bottom): the rails' drawers, Record
// and the palette sit over the main view's top corners, and the problem and gamepad chips between them.
import type { ViewerApp } from "../core/app.ts"
import { BarChips } from "./BarChips.tsx"
import { Button } from "dimos-react"
import { Icon } from "./icons.tsx"
import { openOverlay } from "./overlay.ts"
import { RecordControl } from "./RecordControl.tsx"
import type { WorkspaceApi } from "./Workspace.tsx"

export function PhoneCorners({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    return (
        <div className="phone-corners" data-testid="phone-corners">
            <Button className="dr-btn--icon corner-button" pressed={api.view.drawer === "left"} aria-label="Left panels" title="Left panels ([)" aria-expanded={api.view.drawer === "left"} onClick={() => api.toggleRail("left")}>
                <Icon name="panels" size={18} />
            </Button>
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
