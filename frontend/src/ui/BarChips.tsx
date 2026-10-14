// The one bar's status chips (ui/barStatus.ts says when and what): the link's live throughput and latency (coloured
// when it's a problem), TF and render warnings (each opens what fixes it), and the gamepad's state. A phone shows the
// same chips over the top of the main view.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { splatFallback } from "../core/render/rendering.ts"
import { gamepadChip, linkChip } from "./barStatus.ts"
import { Icon } from "./icons.tsx"
import { gamepadStatus } from "./useGamepad.ts"
import type { WorkspaceApi } from "./Workspace.tsx"

export function BarChips({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    const connection = useStore(app.connection.status)
    const { issues: tfIssues } = useStore(app.tfIssues)
    const fallback = useStore(splatFallback)
    const pad = gamepadChip(useStore(gamepadStatus))
    const link = linkChip(connection, app.connection.latencyMs())
    return (
        <>
            <button type="button" className={`bar-chip tone-${link.tone} bar-button`} title={`${link.detail} (open Status)`} data-testid="bar-link" onClick={() => api.act("status", "show")}>
                <span className="bar-dot" />
                <span className="bar-value">{link.text}</span>
            </button>
            {tfIssues.length > 0 && (
                <button type="button" className="bar-chip tone-warn bar-button" title={`TF: ${tfIssues[0].summary} (open the TF panel)`} data-testid="bar-tf" onClick={() => api.act("tf", "show")}>
                    <Icon name="warn" size={13} />
                    <span className="bar-value">TF {tfIssues.length}</span>
                </button>
            )}
            {fallback.active && !api.mobile && (
                <button type="button" className="bar-chip tone-warn bar-button" title={`splat frames took ${fallback.frameMs.toFixed(0)} ms (over 16 ms): drawing cubes instead. Click to try splats again.`} onClick={() => splatFallback.set({ active: false, frameMs: 0 })}>
                    <span className="bar-value">splats → cubes</span>
                </button>
            )}
            {pad && (
                <span className={`bar-chip tone-${pad.tone} bar-gamepad`} title={`Gamepad · ${pad.detail}`} data-testid="bar-gamepad">
                    <Icon name="gamepad" size={14} />
                    <span className="bar-value">{pad.text}</span>
                </span>
            )}
        </>
    )
}
