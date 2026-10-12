// The 3D view's own camera button, over its corner: follow (track the followed TF frame, base_link by default; a pan
// stops it, this resumes it). It moves this page's camera directly; the agent's POST api/camera does the same in every
// open page. (Top-down is the map panel's job; the palette and the agent still have it.)
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Icon } from "./icons.tsx"

export function ViewControls({ app }: { app: ViewerApp }) {
    const view = useStore(app.settings)
    const { paused } = useStore(app.viewer.followPaused)
    const { followFound } = useStore(app.frameInfo)
    const following = view.follow && !paused
    const frame = app.followFrame
    const title = following
        ? `Following ${frame}${followFound ? "" : " (waiting for it in TF)"}: orbit and zoom keep following, a pan looks around. Click to reframe it`
        : `Follow ${frame} again`
    return (
        <div className="view-controls panel-chrome" data-testid="view-controls">
            <button type="button" className="dim-btn icon view-control view-follow" aria-pressed={following} title={title} aria-label={following ? "Following" : "Follow"} onClick={() => app.recenter()}>
                <Icon name="target" size={17} />
            </button>
        </div>
    )
}
