// The page's one bar, along the bottom (desktop): STOP on the left, Go to (dimos's named locations, when it has them) and the gamepad beside it (a click remaps it) and,
// disengaged, why and Reconnect; the link's chip in the middle (it opens the Network modal); on the right the chips
// that only show when they matter (the lease, TF trouble, a busy CPU), Record, the battery and the Settings button, whose number counts the streams a
// never-used kind of panel could show (ui/panelCatalog.ts). A panel's own buttons are in the panel, never here. A phone
// keeps its thumb sticks and corner buttons (ui/DriveHud.tsx, ui/PhoneCorners.tsx).
import { useEffect, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Button, Kbd } from "dimos-react"
import { Icon } from "./icons.tsx"
import { BatteryChip, GamepadChip, LinkChip, StatusChips } from "./BarChips.tsx"
import { RecordControl } from "./RecordControl.tsx"
import { GoToNamed } from "./GoToNamed.tsx"
import { DisengagedNotice } from "./DriveHud.tsx"
import type { WorkspaceApi } from "./Workspace.tsx"
import { openSettingsDrawer, settingsDrawer, useShown } from "./SettingsDrawer.tsx"
import { loadUsedKinds, type PanelKind, saveUsedKinds, settingsBadge } from "./panelCatalog.ts"

export function TopBar({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    useStore(app.robot)
    const arm = app.profile.type === "arm"
    const halt = useStore(app.drive.state).halt
    const stop = () => (arm ? app.arm.stop() : app.drive.stop())
    return (
        <header className="main-bar" data-testid="main-bar">
            <div className="main-bar-side left">
                <Button className="top-stop" data-testid="stop-button" title="Stop now (Space, always)" onPointerDown={stop} onClick={stop}>
                    <span>STOP</span>
                    <Kbd className="lv-kbd">Space</Kbd>
                </Button>
                <GoToNamed app={app} />
                <GamepadChip />
                {halt && !arm && <DisengagedNotice app={app} halt={halt} />}
            </div>
            <div className="main-bar-middle"><LinkChip app={app} /></div>
            <div className="main-bar-side right">
                <StatusChips app={app} api={api} battery={false} gamepad={false} />
                <RecordControl app={app} />
                <BatteryChip />
                <SettingsButton app={app} api={api} />
            </div>
        </header>
    )
}

function SettingsButton({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    const { open, placing } = useStore(settingsDrawer)
    const { topics } = useStore(app.connection.status)
    const shown = useShown(api)
    // a kind counts as used once any panel of it has been open on this device
    const [used, setUsed] = useState(loadUsedKinds)
    const openKinds = [...shown.open].sort().join("|")
    useEffect(() => {
        const next = new Set<PanelKind>([...used, ...shown.open])
        if (next.size !== used.size) {
            saveUsedKinds(next)
            setUsed(next)
        }
    }, [openKinds])
    const badge = settingsBadge(topics, shown, used)
    return (
        <Button className="top-settings" data-testid="settings-button" pressed={open || !!placing} title={badge ? `Settings and panels: ${badge} stream${badge === 1 ? "" : "s"} a panel could show` : "Settings and panels"} onClick={() => (open || placing ? settingsDrawer.set({ open: false, placing: null, pointer: null }) : openSettingsDrawer())}>
            <Icon name="settings" size={15} />
            <span>Settings</span>
            {badge > 0 && <span className="count-badge" data-testid="settings-badge">{badge}</span>}
        </Button>
    )
}

