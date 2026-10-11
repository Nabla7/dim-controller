// Connection state, live numbers, and the panel tabs. In Desktop's shell its window title already shows the icon and
// name, so the bar leaves them out.
import { Badge, Button, ConnectionStatus, IconButton, Tabs, TopBar as Bar } from "dimos-react"
import { splatFallback } from "dimos-react/three"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"
import { inDesktopShell } from "../dim-app/source/desktop.js"
import type { Tab } from "./SidePanel.tsx"
import { useSceneStats, useTfIssues } from "./sceneState.tsx"

// driving's settings are Settings' first section; recording is the Record button at the top left (RecordControl)
const TABS: { value: Tab; icon: string; label: string }[] = [
    { value: "tf", icon: "tree", label: "TF" },
    { value: "layers", icon: "layers", label: "Layers" },
    { value: "settings", icon: "settings", label: "Settings" },
]

export function TopBar({ app, tab, onTab }: { app: ControllerApp; tab: Tab | null; onTab: (tab: Tab) => void }) {
    const connection = useStore(app.connection.status)
    const stats = useSceneStats(app)
    const tfIssues = useTfIssues(app)
    const fallback = useStore(splatFallback) as { active: boolean; frameMs: number }
    const live = connection.state === "connected"
    const label = live ? `${connection.topics.length} topics` : connection.state === "lost" ? "no gateway" : connection.state
    return (
        <Bar
            className="app-topbar"
            title={inDesktopShell() ? undefined : "Controller"}
            icon={inDesktopShell() ? undefined : "robot"}
            left={
                <>
                    <ConnectionStatus state={connection.state} label={label} detail={connection.droppedPerSecond > 0 ? `${connection.droppedPerSecond} drop/s` : undefined} title={connection.error ?? ""} />
                    <Badge title="frames per second · gateway → screen latency (p50)" className="dr-mono">
                        {stats.fps} fps{stats.latencyP50 !== null ? ` · ${Math.round(stats.latencyP50)} ms` : ""}
                    </Badge>
                    {fallback.active && (
                        <Button size="sm" variant="warn" title={`splat frames took ${fallback.frameMs.toFixed(0)} ms (over 16 ms): drawing cubes instead. Click to try splats again.`} onClick={() => splatFallback.set({ active: false, frameMs: 0 })}>
                            splats → cubes ({fallback.frameMs.toFixed(0)} ms)
                        </Button>
                    )}
                </>
            }
            right={
                <>
                    <Tabs
                        variant="pill"
                        size="sm"
                        label="Panels"
                        value={tab}
                        onChange={(next: Tab) => onTab(next)}
                        items={TABS.map((item) => ({ ...item, badge: item.value === "tf" && tfIssues.length ? tfIssues.length : undefined }))}
                    />
                    <IconButton
                        icon="fullscreen"
                        label="Fullscreen"
                        onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})}
                    />
                </>
            }
        />
    )
}
