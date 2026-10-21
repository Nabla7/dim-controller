// <BlueprintGraph>: a dimos blueprint's module graph (the gateway's GET blueprints/{name} modules: each module and the
// topics it writes and reads), drawn by GraphView in the theme's tokens, with zoom/layout controls and a fullscreen toggle.
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import { cx } from "../cx.ts"
import { Button } from "../components/controls.tsx"
import { formatRate, messageTypeColor } from "../components/topics.tsx"
import { useTheme } from "../theme/provider.tsx"
import { GraphControls } from "./graph_controls.tsx"
import { GraphView, type GraphViewHandle } from "./graph_view.tsx"
import type { LayoutId } from "./layout.ts"
import { textWidth } from "./paths.ts"

/** A module's stream, as the gateway describes it. */
export interface BlueprintStream {
    name: string
    type: string
    /** "in", "out" (anything else reads and writes) */
    direction: string
    /** the name it's wired under in the blueprint (a remapped stream) */
    wire?: string | null
    /** the topic it's pinned to */
    topic?: string | null
}

/** A module of a blueprint, as GET blueprints/{name} lists it (other fields are ignored). */
export interface BlueprintModule {
    name: string
    /** the dotted class path */
    class: string
    streams: BlueprintStream[]
}

/** A topic heard on the bus that no module of the blueprint wires. */
export interface ExtraTopic {
    topic: string
    type: string
}

/** What's lit: a module, or a topic. */
export type BlueprintSpot = { module: string } | { topic: string } | null

/** The topic a stream lands on: its pinned topic, else its wired name, else its own name (no leading slash). */
export const topicOf = (stream: BlueprintStream): string =>
    (stream.topic ?? stream.wire ?? stream.name).replace(/^\/+/, "")

/** A module's class name (the last part of its dotted path), or its name. */
export const moduleClassName = (module: BlueprintModule): string => module.class.split(".").pop() || module.name

const MODULE_H = 46
const MODULE_BAR = 4
const MODULE_PAD_X = 16
const TAG_GAP = 10
const CHEV_W = 22
const TOPIC_H = 30
const PAD_X = 9
const PORT = 7
const RATE_RESERVE = "999.9 Hz"

export interface BlueprintModuleNode {
    id: string
    kind: "module"
    name: string
    label: string
    tagW: number
    w: number
    h: number
}

export interface BlueprintTopicNode {
    id: string
    kind: "topic"
    topic: string
    type: string
    /** heard on the bus, not wired by the blueprint */
    extra: boolean
    /** only written, or only read, here */
    loose: boolean
    w: number
    h: number
}

export type BlueprintNode = BlueprintModuleNode | BlueprintTopicNode
export interface BlueprintEdge {
    from: string
    to: string
    topic: string
}

/** Text width in px for a CSS font; a rough per-character width where there's no canvas (tests, server rendering). */
export type MeasureText = (text: string, font: string) => number

function fontOf(token: string, fallback: string): string {
    if (typeof document === "undefined") {
        return fallback
    }
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback
}

const measureText: MeasureText = (text, font) => {
    try {
        return textWidth(text, font)
    } catch {
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12)
        return text.length * px * 0.6
    }
}

