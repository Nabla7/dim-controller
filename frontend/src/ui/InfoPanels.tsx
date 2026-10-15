// The panels that are lists and forms: Status, Network, Settings, Layers and TF, each in the shared frame (ui/Panel.tsx), its
// body scrolling inside it.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Panel } from "./Panel.tsx"
import { StatusPanel } from "./StatusPanel.tsx"
import { NetworkPanel } from "./NetworkPanel.tsx"
import { useWorkspaceApi } from "./Workspace.tsx"
import { SettingsPanel } from "./SettingsPanel.tsx"
import { LayersPanel } from "./LayersPanel.tsx"
import { TfPanel } from "./TfPanel.tsx"
import { panelTitle } from "./commands.ts"

export function InfoPanels({ app }: { app: ViewerApp }) {
    const { issues } = useStore(app.tfIssues)
    const { list } = useStore(app.layers.entries)
    const on = list.filter((entry) => entry.enabled).length
    const api = useWorkspaceApi()
    return (
        <>
            <Panel id="status" title={panelTitle("status")} icon="signal" bodyClassName="panel-body" testid="status-panel-frame">
                <StatusPanel app={app} />
            </Panel>
            <Panel id="network" title={panelTitle("network")} icon="activity" bodyClassName="panel-body" testid="network-panel-frame">
                <NetworkPanel app={app} onStatus={() => api.act("status", "show")} />
            </Panel>
            <Panel id="settings" title={panelTitle("settings")} icon="settings" bodyClassName="panel-body" testid="settings-panel">
                <SettingsPanel app={app} />
            </Panel>
            <Panel id="layers" title={panelTitle("layers")} icon="layers" info={`${on}/${list.length} on`} bodyClassName="panel-body">
                <LayersPanel app={app} />
            </Panel>
            <Panel id="tf" title={panelTitle("tf")} icon="tree" info={issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : undefined} className={issues.length ? "has-issues" : ""} bodyClassName="panel-body">
                <TfPanel app={app} />
            </Panel>
        </>
    )
}
