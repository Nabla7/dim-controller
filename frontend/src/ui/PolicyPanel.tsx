import { Button } from "dimos-react"
import type { ViewerApp } from "../core/app.ts"
import { actionAllowed, driveBlock } from "../core/policyControl.ts"
import { useStore } from "../core/store.ts"
import { Icon } from "./icons.tsx"

export function PolicyPanel({ app }: { app: ViewerApp }) {
    const state = useStore(app.policy.state)
    const status = state.status
    return <div className="sonic-controls" data-testid="sonic-controls">
        <strong>{state.stale ? "State unavailable" : status?.fault_reason ? "Damping stop latched" : status?.control_state ?? "Waiting"}</strong>
        {status && <span>{status.fault_reason ? "Damping" : status.dry_run ? "Dry run / pose held" : "Live"} · {status.reference_source}</span>}
        <div className="sonic-actions">
            <Button disabled={!actionAllowed(state, "activate")} onClick={() => app.policy.act("activate")} title="Ramp from the measured pose into live balancing"><Icon name="play" />Activate</Button>
            <Button disabled={!actionAllowed(state, "stop-motion")} onClick={() => app.policy.act("stop-motion")} title="Cancel navigation and operator motion; keep balancing"><Icon name="stop" />Stop motion</Button>
            <Button disabled={!actionAllowed(state, "deactivate")} onClick={() => {
                if (confirm("Stop balancing and hold the measured pose? The G1 must be supported.")) void app.policy.act("deactivate")
            }} title="Stops balancing; support the robot first"><Icon name="pause" />Deactivate</Button>
            <Button className="sonic-damping" disabled={!actionAllowed(state, "damping-stop")} onClick={() => app.policy.act("damping-stop")} title="Latched software damping; not a power disconnect"><Icon name="stop" />Damping stop</Button>
        </div>
        {state.pending && <span role="status">{state.pending} pending</span>}
        {driveBlock(state) && <span className="hint">{driveBlock(state)}</span>}
        {state.error && <span className="problem" role="alert">{state.error}</span>}
    </div>
}
