// The 3D view's side panels, outside the scene: the layer list (every drawable topic, a switch each, live info or
// the problem, the layer's own settings), the TF tree (fixed frame, issues, an indented frame list whose hover picks a
// frame out in the view) and the one-line TF footnote over the view. They share state with the scene through a
// LayerManager and a TfTree passed to both.
//
//     const layers = useLayerManager()                  // watches the source's topics
//     const tf = useMemo(() => new TfTree(), [])
//     h(Scene3D, { tf }, h(TfFeed), h(TopicLayers, { manager: layers }), h(FrameHighlight, { frame: hovered }))
//     h(LayersPanel, { manager: layers })
//     h(TfPanel, { tf, fixedFrame, onFixedFrame, issues, onHover: setHovered })
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { cx } from "../cx.ts"
import { useDataSource } from "../data.ts"
import { useStore } from "./store.ts"
import { LayerManager } from "./layers/manager.ts"
import { Badge, Field, Select, Toggle } from "../components/controls.tsx"
import { Icon } from "../components/icon.tsx"
import { Alert, EmptyState } from "../components/feedback.tsx"
import type { LayerEntry } from "./layers/manager.ts"
import type { LayerCommonSettings } from "./layers/registry.ts"
import type { Store } from "./store.ts"
import type { TfSnapshot, TfTree } from "./tf.ts"
import type { TfIssue } from "./tf_check.ts"

export interface UseLayerManagerOptions {
    persist?: ConstructorParameters<typeof LayerManager>[0]["persist"]
    storagePrefix?: string
    filter?: string
    intervalMs?: number
}

/** A LayerManager for the data source in effect, watching its topics while mounted. */
export function useLayerManager({
    persist,
    storagePrefix,
    filter,
    intervalMs,
}: UseLayerManagerOptions = {}): LayerManager {
    const source = useDataSource()
    const manager = useMemo(() => new LayerManager({ source, persist, storagePrefix }), [source, storagePrefix])
    useEffect(() => manager.watch({ filter, intervalMs }), [manager, filter, intervalMs])
    return manager
}

/** Every layer's "Draw on top" (LayerCommonSettings.onTop): applied in place, the layer keeps running. */
function OnTopSetting({ settings }: { settings: Store<LayerCommonSettings> }) {
    const { onTop } = useStore(settings)
    return (
        <div className="dr-layer-settings-grid">
            <Field label="Draw on top" hint="over the clouds; off: what's in front hides it">
                <Toggle value={!!onTop} onChange={(on) => settings.update({ onTop: on })} />
            </Field>
        </div>
    )
}

function LayerRow({ manager, entry }: { manager: LayerManager; entry: LayerEntry }) {
    const [open, setOpen] = useState(false)
    const Settings = entry.type.Settings
    const status = entry.status
    return (
        <div
            className={cx(
                "dr-layer-row",
                entry.enabled && "dr-layer-row--on",
                status.problem && "dr-layer-row--problem",
            )}
            data-key={entry.topic.key}
        >
            <div className="dr-layer-line">
                <Toggle
                    value={entry.enabled}
                    size="sm"
                    aria-label={`Show ${entry.topic.name}`}
                    onChange={(enabled) => manager.setEnabled(entry.topic.key, enabled)}
                />
                <button
                    type="button"
                    className="dr-layer-name"
                    onClick={() => setOpen(!open)}
                    title={entry.topic.key}
                    aria-expanded={open}
                >
                    <span className="dr-layer-topic">{entry.topic.name}</span>
                    <span className="dr-layer-type">{entry.topic.type.split(".")[1]}</span>
                    <span className={cx("dr-layer-chevron", open && "dr-layer-chevron--open")}>
                        <Icon name="chevron-right" size={14} />
                    </span>
                </button>
            </div>
            {entry.enabled && (status.problem || status.info)
                ? (
                    <div className={cx("dr-layer-status", status.problem && "dr-layer-status--problem")}>
                        {status.problem ?? status.info}
                    </div>
                )
                : null}
            {open
                ? (
                    <div className="dr-layer-settings">
                        <OnTopSetting settings={entry.settings} />
                        {Settings ? <Settings settings={entry.settings} topic={entry.topic} /> : null}
                    </div>
                )
                : null}
        </div>
    )
}

