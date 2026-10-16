// The Network modal (the link chip opens it), a small dashboard: headline tiles (throughput, latency, the link, the
// lease), the last few minutes of throughput stacked by stream and the control link's latency, then the Bandwidth
// Consumers: every stream the page pulls, with a switch to pause it (force-unsubscribe), a bar by how much it uses, its
// bandwidth priority (− / +) and a gear for the rest (quality ↔ Hz, delivery, max Hz / bitrate): this viewer's overrides
// (core/bandwidth.ts), applied under every subscription by core/transport.ts.
// History is kept from page load (core/netHistory.ts, sampled by core/transport.ts), so opening it shows the recent past.
// Every region has a fixed size and hovering only moves an overlay, so nothing reflows under the pointer.
import type { ViewerApp } from "../core/app.ts"
import { type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react"
import { assignSlots, averageOf, breakdown, CONTROL, HEARTBEAT, type NetSample, nearestIndex, netSummary, niceCeil, OTHER, RESENT, RTP_HEADERS, stackOf, type StreamShare, streamTable } from "../core/netHistory.ts"
import { useStore } from "../core/store.ts"
import { type Consumer, parseKey } from "../core/transport.ts"
import { bandwidthOverrides, DEFAULT_PRIORITY, DEFAULT_TRADEOFF, heatOf, priorityLabel, setOverride, stepPriority, type StreamOverride } from "../core/bandwidth.ts"
import { Button, NumberInput, Segmented, Slider, Toggle } from "dimos-react"
import { Icon } from "./icons.tsx"

/** colour slots (styles.css --net-1..7); a stream past them is drawn with "other" */
const SLOT_COUNT = 7
const RATE_H = 150
const LATENCY_H = 150
/** the y-axis labels' gutter and the x-axis labels' strip, px */
const GUTTER_LEFT = 30
const GUTTER_BOTTOM = 16
/** the table: each stream averaged over the last TABLE_AVERAGE_SAMPLES (1 s each), redrawn every TABLE_REFRESH_MS; ordered by
 * the last ORDER_SAMPLES' average (a stream stays listed while it's had any traffic in them), with hysteresis (stableOrder) */
const TABLE_AVERAGE_SAMPLES = 10
const TABLE_REFRESH_MS = 5000
const ORDER_SAMPLES = 60
/** streams listed in the hover readout (always this many lines) */
const READOUT_STREAMS = 4

const mbps = (bytesPerSec: number) => (bytesPerSec * 8) / 1e6
const mbpsNumber = (bytesPerSec: number | null) => bytesPerSec === null ? "—" : mbps(bytesPerSec).toFixed(mbps(bytesPerSec) < 10 ? 2 : 1)
const msNumber = (ms: number | null) => ms === null ? "—" : String(Math.round(ms))
const PART_NAMES: Record<string, string> = {
    [OTHER]: "protocol overhead",
    [CONTROL]: "gateway control",
    [HEARTBEAT]: "heartbeat",
    [RTP_HEADERS]: "video RTP headers",
    [RESENT]: "video resent (NACK)",
}
// a named part, a dimos topic by its name, another key (Desktop's events) by its last two parts
const streamName = (key: string) => PART_NAMES[key] ?? parseKey(key)?.name ?? `…/${key.split("/").slice(-2).join("/")}`
const colorOf = (slot: number | undefined) => slot === undefined ? "var(--net-other)" : `var(--net-${slot + 1})`
const spanText = (ms: number) => ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
const LINK_TEXT: Record<string, { text: string; tone: string }> = {
    connected: { text: "Connected", tone: "ok" },
    degraded: { text: "Degraded", tone: "warn" },
    connecting: { text: "Connecting", tone: "warn" },
    lost: { text: "Lost", tone: "bad" },
}
const LEASE_TEXT: Record<string, { text: string; tone: string; detail: string }> = {
    held: { text: "Held", tone: "ok", detail: "this page has the streams" },
    taking: { text: "Taking", tone: "warn", detail: "asking the gateway" },
    takenOver: { text: "Taken over", tone: "bad", detail: "a newer viewer has it" },
    off: { text: "Off", tone: "idle", detail: "not connected" },
    unsupported: { text: "n/a", tone: "idle", detail: "gateway has no leases" },
}

/** The plot's pixel width, measured (the SVG is drawn at its real size, so nothing is stretched). */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
    const ref = useRef<HTMLDivElement>(null)
    const [width, setWidth] = useState(0)
    useLayoutEffect(() => {
        const element = ref.current
        if (!element) {
            return
        }
        setWidth(Math.floor(element.clientWidth))
        const observer = new ResizeObserver(() => setWidth(Math.floor(element.clientWidth)))
        observer.observe(element)
        return () => observer.disconnect()
    }, [])
    return [ref, width]
}

