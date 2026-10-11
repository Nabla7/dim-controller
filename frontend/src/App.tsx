// The page, in the layout picked in Settings (logic/layout.ts). Classic: the 3D view (or a camera) fills the screen and
// panels float over it. Cockpit, Split and Tiles: each region (camera, 3D view, map, drive, status, settings) docked in
// the box the layout gives it. On a phone the side panels become a bottom sheet and driving moves to on-screen sticks,
// whatever the layout. Every piece of UI is dimos-react's; this file only composes them.
import { type CSSProperties, type PointerEvent, type ReactNode, useEffect, useState } from "react"
import { EmptyState, ErrorBoundary, Icon, Text, useMobile, ViewPanel } from "dimos-react"
import { TfFeed } from "dimos-react/three"
import type { ControllerApp } from "./logic/controller.ts"
import { persistentStore, useStore } from "./logic/settings.ts"
import { TopBar } from "./ui/TopBar.tsx"
import { RecordControl } from "./ui/RecordControl.tsx"
import { type SidePlacement, SidePanel, type Tab } from "./ui/SidePanel.tsx"
import { CameraPanels, type CameraLayout, chooseLayout } from "./ui/CameraPanels.tsx"
import { MapPanel } from "./ui/MapPanel.tsx"
import { DriveHud } from "./ui/DriveHud.tsx"
import { useDriveKeys } from "./logic/useDriveKeys.ts"
import { useArmKeys } from "./logic/useArmKeys.ts"
import { ArmHud } from "./ui/ArmHud.tsx"
import { SceneMenu } from "./ui/SceneMenu.tsx"
import { ScenePanel } from "./ui/ScenePanel.tsx"
import { EmptyLayer, useOnboarding } from "./ui/Onboarding.tsx"
import { type Frame, layoutSettings, maximized, type Rect, type Region, regionRects, stickHeight, toggleMaximized, useLayout } from "./logic/layout.ts"
import { StatusPanel } from "./ui/StatusPanel.tsx"
import { SettingsPanel } from "./ui/SettingsPanel.tsx"
import { TfIssuesWatch } from "./ui/sceneState.tsx"

const cameraLayout = persistentStore<CameraLayout>("lv.cameras", { panels: [], main: null })

/** A docked panel's part of the layout (dimos-react ViewPanel's `dock`). */
export interface Dock {
    region: Region
    rect: Rect | null
    maximized: boolean
    onMaximize: () => void
    tiles?: { order: Region[]; onOrder: (order: Region[]) => void }
}

/** Keeps one view's crash in place (it says so there) instead of blanking the page. */
export function Contained({ what, children }: { what: string; children: ReactNode }) {
    return (
        <ErrorBoundary
            onError={(error: unknown) => console.error(`${what} crashed`, error)}
            fallback={({ error }: { error: Error }) => <EmptyState layer icon="warn" tone="danger" title={`${what} unavailable`} message={String(error?.message ?? error)} />}
        >
            {children}
        </ErrorBoundary>
    )
}

