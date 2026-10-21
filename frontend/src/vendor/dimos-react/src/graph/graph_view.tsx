// <GraphView>: lays out a directed graph of boxes and draws it as SVG you can pan (drag, one finger, sideways scroll),
// zoom (wheel, pinch) and click. You draw each node's contents; it draws the edges, with an arrow head.
import {
    forwardRef,
    useCallback,
    useEffect,
    useId,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react"
import type { CSSProperties, ForwardedRef, ReactNode, Ref } from "react"
import { cx } from "../cx.ts"
import { type Box, layout, type LayoutId, type Link, type Placement } from "./layout.ts"
import { flowPath, type Placed, straightPath } from "./paths.ts"

export interface GraphViewHandle {
    zoom(factor: number, cx?: number, cy?: number): void
    /** Fit the whole graph in view (and follow resizes again until the user moves it). */
    fit(): void
    /** Scroll a node into view, animated, if it isn't already. */
    reveal(id: string): void
}

export interface GraphViewProps<N extends Box, E extends Link> {
    nodes: N[]
    edges: E[]
    layout?: LayoutId
    /** A node's contents, drawn in its own coordinates: (0, 0) is its top left. */
    renderNode: (node: N & Placed) => ReactNode
    nodeClassName?: (node: N) => string | undefined
    nodeTitle?: (node: N) => string | undefined
    nodeStyle?: (node: N) => CSSProperties | undefined
    /** Nodes that take keyboard focus (Enter clicks them). */
    focusable?: (node: N) => boolean
    edgeClassName?: (edge: E, index: number) => string | undefined
    edgeStyle?: (edge: E, index: number) => CSSProperties | undefined
    onNodeClick?: (node: N) => void
    onBackgroundClick?: () => void
    onHover?: (node: N | null) => void
    /** Called after every layout, e.g. to check for overlaps. */
    onLayout?: (placement: Placement) => void
    /** Room edges leave at a node's sides (e.g. for port markers you draw). */
    port?: number
    /** Space kept around the graph when fitting. */
    fitPadding?: { x: number; top: number; bottom: number }
    /** The smallest zoom a fit may pick, per layout (a wide hierarchy scrolls rather than shrinking to nothing). */
    fitMinScale?: Partial<Record<LayoutId, number>>
    /** The background grid's cell at zoom 1 (the container's background is scaled and moved with the view). */
    gridSize?: number
    /** A node to light up with its neighbours and the edges between them (class "lit"); the rest dim. */
    focus?: string | null
    className?: string
    style?: CSSProperties
    "aria-label"?: string
    children?: ReactNode
}

interface View {
    x: number
    y: number
    k: number
}

const clampScale = (k: number) => Math.max(0.1, Math.min(4, k))

function GraphViewInner<N extends Box, E extends Link>(
    props: GraphViewProps<N, E>,
    ref: ForwardedRef<GraphViewHandle>,
): ReactNode {
    const {
        nodes,
        edges,
        layout: layoutId = "hierarchy",
        renderNode,
        nodeClassName,
        nodeTitle,
        nodeStyle,
        focusable,
        edgeClassName,
        edgeStyle,
        onNodeClick,
        onBackgroundClick,
        onHover,
        onLayout,
        port = 0,
        fitPadding = { x: 24, top: 52, bottom: 60 },
        fitMinScale = { hierarchy: 0.8 },
        gridSize = 22,
        focus = null,
    } = props
    const pane = useRef<HTMLDivElement>(null)
    const svg = useRef<SVGSVGElement>(null)
    const moved = useRef(false)
    const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
    const viewRef = useRef(view)
    viewRef.current = view
    const arrow = `graph-arrow-${useId().replace(/:/g, "")}`
    const shape = nodes.map((node) => `${node.id}\u0000${node.w}\u0000${node.h}`).join("\u0001") +
        "\u0002" +
        edges.map((edge) => `${edge.from}\u0000${edge.to}`).join("\u0001")
    // the layout depends only on the graph's shape, not on new arrays of the same nodes
    const placement = useMemo(() => layout(layoutId, nodes, edges), [shape, layoutId])
    const placed = useMemo(
        () => nodes.map((node) => ({ ...node, ...placement.positions.get(node.id)! })),
        [nodes, placement],
    )
    const byId = useMemo(() => new Map(placed.map((node) => [node.id, node])), [placed])

    const fit = useCallback(() => {
        const box = pane.current?.getBoundingClientRect()
        if (!box || !placed.length || box.width < 10 || box.height < 10) {
            return
        }
        const left = Math.min(...placed.map((n) => n.x - n.w / 2))
        const right = Math.max(...placed.map((n) => n.x + n.w / 2))
        const top = Math.min(...placed.map((n) => n.y - n.h / 2))
        const bottom = Math.max(...placed.map((n) => n.y + n.h / 2))
        const pad = fitPadding
        const fitHeight = Math.min(1.4, (box.height - pad.top - pad.bottom) / (bottom - top || 1))
        let k = Math.min(fitHeight, (box.width - pad.x * 2) / (right - left || 1))
        const least = fitMinScale[layoutId]
        if (least !== undefined) {
            k = Math.max(k, Math.min(fitHeight, least))
        }
        const spare = box.width - pad.x * 2 - (right - left) * k
        moved.current = false
        setView({
            k,
            x: pad.x + Math.max(spare, 0) / 2 - left * k,
            y: pad.top + (box.height - pad.top - pad.bottom - (bottom - top) * k) / 2 - top * k,
        })
    }, [placed, layoutId])

    const zoom = useCallback((factor: number, cx?: number, cy?: number) => {
        const box = pane.current!.getBoundingClientRect()
        const at = viewRef.current
        const x = cx ?? box.width / 2
        const y = cy ?? box.height / 2
        const k = clampScale(at.k * factor)
        moved.current = true
        setView({ k, x: x - ((x - at.x) * k) / at.k, y: y - ((y - at.y) * k) / at.k })
    }, [])

    const reveal = useCallback(
        (id: string) => {
            const node = byId.get(id)
            const box = pane.current?.getBoundingClientRect()
            if (!node || !box || box.width < 10) {
                return
            }
            const from = viewRef.current
            const { k } = from
            const margin = { x: 40, top: 60, bottom: 70 }
            const left = from.x + (node.x - node.w / 2) * k
            const right = from.x + (node.x + node.w / 2) * k
            const top = from.y + (node.y - node.h / 2) * k
            const bottom = from.y + (node.y + node.h / 2) * k
            if (
                left >= margin.x &&
                right <= box.width - margin.x &&
                top >= margin.top &&
                bottom <= box.height - margin.bottom
            ) {
                return
            }
            const to = { x: box.width / 2 - node.x * k, y: (box.height + margin.top - margin.bottom) / 2 - node.y * k }
            const start = performance.now()
            const step = (now: number) => {
                const t = Math.min((now - start) / 260, 1)
                const ease = 1 - (1 - t) ** 3
                setView({ k, x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease })
                if (t < 1) {
                    requestAnimationFrame(step)
                }
            }
            moved.current = true
            requestAnimationFrame(step)
        },
        [byId],
    )

    useImperativeHandle(ref, () => ({ zoom, fit, reveal }), [zoom, fit, reveal])

    useLayoutEffect(() => {
        onLayout?.(placement)
        fit()
    }, [placement])

    useEffect(() => {
        const observer = new ResizeObserver(() => !moved.current && fit())
        observer.observe(pane.current!)
        return () => observer.disconnect()
    }, [fit])

    const handlers = useRef({ onNodeClick, onBackgroundClick, onHover })
    handlers.current = { onNodeClick, onBackgroundClick, onHover }
    const nodeAt = useCallback(
        (target: EventTarget | null): N | null => {
            const element = (target as Element | null)?.closest?.("[data-graph-node]")
            const id = element?.getAttribute("data-graph-node")
            return id ? (nodes.find((node) => node.id === id) ?? null) : null
        },
        [nodes],
    )

    useEffect(() => {
        const element = svg.current!
        const onWheel = (event: WheelEvent) => {
            event.preventDefault()
            const sideways = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX
            if (Math.abs(sideways) > Math.abs(event.shiftKey ? 0 : event.deltaY)) {
                moved.current = true
                setView((at) => ({ ...at, x: at.x - sideways }))
                return
            }
            const box = pane.current!.getBoundingClientRect()
            zoom(Math.exp(-event.deltaY * 0.0016), event.clientX - box.left, event.clientY - box.top)
        }
        // one finger (or a mouse) pans, two pinch-zoom; the svg's touch-action: none keeps the browser's zoom off it
        const touches = new Map<number, { x: number; y: number }>()
        let drag: { x: number; y: number; at: View; far: boolean } | null = null
        let pinch: { gap: number; x: number; y: number; at: View } | null = null
        const twoFingers = () => {
            const [a, b] = [...touches.values()]
            const box = pane.current!.getBoundingClientRect()
            return {
                gap: Math.hypot(a.x - b.x, a.y - b.y),
                x: (a.x + b.x) / 2 - box.left,
                y: (a.y + b.y) / 2 - box.top,
            }
        }
        const onDown = (event: PointerEvent) => {
            touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
            if (touches.size === 2) {
                pinch = { ...twoFingers(), at: viewRef.current }
                drag = null
            } else if (touches.size === 1) {
                drag = { x: event.clientX, y: event.clientY, at: viewRef.current, far: false }
            }
        }
        const onMove = (event: PointerEvent) => {
            if (touches.has(event.pointerId)) {
                touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
            }
            if (pinch && touches.size === 2) {
                const now = twoFingers()
                const { at } = pinch
                const k = clampScale((at.k * now.gap) / pinch.gap)
                moved.current = true
                setView({ k, x: now.x - ((pinch.x - at.x) * k) / at.k, y: now.y - ((pinch.y - at.y) * k) / at.k })
                return
            }
            if (!drag) {
                return
            }
            const dx = event.clientX - drag.x
            const dy = event.clientY - drag.y
            if (!drag.far && Math.hypot(dx, dy) < 4) {
                return
            }
            drag.far = true
            element.classList.add("panning")
            moved.current = true
            setView({ ...drag.at, x: drag.at.x + dx, y: drag.at.y + dy })
        }
        const onCancel = (event: PointerEvent) => {
            touches.delete(event.pointerId)
            pinch = null
            drag = null
            element.classList.remove("panning")
        }
        const onUp = (event: PointerEvent) => {
            touches.delete(event.pointerId)
            if (pinch) {
                pinch = touches.size ? pinch : null
                return
            }
            const was = drag
            drag = null
            element.classList.remove("panning")
            if (was && !was.far) {
                const node = nodeAt(event.target)
                if (node) {
                    handlers.current.onNodeClick?.(node)
                } else if ((event.target as Element | null)?.closest?.("svg") === element) {
                    handlers.current.onBackgroundClick?.()
                }
            }
        }
        element.addEventListener("wheel", onWheel, { passive: false })
        element.addEventListener("pointerdown", onDown)
        addEventListener("pointermove", onMove)
        addEventListener("pointercancel", onCancel)
        addEventListener("pointerup", onUp)
        return () => {
            element.removeEventListener("wheel", onWheel)
            element.removeEventListener("pointerdown", onDown)
            removeEventListener("pointermove", onMove)
            removeEventListener("pointercancel", onCancel)
            removeEventListener("pointerup", onUp)
        }
    }, [zoom, nodeAt])

    const lit = useMemo(() => {
        const ids = new Set(focus && byId.has(focus) ? [focus] : [])
        for (const edge of ids.size ? edges : []) {
            if (edge.from === focus || edge.to === focus) {
                ids.add(edge.from === focus ? edge.to : edge.from)
            }
        }
        return ids
    }, [edges, focus, byId])

    const layered = layoutId === "hierarchy" || layoutId === "vertical"
    const drawing = useMemo(
        () => (
            <>
                <g className="edges">
                    {edges.map((edge, index) => {
                        const from = byId.get(edge.from)
                        const to = byId.get(edge.to)
                        if (!from || !to) {
                            return null
                        }
                        const d = layered
                            ? flowPath(from, to, placement.routes.get(index) ?? [], !!placement.vertical, port)
                            : straightPath(from, to)
                        return (
                            <path
                                key={index}
                                className={cx(
                                    "edge",
                                    focus && (edge.from === focus || edge.to === focus) && "lit",
                                    edgeClassName?.(edge, index),
                                )}
                                style={edgeStyle?.(edge, index)}
                                d={d}
                                markerEnd={`url(#${arrow})`}
                            />
                        )
                    })}
                </g>
                <g className="nodes">
                    {placed.map((node) => {
                        const title = nodeTitle?.(node)
                        return (
                            <g
                                key={node.id}
                                className={cx("node", lit.has(node.id) && "lit", nodeClassName?.(node))}
                                style={nodeStyle?.(node)}
                                transform={`translate(${node.x - node.w / 2} ${node.y - node.h / 2})`}
                                tabIndex={focusable?.(node) ? 0 : -1}
                                data-graph-node={node.id}
                            >
                                {title && <title>{title}</title>}
                                {renderNode(node)}
                            </g>
                        )
                    })}
                </g>
            </>
        ),
        [
            placed,
            edges,
            byId,
            placement,
            layered,
            port,
            arrow,
            renderNode,
            nodeClassName,
            nodeTitle,
            nodeStyle,
            focusable,
            edgeClassName,
            edgeStyle,
            focus,
            lit,
        ],
    )
    const grid = gridSize * view.k
    return (
        <div
            ref={pane}
            className={cx("dr-graph", lit.size > 0 && "dr-graph--focus", props.className)}
            style={{
                ...props.style,
                backgroundSize: `${grid}px ${grid}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
            }}
        >
            <svg
                ref={svg}
                className="graph"
                role="img"
                aria-label={props["aria-label"] ?? "Graph"}
                style={{ touchAction: "none" }}
                onPointerOver={(event) => handlers.current.onHover?.(nodeAt(event.target))}
                onPointerLeave={() => handlers.current.onHover?.(null)}
                onKeyDown={(event) => {
                    const node = nodeAt(event.target)
                    if (event.key === "Enter" && node && focusable?.(node)) {
                        handlers.current.onNodeClick?.(node)
                    }
                }}
            >
                <defs>
                    <marker
                        id={arrow}
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="7"
                        markerHeight="7"
                        orient="auto-start-reverse"
                    >
                        <path d="M0 1 L10 5 L0 9 z" fill="context-stroke" />
                    </marker>
                </defs>
                <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>{drawing}</g>
            </svg>
            {props.children}
        </div>
    )
}

/**
 * A pannable, zoomable view of a laid-out graph on a dotted grid; a ref gives zoom, fit and reveal. Edges and nodes
 * take the classes "edge" / "node" (plus yours); `focus` lights a node's neighbourhood.
 */
export const GraphView = forwardRef(GraphViewInner) as <N extends Box, E extends Link>(
    props: GraphViewProps<N, E> & { ref?: Ref<GraphViewHandle> },
) => ReactNode