interface Hover {
    index: number
    /** the chart under the pointer: it shows the readout */
    chart: "rate" | "latency"
    /** a touch keeps the readout after the finger lifts */
    touch: boolean
}

interface PlotProps {
    title: string
    unit: string
    height: number
    top: number
    samples: NetSample[]
    end: number
    span: number
    hover: Hover | null
    chart: Hover["chart"]
    onHover: (hover: Hover | null) => void
    readout: ReactNode
    draw: (x: (at: number) => number, y: (value: number) => number) => ReactNode
}

/** One chart: a fixed-height frame, the SVG drawn at the frame's measured size, y gridlines at 0 / ½ / top, x labels, a crosshair and a readout overlay. */
function Plot({ title, unit, height, top, samples, end, span, hover, chart, onHover, readout, draw }: PlotProps) {
    const [frame, width] = useWidth()
    const plotW = Math.max(0, width - GUTTER_LEFT - 4)
    const plotH = height - GUTTER_BOTTOM - 6
    const x = (at: number) => GUTTER_LEFT + plotW - ((end - at) / span) * plotW
    const y = (value: number) => 6 + plotH - (value / top) * plotH
    const pick = (event: ReactPointerEvent<SVGSVGElement>) => {
        const box = event.currentTarget.getBoundingClientRect()
        const at = end - (1 - (event.clientX - box.left - GUTTER_LEFT) / plotW) * span
        const index = nearestIndex(samples, at)
        if (index >= 0) {
            onHover({ index, chart, touch: event.pointerType !== "mouse" })
        }
    }
    const hovered = hover && samples[hover.index]
    const cursorX = hovered ? x(hovered.at) : 0
    const tickLabel = (value: number) => (top < 1 ? value.toFixed(value === 0 ? 0 : 2) : String(Number(value.toPrecision(3))))
    return (
        <figure className="net-chart">
            <figcaption>{title} <span className="dim">{unit}</span></figcaption>
            <div className="net-plot" ref={frame} style={{ height }}>
                {width > 0 && (
                    <svg
                        width={width}
                        height={height}
                        viewBox={`0 0 ${width} ${height}`}
                        onPointerDown={pick}
                        onPointerMove={(event) => (event.pointerType === "mouse" || event.buttons) && pick(event)}
                        onPointerLeave={(event) => event.pointerType === "mouse" && onHover(null)}
                        role="img"
                        aria-label={`${title} over the last ${spanText(span)}`}
                    >
                        {[0, top / 2, top].map((value) => (
                            <g key={value} className="net-grid">
                                <line x1={GUTTER_LEFT} x2={GUTTER_LEFT + plotW} y1={Math.round(y(value)) + 0.5} y2={Math.round(y(value)) + 0.5} />
                                <text x={GUTTER_LEFT - 5} y={y(value)} dy="0.32em" textAnchor="end">{tickLabel(value)}</text>
                            </g>
                        ))}
                        {draw(x, y)}
                        <g className="net-grid">
                            <text x={GUTTER_LEFT} y={height - 3}>−{spanText(span)}</text>
                            <text x={GUTTER_LEFT + plotW / 2} y={height - 3} textAnchor="middle">−{spanText(span / 2)}</text>
                            <text x={GUTTER_LEFT + plotW} y={height - 3} textAnchor="end">now</text>
                        </g>
                        {hovered && <line className="net-cursor" x1={Math.round(cursorX) + 0.5} x2={Math.round(cursorX) + 0.5} y1={6} y2={6 + plotH} />}
                    </svg>
                )}
                {hovered && hover.chart === chart && (
                    <div className={`net-readout ${cursorX > width / 2 ? "left" : "right"}`} style={cursorX > width / 2 ? { right: width - cursorX + 8 } : { left: cursorX + 8 }}>
                        {readout}
                        {hover.touch && <button type="button" className="net-readout-close" aria-label="Hide the readout" onClick={() => onHover(null)}>×</button>}
                    </div>
                )}
            </div>
        </figure>
    )
}

