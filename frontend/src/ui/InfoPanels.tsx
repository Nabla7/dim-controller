// The panels that are lists and forms: Status, Settings, Arms (while there are arms) and TF, each in the shared frame (ui/Panel.tsx), its
// body scrolling inside it.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Panel } from "./Panel.tsx"
import { StatusPanel } from "./StatusPanel.tsx"
import { SettingsPanel } from "./SettingsPanel.tsx"
import { TfPanel } from "./TfPanel.tsx"
import { ArmsPanel, armsPanelShown } from "./ArmsPanel.tsx"
import { ARMS_PANEL } from "./workspace.ts"
import { panelTitle } from "./commands.ts"
import { PolicyPanel } from "./PolicyPanel.tsx"

export function InfoPanels({ app }: { app: ViewerApp }) {
    const { issues } = useStore(app.tfIssues)
    const robot = useStore(app.robot)
    const runs = useStore(app.runs.state)
    const manipulation = useStore(app.manipulation.state)
    const policy = useStore(app.policy.state)
    return (
        <>
            {policy.required && <Panel id="policy" title="Robot control" icon="signal" bodyClassName="panel-body" testid="policy-panel-frame"><PolicyPanel app={app} /></Panel>}
            <Panel id="status" title={panelTitle("status")} icon="signal" bodyClassName="panel-body" testid="status-panel-frame">
                <StatusPanel app={app} />
            </Panel>
            <Panel id="settings" title={panelTitle("settings")} icon="settings" bodyClassName="panel-body" testid="settings-panel">
                <SettingsPanel app={app} />
            </Panel>
            {armsPanelShown(robot.type, runs, manipulation.available) && (
                <Panel id={ARMS_PANEL} title={panelTitle(ARMS_PANEL)} icon="arm" bodyClassName="panel-body" testid="arms-panel">
                    <ArmsPanel app={app} />
                </Panel>
            )}
            <Panel id="tf" title={panelTitle("tf")} icon="tree" info={issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : undefined} className={issues.length ? "has-issues" : ""} bodyClassName="panel-body">
                <TfPanel app={app} />
            </Panel>
        </>
    )
}