/** Modules become module nodes, each topic a topic node; an edge runs module → topic it writes, topic → module reading it. */
export function buildBlueprintGraph(
    modules: BlueprintModule[],
    extras: ExtraTopic[] = [],
    measure: MeasureText = measureText,
): { nodes: BlueprintNode[]; edges: BlueprintEdge[] } {
    const sans = fontOf("--sans", "sans-serif")
    const mono = fontOf("--mono", "monospace")
    const nodes: BlueprintNode[] = []
    const edges: BlueprintEdge[] = []
    const topics = new Map<string, { type: string; extra: boolean }>()
    const tagW = Math.ceil(measure("MOD", `600 9.5px ${sans}`) * 1.25)
    for (const module of modules) {
        const label = moduleClassName(module)
        const labelW = Math.ceil(measure(label, `600 15px ${sans}`))
        nodes.push({
            id: `m:${module.name}`,
            kind: "module",
            name: module.name,
            label,
            tagW,
            w: MODULE_BAR + MODULE_PAD_X + tagW + TAG_GAP + labelW + CHEV_W,
            h: MODULE_H,
        })
        for (const stream of module.streams) {
            const topic = topicOf(stream)
            if (!topics.has(topic)) {
                topics.set(topic, { type: stream.type, extra: false })
            }
            if (stream.direction !== "in") {
                edges.push({ from: `m:${module.name}`, to: `t:${topic}`, topic })
            }
            if (stream.direction !== "out") {
                edges.push({ from: `t:${topic}`, to: `m:${module.name}`, topic })
            }
        }
    }
    for (const extra of extras) {
        if (!topics.has(extra.topic)) {
            topics.set(extra.topic, { type: extra.type, extra: true })
        }
    }
    const written = new Set(edges.filter((edge) => edge.from.startsWith("m:")).map((edge) => edge.topic))
    const read = new Set(edges.filter((edge) => edge.to.startsWith("m:")).map((edge) => edge.topic))
    for (const [topic, { type, extra }] of topics) {
        const width = Math.max(measure(topic, `500 12px ${mono}`), measure(RATE_RESERVE, `10px ${mono}`))
        nodes.push({
            id: `t:${topic}`,
            kind: "topic",
            topic,
            type,
            extra,
            loose: !(written.has(topic) && read.has(topic)),
            w: Math.ceil(width) + PAD_X * 2,
            h: TOPIC_H,
        })
    }
    return { nodes, edges }
}

/** Two fingers over `element` zoom only the graph, never the page (even with Android's "force enable zoom"). */
export function useNoPagePinch(element: HTMLElement | null): void {
    useEffect(() => {
        if (!element) {
            return
        }
        const onTouchMove = (event: TouchEvent) => {
            if (event.touches.length > 1) {
                event.preventDefault()
            }
        }
        // iOS Safari's own pinch
        const onGesture = (event: Event) => event.preventDefault()
        element.addEventListener("touchmove", onTouchMove, { passive: false })
        element.addEventListener("gesturestart", onGesture)
        element.addEventListener("gesturechange", onGesture)
        return () => {
            element.removeEventListener("touchmove", onTouchMove)
            element.removeEventListener("gesturestart", onGesture)
            element.removeEventListener("gesturechange", onGesture)
        }
    }, [element])
}

/** "native": the Fullscreen API has the element; "overlay": it fills the window (no Fullscreen API, or it refused). */
export type FullscreenMode = "native" | "overlay" | null

/**
 * Fullscreen for an element: the Fullscreen API where there is one, else (or when it refuses, e.g. in an iframe
 * without allow="fullscreen") a full-window overlay the caller styles. Esc leaves either.
 */
export function useFullscreen(element: HTMLElement | null): {
    mode: FullscreenMode
    enter: () => void
    exit: () => void
    toggle: () => void
} {
    const [mode, setMode] = useState<FullscreenMode>(null)
    useEffect(() => {
        if (typeof document === "undefined") {
            return
        }
        const onChange = () => {
            setMode((was) =>
                document.fullscreenElement && document.fullscreenElement === element
                    ? "native"
                    : was === "native"
                    ? null
                    : was
            )
        }
        document.addEventListener("fullscreenchange", onChange)
        return () => document.removeEventListener("fullscreenchange", onChange)
    }, [element])
    // Esc leaves the overlay, and the native mode too where the browser doesn't (a frame, a headless page)
    useEffect(() => {
        if (!mode) {
            return
        }
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.stopPropagation()
                if (document.fullscreenElement) {
                    document.exitFullscreen().catch(() => {})
                }
                setMode(null)
            }
        }
        window.addEventListener("keydown", onKey, true)
        return () => window.removeEventListener("keydown", onKey, true)
    }, [mode])
    const enter = useCallback(() => {
        if (!element) {
            return
        }
        if (document.fullscreenEnabled && element.requestFullscreen) {
            element.requestFullscreen().then(
                () => setMode("native"),
                () => setMode("overlay"),
            )
        } else {
            setMode("overlay")
        }
    }, [element])
    const exit = useCallback(() => {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {})
        }
        setMode(null)
    }, [])
    const toggle = useCallback(() => (mode ? exit() : enter()), [mode, enter, exit])
    return { mode, enter, exit, toggle }
}