function Tile({ label, value, unit, tone, detail }: { label: string; value: string; unit?: string; tone?: string; detail: ReactNode }) {
    return (
        <div className="net-tile">
            <div className="net-tile-label">{label}</div>
            <div className="net-tile-value">{tone && <span className={`net-dot tone-${tone}`} />}{value}{unit && <span className="net-tile-unit"> {unit}</span>}</div>
            <div className="net-tile-detail">{detail}</div>
        </div>
    )
}

/** a consumption heat (0..1) as a colour: calm to hot */
const heatColor = (heat: number) => `color-mix(in oklab, var(--net-heat-hot) ${Math.round(heat * 100)}%, var(--net-heat-cool))`

/** what a stream runs with: the app's options, this viewer's override on top */
function effectiveOf(consumer: Consumer | undefined, override: StreamOverride | undefined) {
    const base = consumer?.base ?? {}
    const video = !!consumer?.video
    return {
        video,
        priority: override?.bandwidthPriority ?? base.bandwidthPriority ?? DEFAULT_PRIORITY,
        // the gateway reserves a reliable stream at its measured rate and never shrinks it, so its priority does nothing
        reliable: !video && (override?.delivery ?? base.delivery) === "reliable",
    }
}

function PriorityStepper({ streamKey, priority, overridden, disabled }: { streamKey: string; priority: number; overridden: boolean; disabled: boolean }) {
    const name = streamName(streamKey)
    return (
        <span className={`net-priority ${overridden ? "set" : ""}`} title={disabled ? "reliable: the gateway never shrinks it, so priority doesn't apply" : `bandwidth priority ${priorityLabel(priority)} (when the link is short, a stream's cut is split by demand ÷ priority; "last" gives up first)`}>
            <button type="button" className="net-step" aria-label={`Lower ${name}'s priority`} disabled={disabled || priority <= 0} onClick={() => setOverride(streamKey, { bandwidthPriority: stepPriority(priority, -1) })}>−</button>
            <span className="net-priority-value" data-testid="net-priority">{disabled ? "—" : priorityLabel(priority)}</span>
            <button type="button" className="net-step" aria-label={`Raise ${name}'s priority`} disabled={disabled || priority >= 8} onClick={() => setOverride(streamKey, { bandwidthPriority: stepPriority(priority, 1) })}>+</button>
        </span>
    )
}

