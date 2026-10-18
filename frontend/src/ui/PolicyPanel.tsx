import { Button } from "dimos-react"
import type { ViewerApp } from "../core/app.ts"
import { actionAllowed, PHASE_LABELS, type PolicyAction } from "../core/policyControl.ts"
import { useStore } from "../core/store.ts"

export function PolicyPanel({ app }: { app: ViewerApp }) {
    const state = useStore(app.policy.state)
    const status = state.status
    const controller = status?.controller
    const phase = !status && !state.error ? "Connecting…" : state.stale ? "State unavailable" : status ? PHASE_LABELS[status.phase] : "Unavailable"
    const act = (action: PolicyAction) => () => void app.policy.act(action)
    const ms = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(0)} ms`
    return (
        <div className="policy-panel" data-testid="policy-panel">
            <div className="policy-identity"><strong>{controller?.name ?? "Motion controller"}</strong><span>{controller?.robot ?? "Connecting to robot"}</span></div>
            <div className={`policy-phase ${status?.fault || state.stale ? "tone-bad" : status?.phase === "balancing" ? "tone-ok" : "tone-warn"}`} role="status" data-testid="policy-phase">{phase}</div>
            <p className="hint">{status?.phase === "pose-hold" ? "Motors hold the measured pose. Balancing is inactive." : status?.phase === "activating" ? "Moving to the prepared pose before balancing." : status?.phase === "balancing" ? "Live policy control. Driving changes walking velocity." : status?.phase === "fault" ? "Damping is latched. Restart the robot stack to recover." : status?.phase === "dry-run" ? "Inference runs while the prepared pose is held." : "Control state comes from the robot."}</p>
            {controller?.model && <div className="policy-detail">Model <span>{controller.model}</span></div>}
            <div className="policy-detail">Last command source <span>{status?.command_source ?? "unknown"}</span></div>
            <div className="policy-detail">Motor feedback <span>{ms(status?.feedback_age_ms)}</span></div>
            <div className="policy-actions">
                <Button data-testid="policy-activate" disabled={!actionAllowed(state, "activate")} onClick={act("activate")}>Activate policy</Button>
                <Button data-testid="policy-deactivate" disabled={!actionAllowed(state, "deactivate")} title="Stop balancing and return to measured-pose hold; motors remain enabled" onClick={act("deactivate")}>Deactivate</Button>
                <Button data-testid="policy-stop-motion" disabled={!actionAllowed(state, "stop-motion")} title="Cancel navigation and zero walking velocity; keep balancing" onClick={act("stop-motion")}>Stop walking</Button>
            </div>
            <div className="policy-damping">
                <Button className="policy-damping-button" data-testid="policy-damping" disabled={!actionAllowed(state, "damping-stop")} onClick={act("damping-stop")}>Damping stop</Button>
                <span className="hint">Stops balancing and latches damping. Recovery requires a stack restart.</span>
            </div>
            {state.pending && <p className="hint" role="status">Waiting for robot acknowledgement…</p>}
            {(state.error || status?.fault || status?.reason) && <p className="problem" role="alert">{state.error || status?.fault || status?.reason}</p>}
        </div>
    )
}
