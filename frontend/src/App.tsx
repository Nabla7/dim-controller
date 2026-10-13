// The page: the workspace (a main view between a left and a right rail, panels that can float over it; ui/workspace.ts)
// and one bar along the bottom (ui/ActionDock.tsx): the drive keys, the main view's actions, the problem chips, Record
// and STOP. No bar across the top: the Status panel has the link, what's running and the rates.
// Every panel has the same frame and the same header actions (ui/Panel.tsx); everything is also in the `/` palette, and `?` lists the keys. On a
// phone the rails are drawers and driving is two thumb sticks.
import { type PointerEvent, useEffect, useRef, useState } from "react"
import { ViewerApp } from "./core/app.ts"
import { Store, useStore } from "./core/store.ts"
import { ActionDock } from "./ui/ActionDock.tsx"
import { PhoneCorners } from "./ui/PhoneCorners.tsx"
import { CameraPanels, cameraLayout, useCameraActions } from "./ui/CameraPanels.tsx"
import { MapPanel } from "./ui/MapPanel.tsx"
import { DriveHud } from "./ui/DriveHud.tsx"
import { useKeyboard } from "./ui/useKeyboard.ts"
import { useArmKeys } from "./ui/useArmKeys.ts"
import { useGamepad } from "./ui/useGamepad.ts"
import { SteamDeckBanner } from "./ui/SteamDeckBanner.tsx"
import { ArmHud } from "./ui/ArmHud.tsx"
import { useLockedViewport, useMobile } from "./ui/useMobile.ts"
import { StatsOverlay } from "./ui/StatsOverlay.tsx"
import { SceneMenu } from "./ui/SceneMenu.tsx"
import { ScenePanel } from "./ui/ScenePanel.tsx"
import { InfoPanels } from "./ui/InfoPanels.tsx"
import { EmptyLayer, useOnboarding } from "./ui/Onboarding.tsx"
import { Overlays } from "./ui/Overlays.tsx"
import { rectStyle, useWorkspace, type WorkspaceApi, WorkspaceContext, WorkspaceSurface } from "./ui/Workspace.tsx"
import { cameraId, FIXED_PANELS } from "./ui/workspace.ts"
import { openOverlay } from "./ui/overlay.ts"
import { ContainCrash } from "./ui/Unavailable.tsx"

declare global {
    interface Window {
        __lv?: ViewerApp
    }
}

export function App() {
    const host = useRef<HTMLDivElement>(null)
    const [app, setApp] = useState<ViewerApp | null>(null)
    const mobile = useMobile()
    useLockedViewport(mobile)

    useEffect(() => {
        const created = new ViewerApp(host.current!)
        window.__lv = created
        setApp(created)
        // DimThemeProvider applies Desktop's skin and fires `dimos-react-theme` on every change
        const theme = () => {
            document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.body).getPropertyValue("--bg").trim())
            created.viewer.setTheme()
        }
        theme()
        addEventListener("dimos-react-theme", theme)
        return () => removeEventListener("dimos-react-theme", theme)
    }, [])

    const cameras = useStore(cameraLayout)
    const ids = [...cameras.panels.map((panel) => cameraId(panel.id)), ...FIXED_PANELS]
    const cameraActions = useCameraActions(app)
    const api = useWorkspace(ids, mobile)
    const robot = useStore(app?.robot ?? placeholderRobot)
    // the profile changes with the robot type: keys follow it
    const profile = app && robot ? app.profile : null
    useKeyboard(profile?.type === "arm" ? null : app?.drive ?? null, profile?.type === "arm" ? null : profile, api, app?.joy ?? null, profile?.joint ? app?.arm ?? null : null)
    useArmKeys(app?.arm ?? null, profile?.type === "arm" ? profile : null)
    useGamepad(app)

    return (
        <WorkspaceContext.Provider value={api}>
            <div className={`app ${mobile ? "mobile" : "desktop"}`} onPointerDownCapture={takeKeyboard}>
                {app && mobile && <PhoneCorners app={app} api={api} />}
                <div className="workspace">
                    <ContainCrash what="3D view"><ScenePanel host={host} app={app} onTf={() => api.act("tf", "show")} /></ContainCrash>
                    {app && (
                        <>
                            <ContainCrash what="Cameras"><CameraPanels app={app} /></ContainCrash>
                            <ContainCrash what="Map"><MapPanel app={app} /></ContainCrash>
                            <InfoPanels app={app} />
                        </>
                    )}
                    <WorkspaceSurface emptyStage={<EmptyStage />} />
                </div>
                {app && <Driving app={app} api={api} />}
                {app && <Overlays app={app} api={api} cameras={cameraActions} />}
                {app && <StatsOverlay app={app} />}
                <SteamDeckBanner />
                {app && <SceneMenu app={app} />}
            </div>
        </WorkspaceContext.Provider>
    )
}

const placeholderRobot = new Store({ type: "dog" as const, auto: true, reason: "" })

function EmptyStage() {
    return (
        <div className="ws-empty-note">
            <p>The main view is empty.</p>
            <p className="hint">Press a panel's <b>main view</b> button, drag a panel onto the middle here, or <button type="button" className="link" onClick={() => openOverlay("palette")}>open the palette (/)</button>.</p>
        </div>
    )
}

/** The dock (desktop) or the sticks (phone), and, until there's something to drive, the first-run message over the main view. */
function Driving({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    const onboarding = useOnboarding(app)
    const isArm = useStore(app.robot).type === "arm"
    return (
        <>
            {api.mobile
                ? !onboarding.blocksDriving && (isArm ? <ArmHud app={app} mobile /> : <DriveHud app={app} mobile />)
                : <ActionDock app={app} api={api} onboarding={onboarding} />}
            {/* over the main view only: an open drawer covers it */}
            {onboarding.message && !api.view.drawer && (
                <div className="stage-message" style={rectStyle(api.layout.stage)}>
                    <EmptyLayer {...onboarding.message} />
                </div>
            )}
        </>
    )
}

/** A click or tap on the view (not in a field) gives the Controller the keyboard, so WASD drives right away, even inside
 * Desktop's iframe. */
function takeKeyboard(event: PointerEvent) {
    const target = event.target as HTMLElement
    if (target.closest("input, textarea, select, [contenteditable]")) {
        return
    }
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && active.matches("input, textarea, select, [contenteditable]")) {
        active.blur()
    }
    globalThis.focus()
}