/** One stream's advanced options, over the table (it doesn't move anything): what it runs with, the app's value shown as the default. */
function StreamSettings({ streamKey, consumer, override, onClose }: { streamKey: string; consumer: Consumer | undefined; override: StreamOverride | undefined; onClose: () => void }) {
    const base = consumer?.base ?? {}
    const { video, priority, reliable } = effectiveOf(consumer, override)
    const tradeoff = override?.qualityToHzTradeoff ?? base.qualityToHzTradeoff ?? DEFAULT_TRADEOFF
    const [draft, setDraft] = useState(tradeoff)
    useEffect(() => setDraft(tradeoff), [tradeoff])
    const delivery = video ? "latest" : override?.delivery ?? base.delivery ?? "reliable"
    const appText = (value: string) => <span className="net-app-default">app: {value}</span>
    return (
        <div className="net-settings" role="dialog" aria-label={`${streamName(streamKey)} bandwidth settings`} data-testid="net-settings">
            <div className="net-settings-head">
                <span className="net-settings-title" title={streamKey}>{streamName(streamKey)}</span>
                <button type="button" className="net-icon-button" aria-label="Close settings" onClick={onClose}>×</button>
            </div>
            <div className="net-settings-body">
                <label className="net-field">
                    <span className="net-field-name">Priority {appText(priorityLabel(base.bandwidthPriority ?? DEFAULT_PRIORITY))}</span>
                    <PriorityStepper streamKey={streamKey} priority={priority} overridden={override?.bandwidthPriority !== undefined} disabled={reliable} />
                </label>
                <div className="net-field wide">
                    <span className="net-field-name">Quality ↔ frequency {appText(String(base.qualityToHzTradeoff ?? DEFAULT_TRADEOFF))}</span>
                    <Slider
                        value={draft}
                        min={0}
                        max={1}
                        step={0.05}
                        aria-label="Quality to frequency tradeoff"
                        format={(value) => value.toFixed(2)}
                        onChange={setDraft}
                        onCommit={(value) => setOverride(streamKey, { qualityToHzTradeoff: value })}
                    />
                    <span className="net-field-ends"><span>keep quality, drop Hz</span><span>keep Hz, drop quality</span></span>
                    {!video && !base.encoding && <span className="net-field-note">a raw stream can only drop Hz</span>}
                </div>
                <div className="net-field">
                    <span className="net-field-name">Delivery {appText(video ? "most recent" : base.delivery === "latest" ? "most recent" : "reliable")}</span>
                    <Segmented
                        size="sm"
                        label="Delivery"
                        items={[["latest", "Most recent"], ["reliable", "Reliable"]]}
                        value={delivery}
                        onChange={(value) => !video && setOverride(streamKey, { delivery: value as "latest" | "reliable" })}
                        aria-disabled={video}
                    />
                    <span className="net-field-note">{video ? "video is always the most recent frame" : delivery === "reliable" ? "every message, in order; never shrunk (priority doesn't apply)" : "newest only, never resent; may be thinned"}</span>
                </div>
                <label className="net-field">
                    <span className="net-field-name">Max rate {appText(base.maxHz === undefined ? "source rate" : `${base.maxHz} Hz`)}</span>
                    <NumberInput nullable size="sm" min={0.05} step={1} unit="Hz" placeholder={base.maxHz === undefined ? "source" : String(base.maxHz)} value={override?.maxHz ?? null} onChange={(value) => setOverride(streamKey, { maxHz: value ?? undefined })} aria-label="Max rate (Hz)" />
                </label>
                {video && (
                    <label className="net-field">
                        <span className="net-field-name">Max bitrate {appText(base.maxBitrate === undefined ? "gateway's" : `${base.maxBitrate / 1e6} Mbps`)}</span>
                        <NumberInput nullable size="sm" min={0.05} step={0.5} precision={2} unit="Mbps" placeholder={base.maxBitrate === undefined ? "auto" : String(base.maxBitrate / 1e6)} value={override?.maxBitrate === undefined ? null : override.maxBitrate / 1e6} onChange={(value) => setOverride(streamKey, { maxBitrate: value === null ? undefined : Math.round(value * 1e6) })} aria-label="Max bitrate (Mbps)" />
                    </label>
                )}
            </div>
            <div className="net-settings-foot">
                <Button size="sm" onClick={() => setOverride(streamKey, override?.paused ? { paused: true, bandwidthPriority: undefined, qualityToHzTradeoff: undefined, delivery: undefined, maxHz: undefined, maxBitrate: undefined } : null)}>Reset to defaults</Button>
                <Button size="sm" variant="primary" onClick={onClose}>Done</Button>
            </div>
        </div>
    )
}