export function App({ app }: { app: ControllerApp }) {
    const mobile = useMobile(720)
    useLockedViewport(mobile)
    // no panel open at first: the 3D view gets the whole screen, and the Record button the top-left corner
    const [tab, setTab] = useState<Tab | null>(null)
    const cameras = useStore(cameraLayout)
    const robot = useStore(app.robot)
    const profile = robot ? app.profile : null
    useDriveKeys(app.drive, profile)
    useArmKeys(app.arm, profile?.type === "arm" ? profile : null)

    const layout = useLayout()
    const classic = layout.mode === "classic"
    const { region: maximizedRegion } = useStore(maximized)
    useEscapeRestores()
    // Tiles (desktop) has Settings as a tile: its tab maximizes that tile instead of opening a panel
    const settingsTile = layout.mode === "tiles" && !mobile
    const sideTab = settingsTile && tab === "settings" ? null : tab
    const frame = useFrame(mobile, layout.mode === "split" && sideTab !== null)
    const rects = regionRects(layout.mode, frame, layout.tiles, maximizedRegion)
    const dock = (region: Region): Dock | null =>
        classic ? null : {
            region,
            rect: rects[region] ?? null,
            maximized: maximizedRegion === region,
            onMaximize: () => toggleMaximized(region),
            tiles: layout.mode === "tiles" ? { order: layout.tiles, onOrder: (tiles) => layoutSettings.update({ tiles }) } : undefined,
        }
    // Classic only: a camera can take the screen (the 3D view becomes its picture-in-picture)
    const mainCamera = classic && cameras.main !== null && cameras.panels.some((panel) => panel.id === cameras.main)
    const sidePlacement: SidePlacement = mobile ? "sheet" : classic ? "side" : layout.mode === "split" ? "column" : "drawer"
    const onTab = (next: Tab) => {
        if (settingsTile && next === "settings") {
            toggleMaximized("settings")
            return
        }
        setTab(tab === next ? null : next)
    }
    const shownTab = settingsTile && maximizedRegion === "settings" ? "settings" : sideTab
    useEffect(() => {
        if (settingsTile) {
            setTab((open) => open === "settings" ? null : open)
        }
    }, [settingsTile])

    return (
        <div className={`app ${mobile ? "mobile" : "desktop"} layout-${layout.mode} ${classic ? (mainCamera ? "camera-main" : "scene-main") : "docked"}`} onPointerDownCapture={takeKeyboard}>
            {/* the TF tree is fed whether or not the 3D view is on: the map and the agent use it too */}
            <TfFeed tf={app.tf} />
            <TfIssuesWatch app={app} />
            <Contained what="3D view">
                <ScenePanel
                    app={app}
                    placement={classic ? (mainCamera ? "float" : "main") : "dock"}
                    dock={dock("scene")}
                    mobile={mobile}
                    onTf={() => setTab("tf")}
                    onMain={() => {
                        chooseLayout()
                        cameraLayout.update({ main: null, auto: false, autoPanel: null })
                    }}
                />
            </Contained>
            <TopBar app={app} tab={shownTab} onTab={onTab} />
            <RecordControl app={app} />
            {sideTab && <SidePanel app={app} tab={sideTab} onClose={() => setTab(null)} placement={sidePlacement} rect={rects.settings} />}
            <Contained what="Cameras">
                <CameraPanels app={app} layout={cameraLayout} mobile={mobile} dock={dock("camera")} />
            </Contained>
            <Contained what="Map">
                <MapPanel app={app} mobile={mobile} dock={dock("map")} />
            </Contained>
            {settingsTile && (
                <ViewPanel placement="dock" dock={dock("settings")} className="settings-tile" head={<span className="dr-view-panel-title"><Icon name="settings" size={14} />Settings</span>} bodyClassName="tile-body">
                    <SettingsPanel app={app} />
                </ViewPanel>
            )}
            {layout.mode === "tiles" && (
                <ViewPanel placement="dock" dock={dock("status")} className="status-tile" head={<span className="dr-view-panel-title"><Icon name="signal" size={14} />Status</span>} bodyClassName="tile-body">
                    <StatusPanel app={app} />
                </ViewPanel>
            )}
            <FirstRun app={app} mobile={mobile} dock={classic || mobile ? null : dock("drive")} tile={layout.mode === "tiles"} />
            <SceneMenu app={app} />
        </div>
    )
}

/** Escape gives a maximized region back to the layout (not while typing). */
function useEscapeRestores() {
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if (event.key === "Escape" && maximized.get().region && !(event.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]")) {
                maximized.set({ region: null })
            }
        }
        addEventListener("keydown", key)
        return () => removeEventListener("keydown", key)
    }, [])
}

/** The places a finger may still scroll on a phone (panels and menus); everywhere else is the view or a stick. */
const SCROLLABLE = ".side-body, .tile-body, .dr-popover, .dr-menu, .record-options, select"

/**
 * While driving from a phone the page must never pan or zoom under a thumb: iOS ignores user-scalable=no, so pinch
 * (gesture*) and a moving finger are stopped here outside the panels that scroll; double-tap zoom is touch-action's.
 */
