import type { ViewerApp } from "../core/app.ts"
import type { OperatorView } from "../core/manipulation.ts"
import { useStore } from "../core/store.ts"
import { Panel } from "./Panel.tsx"

export const operatorViewId = (view: OperatorView) => `operator:${view.module}`

/** The selected blueprint owns these views and their controls. Opening one starts no robot. */
export function OperatorViews({ app }: { app: ViewerApp }) {
    const { binding, views } = useStore(app.manipulation.state)
    if (!binding) return null
    return <>{views.map((view) => {
        const xrUrl = new URL(view.path, `${view.scheme}://${location.hostname}:${view.port}`)
        const route = [binding.run_id, binding.session, view.module].map(encodeURIComponent).join("/")
        const url = new URL(`./api/operator-view/${route}/${view.path.replace(/^\//, "")}`, location.href)
        url.searchParams.set("desktop", "1")
        return <Panel key={`${binding.session}:${view.module}`} id={operatorViewId(view)} title={view.title} icon="arm"
            tools={<a href={xrUrl.href} target="_blank" rel="noreferrer">Open spatial / XR view</a>}>
            <iframe title={view.title} src={url.href} allow="xr-spatial-tracking; fullscreen" allowFullScreen
                style={{ width: "100%", height: "100%", border: 0 }} />
        </Panel>
    })}</>
}
