// The page's one bar, along the bottom (desktop): on the left the drive keys lighting up as they're held with what's
// being sent (or, disengaged, why and Reconnect; or why nothing can be driven yet) and Record (away from STOP); in the middle the main view's own
// actions (ui/dockActions.ts: a camera's, the 3D view's or the map's), focus and the palette; on the right the problem
// and gamepad chips (ui/BarChips.tsx), the shortcut list and STOP, always in the same corner. The two sides
// share the width equally, so the middle stays centred. On a phone the bar is the two thumb sticks with STOP between
// them (ui/DriveHud.tsx) and the rest sits over the main view's top corners (ui/PhoneCorners.tsx).
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { dockActions, dockActionsFor } from "./dockActions.ts"
import { ArmHud } from "./ArmHud.tsx"
import { DriveKeys } from "./DriveHud.tsx"
import { JointDock } from "./JointControl.tsx"
import { Icon } from "./icons.tsx"
import { openOverlay } from "./overlay.ts"
import type { WorkspaceApi } from "./Workspace.tsx"
import { BarChips } from "./BarChips.tsx"
import { RecordControl } from "./RecordControl.tsx"
import type { Onboarding } from "./Onboarding.tsx"
import { openApp } from "dimos-react/dim-app/desktop.js"
import { Button, Kbd } from "dimos-react"

export function ActionDock({ app, api, onboarding }: { app: ViewerApp; api: WorkspaceApi; onboarding: Onboarding }) {
    useStore(app.robot)
    const actions = dockActionsFor(useStore(dockActions), api.arrangement.stage)
    const arm = app.profile.type === "arm"
    const focused = api.view.hide.length === 2
    const stop = () => (arm ? app.arm.stop() : app.drive.stop())
    return (
        <footer className="action-dock" data-testid="action-dock">
            <div className="dock-group dock-drive-slot">
                {onboarding.blocksDriving
                    ? <NothingToDrive onboarding={onboarding} />
                    : arm
                    ? <ArmHud app={app} mobile={false} />
                    : <><DriveKeys app={app} />{app.profile.joint && <JointDock app={app} />}</>}
                <RecordControl app={app} />
            </div>
            <div className="dock-group dock-actions" role="toolbar" aria-label="Actions">
                {actions.map((action) => (
                    <Button
                        key={action.id}
                        size="sm"
                        className="dock-action main-action"
                        data-action={action.id}
                        pressed={action.pressed}
                        title={action.title}
                        onClick={action.run}
                    >
                        <Icon name={action.icon} size={15} />
                        <span>{action.label}</span>
                    </Button>
                ))}
                <Button size="sm" className="dock-action" pressed={focused} title="Focus the main view: hide both rails (\\)" onClick={api.toggleFocus}><Icon name={focused ? "fullscreen-exit" : "fullscreen"} size={15} /><span>Focus</span></Button>
                <Button size="sm" className="dock-action" title="Every action, searchable (/)" onClick={() => openOverlay("palette")}><Icon name="search" size={15} /><span>All actions</span><Kbd className="lv-kbd">/</Kbd></Button>
            </div>
            <div className="dock-stop-slot">
                <BarChips app={app} api={api} />
                <Button className="dr-btn--icon dock-help" title="Keyboard and gamepad shortcuts (?)" aria-label="Shortcuts" onClick={() => openOverlay("help")}>
                    <Icon name="keyboard" size={16} />
                </Button>
                <Button className="dock-stop" data-testid="stop-button" title="Stop now (Space, always)" onPointerDown={stop} onClick={stop}>
                    <span>STOP</span>
                    <Kbd className="lv-kbd">Space</Kbd>
                </Button>
            </div>
        </footer>
    )
}

/** Why nothing can be driven yet, in its own words (the same state as the first-run message), and where to fix it. */
function NothingToDrive({ onboarding }: { onboarding: Onboarding }) {
    return (
        <span className="dock-note" data-testid="dock-nothing-to-drive">
            <span className="hint">Nothing to drive yet: {onboarding.reason ?? "no robot to drive"}.</span>
            {onboarding.launch && (
                <Button size="sm" onClick={() => void openApp("launcher", onboarding.launch)}>Open the Launcher</Button>
            )}
        </span>
    )
}