/** The Bandwidth Consumers table: every stream (paused ones at 0), ordered without jumping; the page's own subscriptions have controls, the rest (overhead, heartbeat, control, other apps') are shown only. */
function ConsumersTable({ table, slots, consumers }: { table: StreamShare[]; slots: Map<string, number>; consumers: Record<string, Consumer> }) {
    const overrides = useStore(bandwidthOverrides)
    const [editing, setEditing] = useState<string | null>(null)
    const busiest = Math.max(0, ...table.map((row) => row.bytesPerSec))
    return (
        <section className="net-table">
            <h4>Bandwidth Consumers <span className="dim">· {TABLE_AVERAGE_SAMPLES} s average, every {TABLE_REFRESH_MS / 1000} s</span></h4>
            <div className="net-table-scroll">
                <table className="net-streams">
                    <thead><tr><th className="net-col-on" title="off: unsubscribed until switched back on">on</th><th>stream</th><th className="net-col-rate" title="bar: how much it uses, against the busiest">Mbps</th><th className="net-col-priority" title="bandwidth priority when the link is short">priority</th><th className="net-col-gear" /></tr></thead>
                    <tbody>
                        {table.map((row) => {
                            const consumer = consumers[row.key]
                            const override = overrides[row.key]
                            const controllable = !!consumer || !!override
                            const paused = !!override?.paused
                            const { video, priority, reliable } = effectiveOf(consumer, override)
                            const heat = paused ? 0 : heatOf(row.bytesPerSec, busiest)
                            const tags = [paused ? "paused" : "", video ? "video" : reliable ? "reliable" : "", override && Object.keys(override).some((name) => name !== "paused") ? "tuned" : ""].filter(Boolean)
                            return (
                                <tr key={row.key} title={row.key} className={paused ? "paused" : ""} data-key={row.key} data-testid="net-consumer">
                                    <td className="net-col-on">{controllable ? <Toggle value={!paused} onChange={(on) => setOverride(row.key, { paused: on ? undefined : true })} aria-label={`${paused ? "Resume" : "Pause"} ${streamName(row.key)}`} /> : <span className="dim" title="not a subscription: can't be paused">·</span>}</td>
                                    <td>
                                        <span className="net-swatch" style={{ background: colorOf(row.key === OTHER ? undefined : slots.get(row.key)) }} title="its colour in the chart" />
                                        <span className="net-stream-name">{streamName(row.key)}</span>
                                        <span className="net-stream-tags">{tags.join(" · ")}</span>
                                    </td>
                                    <td className="net-col-rate">
                                        <span className="net-heat" style={{ width: `${heat * 100}%`, background: heatColor(heat) }} />
                                        <span className="net-rate" title={paused ? "paused: not subscribed" : `${Math.round(row.share * 100)}% of the link`}>{paused ? "0.00" : mbps(row.bytesPerSec).toFixed(2)}</span>
                                    </td>
                                    <td className="net-col-priority">{controllable ? <PriorityStepper streamKey={row.key} priority={priority} overridden={override?.bandwidthPriority !== undefined} disabled={reliable} /> : <span className="dim">—</span>}</td>
                                    <td className="net-col-gear">{controllable && <button type="button" className={`net-icon-button ${tags.includes("tuned") ? "set" : ""}`} aria-label={`${streamName(row.key)} settings`} onClick={() => setEditing(row.key)}><Icon name="settings" size={15} /></button>}</td>
                                </tr>
                            )
                        })}
                        {!table.length && <tr className="net-empty"><td colSpan={5}>nothing received in the last minute</td></tr>}
                    </tbody>
                </table>
            </div>
            {editing && <StreamSettings streamKey={editing} consumer={consumers[editing]} override={overrides[editing]} onClose={() => setEditing(null)} />}
        </section>
    )
}