/**
 * Every drawable topic, grouped by layer type: a switch (on = subscribed), live info or the problem, and the layer's
 * settings behind a disclosure; then the topics nothing draws.
 */
export function LayersPanel({ manager, emptyText, className }: LayersPanelProps) {
    const { list } = useStore(manager.entries)
    const { list: topics } = useStore(manager.topics)
    const groups = new Map<string, LayerEntry[]>()
    for (const entry of list) {
        groups.set(entry.type.label, [...(groups.get(entry.type.label) ?? []), entry])
    }
    const drawn = new Set(list.map((entry) => entry.topic.key))
    const other = topics.filter((topic) => !drawn.has(topic.key))
    return (
        <div className={cx("dr-layers", className)}>
            {!list.length
                ? (
                    <EmptyState
                        icon="layers"
                        title="Waiting for topics…"
                        message={emptyText ?? "Start a blueprint (or a replay) and they appear here."}
                    />
                )
                : null}
            {[...groups].map(([label, entries]) => (
                <section key={label} className="dr-layer-group">
                    <h3 className="dr-layer-group-title">{label}</h3>
                    {entries.map((entry) => <LayerRow key={entry.topic.key} manager={manager} entry={entry} />)}
                </section>
            ))}
            {other.length
                ? (
                    <details className="dr-layer-group dr-layer-other">
                        <summary>{`${other.length} other topics (not drawn)`}</summary>
                        {other.map((topic) => (
                            <div key={topic.key} className="dr-layer-other-topic">
                                <span>{topic.name}</span>
                                <span className="dr-layer-type">{topic.type}</span>
                            </div>
                        ))}
                    </details>
                )
                : null}
        </div>
    )
}

export interface LayersPanelProps {
    manager: LayerManager
    emptyText?: string
    className?: string
}

function TreeRows({
    snapshot,
    frame,
    depth,
    seen,
    hovered,
    flagged,
    onHover,
    rows,
}: {
    snapshot: TfSnapshot
    frame: string
    depth: number
    seen: Set<string>
    hovered: string | null
    flagged: Set<string>
    onHover?: (frame: string | null) => void
    rows: ReactNode[]
}) {
    if (seen.has(frame) || depth > 64) {
        return
    }
    seen.add(frame)
    const edge = snapshot.edges.find((other) => other.child === frame)
    const stale = snapshot.problems.stale.includes(frame)
    rows.push(
        <div
            key={frame}
            className={cx(
                "dr-tf-frame",
                stale && "dr-tf-frame--stale",
                flagged.has(frame) && "dr-tf-frame--flagged",
                hovered === frame && "dr-tf-frame--highlighted",
            )}
            style={{ paddingLeft: depth * 14 + 4 }}
            data-frame={frame}
            title={onHover ? "Hover to find it in the 3D view" : undefined}
            onPointerEnter={() => onHover?.(frame)}
            onPointerLeave={() => onHover?.(null)}
        >
            <span>{frame}</span>
            {edge
                ? <span className="dr-tf-age">{edge.isStatic ? "static" : `${Math.round(edge.ageMs)} ms`}</span>
                : null}
        </div>,
    )
    const children = snapshot.edges
        .filter((other) => other.parent === frame)
        .map((other) => other.child)
        .sort()
    for (const child of children) {
        TreeRows({ snapshot, frame: child, depth: depth + 1, seen, hovered, flagged, onHover, rows })
    }
}

export interface TfPanelProps {
    tf: TfTree
    fixedFrame?: string
    activeFixedFrame?: string
    onFixedFrame?: (frame: string) => void
    issues?: TfIssue[]
    robotFrame?: string
    robotFound?: boolean
    hovered?: string | null
    hoveredPlaced?: boolean
    onHover?: (frame: string | null) => void
    className?: string
}

