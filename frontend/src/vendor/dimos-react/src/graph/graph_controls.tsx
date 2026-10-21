// <GraphControls>: a GraphView's zoom buttons (bottom left) and layout picker (bottom right), laid over it.
import type { RefObject } from "react"
import { Button, ButtonGroup } from "../components/controls.tsx"
import { Segmented } from "../components/nav.tsx"
import type { GraphViewHandle } from "./graph_view.tsx"
import { type LayoutId, LAYOUTS } from "./layout.ts"

export interface GraphControlsProps {
    /** the GraphView's ref */
    graph: RefObject<GraphViewHandle | null>
    layout: LayoutId
    onLayoutChange: (layout: LayoutId) => void
}

/** Zoom in / out / fit and the layout picker, as children of a GraphView. */
export function GraphControls({ graph, layout, onLayoutChange }: GraphControlsProps) {
    return (
        <>
            <ButtonGroup className="dr-graph__zoom">
                <Button size="sm" aria-label="Zoom in" onClick={() => graph.current?.zoom(1.25)}>
                    +
                </Button>
                <Button size="sm" aria-label="Zoom out" onClick={() => graph.current?.zoom(0.8)}>
                    −
                </Button>
                <Button size="sm" onClick={() => graph.current?.fit()}>
                    Fit
                </Button>
            </ButtonGroup>
            <Segmented
                className="dr-graph__layouts"
                size="sm"
                label="Layout"
                items={LAYOUTS.map(({ id, label }) => ({ value: id, label, props: { "data-layout": id } }))}
                value={layout}
                onChange={onLayoutChange}
            />
        </>
    )
}
