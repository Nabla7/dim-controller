// Crippled, not crashed: a view that can't run (no WebGL, or it threw while rendering) says so in place, and the rest of
// the page keeps working.
import { Component, type ReactNode } from "react"
import { Icon } from "./icons.tsx"

/** A short notice centered over the view that can't run. */
export function Unavailable({ what, reason }: { what: string; reason: string }) {
    return (
        <div className="dim-panel view-unavailable" role="status">
            <Icon name="warn" size={15} />
            <span>{what} unavailable: {reason}</span>
        </div>
    )
}

/** Catches a render-time throw in one view so it can't take the whole page down with it. */
export class ContainCrash extends Component<{ what: string; children: ReactNode }, { error: string | null }> {
    state = { error: null as string | null }

    static getDerivedStateFromError(error: unknown) {
        return { error: error instanceof Error ? error.message : String(error) }
    }

    componentDidCatch(error: unknown) {
        console.error(`${this.props.what} crashed`, error)
    }

    render() {
        return this.state.error ? <Unavailable what={this.props.what} reason={this.state.error} /> : this.props.children
    }
}