export function NetworkPanel({ app, onStatus }: { app: ViewerApp; onStatus: () => void }) {
    const history = app.connection.network
    const connection = useStore(app.connection.status)
    const lease = useStore(app.connection.lease.state)
    const [, redraw] = useState(0)
    const slots = useRef(new Map<string, number>()).current
    const [hover, setHover] = useState<Hover | null>(null)
    const consumers = useStore(app.connection.consumers)
    // the page's subscriptions and every paused stream are listed even without traffic
    const listed = () => [...new Set([...Object.keys(app.connection.consumers.get()), ...Object.entries(bandwidthOverrides.get()).filter(([, override]) => override.paused).map(([key]) => key)])]
    const [table, setTable] = useState(() => streamTable(history.samples.toArray(), [], TABLE_AVERAGE_SAMPLES, ORDER_SAMPLES, listed()))
    useEffect(() => {
        const charts = setInterval(() => redraw((n) => n + 1), 1000)
        const tableTimer = setInterval(() => setTable((previous) => streamTable(history.samples.toArray(), previous.map((row) => row.key), TABLE_AVERAGE_SAMPLES, ORDER_SAMPLES, listed())), TABLE_REFRESH_MS)
        return () => {
            clearInterval(charts)
            clearInterval(tableTimer)
        }
    }, [history])
    const samples = history.samples.toArray()
    for (const sample of samples) {
        assignSlots(slots, Object.keys(sample.streams).sort(), SLOT_COUNT)
    }
    const summary = netSummary(samples)
    const end = samples.at(-1)?.at ?? 0
    const span = Math.max(60_000, end - (samples[0]?.at ?? end))
    const stacks = samples.map((sample) => stackOf(sample, slots, SLOT_COUNT))
    const rateTop = niceCeil(Math.max(0, ...stacks.map((layers) => mbps(layers.reduce((sum, value) => sum + value, 0)))))
    const latencyTop = niceCeil(Math.max(0, ...samples.map((sample) => sample.latencyMs ?? 0)))
    const link = LINK_TEXT[connection.state] ?? LINK_TEXT.connecting
    const leaseShown = LEASE_TEXT[lease.status] ?? LEASE_TEXT.off
    // the readout: that second's total, latency and its largest streams, always READOUT_STREAMS lines so its size is fixed
    const hovered = hover && samples[hover.index]
    const readout = hovered && (() => {
        const rows = breakdown(hovered).slice(0, READOUT_STREAMS)
        return (
            <>
                <div className="net-readout-head">{Math.round((end - hovered.at) / 1000)} s ago</div>
                <div className="net-readout-row strong"><span>{mbpsNumber(hovered.bytesPerSec)} Mbps</span><span>{msNumber(hovered.latencyMs)} ms</span></div>
                {Array.from({ length: READOUT_STREAMS }, (_, index) => rows[index]).map((row, index) => (
                    <div className="net-readout-row" key={index}>
                        {row && <><span className="net-key" style={{ background: colorOf(row.key === OTHER ? undefined : slots.get(row.key)) }} /><span className="net-name">{streamName(row.key)}</span><span>{mbps(row.bytesPerSec).toFixed(2)}</span></>}
                    </div>
                ))}
            </>
        )
    })()
    return (
        <div className="net-panel" data-testid="network-panel">
            <div className="net-tiles">
                <Tile label="Throughput" value={mbpsNumber(summary.rateNow)} unit="Mbps" detail={<>1 min avg {mbpsNumber(summary.rateAverage)} · peak {mbpsNumber(summary.ratePeak)}</>} />
                <Tile label="Latency" value={msNumber(summary.latencyNow)} unit="ms" detail={<>p95 {msNumber(summary.latencyP95)} · max {msNumber(summary.latencyMax)}</>} />
                <Tile label="Link" value={link.text} tone={link.tone} detail={connection.droppedPerSecond ? `${connection.droppedPerSecond} dropped/s` : "no drops"} />
                <Tile label="Lease" value={leaseShown.text} tone={leaseShown.tone} detail={leaseShown.detail} />
            </div>
            <div className="net-charts">
                <Plot
                    title="Throughput by stream"
                    unit="Mbps"
                    height={RATE_H}
                    top={rateTop}
                    samples={samples}
                    end={end}
                    span={span}
                    hover={hover}
                    chart="rate"
                    onHover={setHover}
                    readout={readout}
                    draw={(x, y) => Array.from({ length: SLOT_COUNT + 1 }, (_, layer) => {
                        // stacked areas, bottom (slot 0) up; "other" on top
                        const below = stacks.map((layers) => layers.slice(0, layer).reduce((sum, value) => sum + value, 0))
                        const above = stacks.map((layers, index) => below[index] + layers[layer])
                        if (above.every((value, index) => value === below[index])) {
                            return null
                        }
                        const topEdge = samples.map((sample, index) => `${x(sample.at).toFixed(1)},${y(mbps(above[index])).toFixed(1)}`)
                        const bottomEdge = samples.map((sample, index) => `${x(sample.at).toFixed(1)},${y(mbps(below[index])).toFixed(1)}`).reverse()
                        return <polygon key={layer} className="net-band" points={[...topEdge, ...bottomEdge].join(" ")} fill={layer === SLOT_COUNT ? "var(--net-other)" : colorOf(layer)} />
                    })}
                />
                <Plot
                    title="Latency"
                    unit="ms, control round trip"
                    height={LATENCY_H}
                    top={latencyTop}
                    samples={samples}
                    end={end}
                    span={span}
                    hover={hover}
                    chart="latency"
                    onHover={setHover}
                    readout={readout}
                    draw={(x, y) => {
                        const points = samples.filter((sample) => sample.latencyMs !== null)
                        const last = points.at(-1)
                        return (
                            <>
                                <polyline className="net-latency" points={points.map((sample) => `${x(sample.at).toFixed(1)},${y(sample.latencyMs!).toFixed(1)}`).join(" ")} />
                                {last && <circle className="net-latency-end" cx={x(last.at)} cy={y(last.latencyMs!)} r={4} />}
                            </>
                        )
                    }}
                />
            </div>
            <ConsumersTable table={table} slots={slots} consumers={consumers} />
            <details className="net-about">
                <summary>About these numbers</summary>
                <p>
                    All counted by this browser (WebRTC stats), each second: throughput is the wire's bytes, a stream its data channel's
                    payload or its video track's. Protocol overhead is the wire beyond everything named (DTLS/SCTP framing, acks and
                    SCTP resends, which the browser doesn't count on their own). Latency is the heartbeat's round trip. A
                    stream switched off is unsubscribed until switched back on; priority (×N takes 1/N of the cut when the
                    link is short, "last" gives up first) and the gear's options are the gateway's, kept by this browser.{" "}
                    <button type="button" className="net-link" onClick={onStatus}>Open Status</button>
                </p>
            </details>
        </div>
    )
}
