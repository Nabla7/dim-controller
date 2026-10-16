// The arms panel: planning and moving the arms (ManipPanel), plus, for the Arm format, its jogging and gripper (ArmPanel).
// It exists only while there are arms to control: the Arm format, or a running ManipulationModule (an R1 Pro's arms).
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { plannerRunning, type RunState } from "../core/runs.ts"
import { Heading } from "dimos-react"
import { ArmPanel } from "./ArmPanel.tsx"
import { ManipPanel } from "./ManipPanel.tsx"

export function armsPanelShown(robotType: string, runs: RunState, manipulationAvailable: boolean | null | undefined): boolean {
    return robotType === "arm" || plannerRunning(runs) || manipulationAvailable === true
}

export function ArmsPanel({ app }: { app: ViewerApp }) {
    const robot = useStore(app.robot)
    if (robot.type !== "arm") {
        return <ManipPanel app={app} />
    }
    return (
        <>
            <section className="settings-section" data-section="manipulation">
                <Heading level={3}>Plan and move</Heading>
                <ManipPanel app={app} />
            </section>
            <section className="settings-section" data-section="arm">
                <Heading level={3}>Arm</Heading>
                <ArmPanel app={app} />
            </section>
        </>
    )
}