/**
 * The TF tree as an indented list (age per edge, stale and flagged frames marked), what's wrong with it, and which
 * frame the view is fixed to (`fixedFrame` = the choice, "" = auto; `activeFixedFrame` = the one in use).
 */
export function TfPanel({
    tf,
    fixedFrame = "",
    activeFixedFrame,
    onFixedFrame,
    issues = [],
    robotFrame,
    robotFound,
    hovered = null,
    hoveredPlaced = true,
    onHover,
    className,
}: TfPanelProps) {
    const [snapshot, setSnapshot] = useState(() => tf.snapshot())
    useEffect(() => {
        const timer = setInterval(() => setSnapshot(tf.snapshot()), 1000)
        return () => clearInterval(timer)
    }, [tf])
    // the highlight goes with the panel
    useEffect(() => () => onHover?.(null), [])
    const flagged = new Set(issues.flatMap((issue) => issue.frames))
    const tree = useRef<HTMLDivElement>(null)
    const scrolled = useRef(false)
    useEffect(() => {
        const first = tree.current?.querySelector(".dr-tf-frame--flagged")
        if (first && !scrolled.current) {
            scrolled.current = true
            first.scrollIntoView({ block: "nearest" })
        }
    })
    const active = activeFixedFrame ?? (fixedFrame || tf.defaultFixedFrame())
    const rows: ReactNode[] = []
    for (const root of snapshot.problems.roots) {
        TreeRows({ snapshot, frame: root, depth: 0, seen: new Set(), hovered, flagged, onHover, rows })
    }
    return (
        <div className={cx("dr-tf-panel", className)}>
            {onFixedFrame
                ? (
                    <Field label="Fixed frame" hint="everything is drawn relative to this frame">
                        <Select
                            value={fixedFrame}
                            options={[["", `auto (${active})`], ...snapshot.frames.map((frame) => [frame, frame])]}
                            onChange={onFixedFrame}
                        />
                    </Field>
                )
                : null}
            {robotFrame
                ? (
                    <p className="dr-hint">
                        {`Robot frame: ${robotFrame} `}
                        <Badge tone={robotFound ? "ok" : "warn"}>{robotFound ? "in TF" : "not in TF yet"}</Badge>
                    </p>
                )
                : null}
            {issues.map((issue) => (
                <Alert
                    key={issue.kind + issue.summary}
                    tone="warn"
                    title={issue.summary}
                    data-frames={issue.frames.join(",")}
                >
                    {issue.detail}
                </Alert>
            ))}
            {!snapshot.frames.length ? <EmptyState icon="info" title="no tf yet" /> : null}
            <div className="dr-tf-tree" ref={tree} onPointerLeave={() => onHover?.(null)}>
                {rows}
            </div>
            {hovered && !hoveredPlaced
                ? <p className="dr-hint">{`${hovered} isn't connected to ${active}: it can't be shown in the view`}</p>
                : null}
        </div>
    )
}

export interface TfFootnoteProps {
    issues: TfIssue[]
    onOpen?: () => void
    className?: string
}

/**
 * A quiet one-line note over the view's corner when the TF tree is broken; nothing when it's fine. `onOpen`: e.g.
 * open the TF panel, where the frames involved are marked.
 */
export function TfFootnote({ issues, onOpen, className }: TfFootnoteProps) {
    if (!issues?.length) {
        return null
    }
    const more = issues.length > 1 ? ` · +${issues.length - 1} more` : ""
    return (
        <button
            type="button"
            className={cx("dr-tf-footnote", className)}
            data-testid="tf-footnote"
            title={issues.map((issue) => `${issue.summary}: ${issue.detail}`).join("\n")}
            onClick={onOpen}
        >
            <Icon name="warn" size={13} />
            <span>{`TF: ${issues[0].summary}${more}`}</span>
        </button>
    )
}