export interface BlueprintGraphProps {
    modules: BlueprintModule[]
    /** topics heard on the bus that the blueprint doesn't wire, drawn dashed */
    extras?: ExtraTopic[]
    /** the layout (uncontrolled: starts at "hierarchy" and the controls change it) */
    layout?: LayoutId
    onLayoutChange?: (layout: LayoutId) => void
    /** what's lit (uncontrolled: whatever's hovered) */
    spot?: BlueprintSpot
    /** Hz per topic while the blueprint runs: live topics show their rate and their edges flow */
    rates?: Map<string, number> | null
    onModule?: (name: string) => void
    onTopic?: (topic: string | null) => void
    onHover?: (spot: BlueprintSpot) => void
    /** the smallest zoom a fit may pick, per layout (GraphView's; `{}` always fits the whole graph, for a small box) */
    fitMinScale?: Partial<Record<LayoutId, number>>
    /** the zoom buttons and layout picker (default on) */
    controls?: boolean
    /** the fullscreen toggle, top right (default on) */
    fullscreen?: boolean
    /** shown when there are no modules */
    empty?: ReactNode
    className?: string
    style?: CSSProperties
    "aria-label"?: string
    /** laid over the graph (a heading, a legend) */
    children?: ReactNode
}

/**
 * A blueprint's module graph: modules (a bar, "MOD" and the class name) and the topics between them (tinted by message
 * type), pannable and zoomable (drag, wheel, pinch; two fingers never zoom the page), with a fullscreen button. A ref
 * gives GraphView's zoom, fit and reveal (a module's id is `m:<name>`, a topic's `t:<topic>`).
 */