function useLockedViewport(enabled: boolean) {
    useEffect(() => {
        if (!enabled) {
            return
        }
        const outsideScrollable = (event: Event) => !(event.target instanceof Element && event.target.closest(SCROLLABLE))
        const gesture = (event: Event) => event.preventDefault()
        const touchMove = (event: TouchEvent) => {
            if (event.touches.length > 1 || outsideScrollable(event)) {
                event.preventDefault()
            }
        }
        document.addEventListener("gesturestart", gesture, { passive: false })
        document.addEventListener("gesturechange", gesture, { passive: false })
        document.addEventListener("touchmove", touchMove, { passive: false })
        document.documentElement.classList.add("locked-viewport")
        return () => {
            document.removeEventListener("gesturestart", gesture)
            document.removeEventListener("gesturechange", gesture)
            document.removeEventListener("touchmove", touchMove)
            document.documentElement.classList.remove("locked-viewport")
        }
    }, [enabled])
}

/** The window as the layout sees it (logic/layout.ts Frame), measured again on a resize or a change of Desktop's dock. */
function useFrame(mobile: boolean, sidePanel: boolean): Frame {
    const [, setTick] = useState(0)
    useEffect(() => {
        const again = () => setTick((tick) => tick + 1)
        addEventListener("resize", again)
        // Desktop's dock moving sets --dim-inset-* on <html>
        const insets = new MutationObserver(again)
        insets.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] })
        const bar = new ResizeObserver(again)
        const watchBar = () => {
            const element = document.querySelector(".app-topbar")
            if (element) {
                bar.observe(element)
            }
            return !!element
        }
        const timer = watchBar() ? 0 : setInterval(() => watchBar() && clearInterval(timer), 200)
        return () => {
            removeEventListener("resize", again)
            insets.disconnect()
            bar.disconnect()
            clearInterval(timer)
        }
    }, [])
    const root = getComputedStyle(document.documentElement)
    const px = (name: string, fallback: number) => {
        const value = parseFloat(root.getPropertyValue(name))
        return Number.isFinite(value) ? value : fallback
    }
    const width = innerWidth, height = innerHeight
    return {
        width,
        height,
        top: document.querySelector(".app-topbar")?.getBoundingClientRect().bottom ?? (mobile ? 44 : 48),
        bottom: px("--dim-inset-bottom", 0),
        mobile,
        sticks: mobile ? stickHeight(width, height) : 0,
        sidePanel,
        gap: 8,
    }
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

/** The drive keys (or a phone's sticks), or (until there's something to drive) the first-run message that says what's
 * missing. A docked layout gives the keys a place (`dock`): a tile in Tiles, else a plain box (Split's rail, the
 * Cockpit's bottom middle); without one (Classic, a phone, another region maximized) they keep their own corner. */
function FirstRun({ app, mobile, dock, tile }: { app: ControllerApp; mobile: boolean; dock: Dock | null; tile: boolean }) {
    const onboarding = useOnboarding(app)
    const isArm = useStore(app.robot).type === "arm"
    const hud = onboarding.blocksDriving ? null : isArm ? <ArmHud app={app} mobile={mobile} /> : <DriveHud app={app} mobile={mobile} />
    let placed: ReactNode = hud
    if (dock?.rect && tile) {
        placed = (
            <ViewPanel placement="dock" dock={dock} className="drive-tile" head={<span className="dr-view-panel-title"><Icon name="drive" size={14} />Drive</span>} bodyClassName="drive-region-body">
                {hud ?? <Text muted small>Nothing to drive yet.</Text>}
            </ViewPanel>
        )
    } else if (dock?.rect && hud) {
        placed = <div className="drive-region" style={rectStyle(dock.rect)}>{hud}</div>
    }
    return (
        <>
            {placed}
            {onboarding.message && <EmptyLayer {...onboarding.message} />}
        </>
    )
}

const rectStyle = (rect: Rect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
