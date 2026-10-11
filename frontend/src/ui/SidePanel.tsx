// The panel the top bar's tabs open. Where it goes depends on the layout (logic/layout.ts): beside the view on the left
// (Classic), a drawer sliding over from the right (Cockpit, Tiles), a column the layout makes room for (Split), or a
// bottom sheet on a phone.
import type { CSSProperties } from "react"
import { IconButton, Panel } from "dimos-react"
import { LayersPanel, TfPanel } from "dimos-react/three"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"
import type { Rect } from "../logic/layout.ts"
import { SettingsPanel } from "./SettingsPanel.tsx"
import { useTfIssues } from "./sceneState.tsx"

export type Tab = "layers" | "tf" | "settings"
export type SidePlacement = "side" | "drawer" | "column" | "sheet"

const TITLES: Record<Tab, string> = { layers: "Layers", tf: "Transforms", settings: "Settings" }

export function SidePanel({ app, tab, onClose, placement, rect }: { app: ControllerApp; tab: Tab; onClose: () => void; placement: SidePlacement; rect?: Rect | null }) {
    const style: CSSProperties = placement === "column" && rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : {}
    return (
        <Panel
            glass
            className={`side-panel side-${placement}`}
            style={style}
            data-tab={tab}
            title={TITLES[tab]}
            bodyClassName="side-body"
            actions={<IconButton icon="close" label="Close" onClick={onClose} />}
        >
            {tab === "layers" && <LayersPanel manager={app.layers} emptyText="Waiting for topics… start a blueprint (or a replay) and they appear here." />}
            {tab === "tf" && <TransformsTab app={app} />}
            {tab === "settings" && <SettingsPanel app={app} />}
        </Panel>
    )
}

function TransformsTab({ app }: { app: ControllerApp }) {
    const view = useStore(app.settings)
    const highlight = useStore(app.highlight)
    const issues = useTfIssues(app)
    useStore(app.sceneReady)
    const frameInfo = app.scene ? { fixedFrame: app.fixedFrame, robotFound: !!app.tf.lookup(app.profile.baseFrame, app.fixedFrame) } : { fixedFrame: app.fixedFrame, robotFound: false }
    return (
        <TfPanel
            tf={app.tf}
            fixedFrame={view.fixedFrame}
            activeFixedFrame={frameInfo.fixedFrame}
            onFixedFrame={(fixedFrame: string) => app.settings.update({ fixedFrame })}
            issues={issues}
            robotFrame={app.profile.baseFrame}
            robotFound={frameInfo.robotFound}
            hovered={highlight.frame}
            hoveredPlaced={highlight.placed}
            onHover={(frame: string | null) => app.highlight.update({ frame })}
        />
    )
}