export const BlueprintGraph = forwardRef<GraphViewHandle, BlueprintGraphProps>(function BlueprintGraph(props, ref) {
    const {
        modules,
        extras = [],
        rates = null,
        onModule,
        onTopic,
        onHover,
        controls = true,
        fullscreen = true,
        empty = "No modules to draw.",
    } = props
    const [ownLayout, setOwnLayout] = useState<LayoutId>("hierarchy")
    const layout = props.layout ?? ownLayout
    const setLayout = (next: LayoutId) => {
        setOwnLayout(next)
        props.onLayoutChange?.(next)
    }
    const [hovered, setHovered] = useState<BlueprintSpot>(null)
    const spot = props.spot !== undefined ? props.spot : hovered
    const ownRef = useRef<GraphViewHandle>(null)
    const setRefs = useCallback(
        (handle: GraphViewHandle | null) => {
            ownRef.current = handle
            if (typeof ref === "function") {
                ref(handle)
            } else if (ref) {
                ref.current = handle
            }
        },
        [ref],
    )
    const [box, setBox] = useState<HTMLDivElement | null>(null)
    useNoPagePinch(box)
    const { mode, toggle } = useFullscreen(box)
    // the graph refits to its new size
    useEffect(() => {
        const timer = setTimeout(() => ownRef.current?.fit(), 60)
        return () => clearTimeout(timer)
    }, [mode])

    // sizes follow the skin's fonts; keyed on content, not identity: new arrays would re-bind GraphView's pointer
    // handlers, which drops a pinch mid-gesture
    const { skin } = useTheme()
    const shape = JSON.stringify([modules.map((m) => [m.name, m.class, m.streams]), extras])
    const { nodes, edges } = useMemo(() => buildBlueprintGraph(modules, extras), [shape, skin])
    const types = useMemo(
        () => new Map(nodes.flatMap((node) => (node.kind === "topic" ? [[node.topic, node.type] as const] : []))),
        [nodes],
    )
    const focus = spot && "module" in spot ? `m:${spot.module}` : spot ? `t:${spot.topic}` : null
    const hz = (topic: string) => rates?.get(topic) ?? 0
    return (
        <div
            ref={setBox}
            className={cx(
                "dr-bpgraph",
                mode === "overlay" && "dr-bpgraph--overlay",
                mode && "dr-bpgraph--fullscreen",
                props.className,
            )}
            style={props.style}
            data-fullscreen={mode ?? undefined}
        >
            {nodes.length === 0
                ? <div className="dr-bpgraph__empty">{empty}</div>
                : (
                    <GraphView<BlueprintNode, BlueprintEdge>
                        ref={setRefs}
                        className={cx("dr-bpgraph__view", rates && "dr-bpgraph__view--running")}
                        aria-label={props["aria-label"] ?? "Module graph"}
                        nodes={nodes}
                        edges={edges}
                        layout={layout}
                        focus={focus}
                        port={PORT}
                        fitMinScale={props.fitMinScale}
                        focusable={(node) => node.kind === "module"}
                        nodeClassName={(node) =>
                            cx(
                                node.kind,
                                node.kind === "topic" && node.extra && "extra",
                                node.kind === "topic" && node.loose && "loose",
                                node.kind === "topic" && hz(node.topic) > 0 && "live",
                            )}
                        nodeTitle={(node) =>
                            node.kind === "module" ? node.name : `/${node.topic}\n${node.type}` +
                                (node.extra ? "\n(not wired in this blueprint)" : "") +
                                (node.loose ? "\n(only written or only read here)" : "")}
                        edgeClassName={(edge) => (hz(edge.topic) > 0 ? "flow" : undefined)}
                        nodeStyle={(node) =>
                            node.kind === "topic"
                                ? ({ "--dr-bpgraph-type": messageTypeColor(node.type) } as CSSProperties)
                                : undefined}
                        edgeStyle={(edge) =>
                            ({ "--dr-graph-edge": messageTypeColor(types.get(edge.topic)) }) as CSSProperties}
                        onNodeClick={(node) => (node.kind === "module" ? onModule?.(node.name) : onTopic?.(node.topic))}
                        onBackgroundClick={() => onTopic?.(null)}
                        onHover={(node) => {
                            const next: BlueprintSpot = node
                                ? node.kind === "module" ? { module: node.name } : { topic: node.topic }
                                : null
                            setHovered(next)
                            onHover?.(next)
                        }}
                        renderNode={(node) => (
                            <>
                                <rect className="box" width={node.w} height={node.h} />
                                {node.kind === "module"
                                    ? (
                                        <>
                                            <rect className="bar" width={MODULE_BAR} height={node.h} />
                                            <text x={MODULE_BAR + MODULE_PAD_X} y={node.h / 2} className="tag">
                                                MOD
                                            </text>
                                            <text
                                                x={MODULE_BAR + MODULE_PAD_X + node.tagW + TAG_GAP}
                                                y={node.h / 2}
                                                className="name"
                                            >
                                                {node.label}
                                            </text>
                                            <text x={node.w - CHEV_W / 2 - 2} y={node.h / 2} className="more">
                                                ›
                                            </text>
                                        </>
                                    )
                                    : (
                                        <>
                                            <text x={PAD_X} y={hz(node.topic) ? 11 : node.h / 2} className="name">
                                                {node.topic}
                                            </text>
                                            <text x={PAD_X} y={22} className="rate">
                                                {hz(node.topic) ? formatRate(hz(node.topic)) : ""}
                                            </text>
                                        </>
                                    )}
                                {[0, node.w].map((x) => (
                                    <rect
                                        key={x}
                                        className="port"
                                        x={x - PORT / 2}
                                        y={node.h / 2 - PORT / 2}
                                        width={PORT}
                                        height={PORT}
                                    />
                                ))}
                            </>
                        )}
                    >
                        {props.children}
                        {controls && <GraphControls graph={ownRef} layout={layout} onLayoutChange={setLayout} />}
                    </GraphView>
                )}
            {fullscreen && (
                <Button
                    size="sm"
                    className="dr-bpgraph__fullscreen"
                    icon={mode ? "fullscreen-exit" : "fullscreen"}
                    title={mode ? "Exit fullscreen (Esc)" : "Show the graph fullscreen"}
                    pressed={!!mode}
                    onClick={toggle}
                >
                    {mode ? "Exit fullscreen" : "Fullscreen"}
                </Button>
            )}
        </div>
    )
})
