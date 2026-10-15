// The Network panel (the link chip opens it): the last few minutes of throughput reaching this page, stacked by the
// stream that used it, and the control link's latency, then who's using the link now. History is kept from page load
// (core/netHistory.ts, sampled by core/transport.ts), so opening the panel shows the recent past.
import type { ViewerApp } from "../core/app.ts"
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react"
import { assignSlots, breakdown, CONTROL, HEARTBEAT, type NetSample, OTHER, RESENT, RTP_HEADERS } from "../core/netHistory.ts"
import { parseKey } from "../core/transport.ts"

/** colour slots (styles.css --net-1..7); a stream past them is drawn with "other" */
const SLOT_COUNT = 7
const CHART_W = 300
const RATE_H = 90
const LATENCY_H = 50

const mbps = (bytesPerSec: number) => (bytesPerSec * 8) / 1e6
const mbpsText = (bytesPerSec: number) => `${mbps(bytesPerSec).toFixed(mbps(bytesPerSec) < 10 ? 2 : 1)} Mbps`
const PART_NAMES: Record<string, string> = {
    [OTHER]: "protocol overhead (DTLS/SCTP framing, acks, resends)",
    [CONTROL]: "gateway control",
    [HEARTBEAT]: "heartbeat",
    [RTP_HEADERS]: "video RTP headers",
    [RESENT]: "video resent (NACK)",
}
// a named part, a dimos topic by its name, another key (Desktop's events) by its last two parts
const streamName = (key: string) => PART_NAMES[key] ?? parseKey(key)?.name ?? `…/${key.split("/").slice(-2).join("/")}`
const colorOf = (slot: number | undefined) => slot === undefined ? "var(--net-other)" : `var(--net-${slot + 1})`

/** a round axis top over `value` (1, 2, 5 × 10^n) */
function niceCeil(value: number): number {
    if (value <= 0) {
        return 1
    }
    const power = 10 ** Math.floor(Math.log10(value))
    return ([1, 2, 5, 10].find((step) => step * power >= value) ?? 10) * power
}

/** each sample's bytes/s per colour slot (index SLOT_COUNT: other), stacked bottom to top in slot order */
function stackOf(sample: NetSample, slots: Map<string, number>): number[] {
    const layers = new Array(SLOT_COUNT + 1).fill(0)
    for (const [key, rate] of Object.entries(sample.streams)) {
        const slot = slots.get(key)
        layers[slot ?? SLOT_COUNT] += rate
    }
    const counted = layers.reduce((sum, value) => sum + value, 0)
    layers[SLOT_COUNT] += Math.max(0, (sample.bytesPerSec ?? 0) - counted)
    return layers
}

export function NetworkPanel({ app, onStatus }: { app: ViewerApp; onStatus: () => void }) {
    const history = app.connection.network
    const [, redraw] = useState(0)
    const slots = useRef(new Map<string, number>()).current
    const [hover, setHover] = useState<number | null>(null)
    useEffect(() => {
        const timer = setInterval(() => redraw((n) => n + 1), 1000)
        return () => clearInterval(timer)
    }, [])
    const samples = history.samples.toArray()
    for (const sample of samples) {
        assignSlots(slots, Object.keys(sample.streams).sort(), SLOT_COUNT)
    }
    const latest = samples.at(-1)
    if (!latest) {
        return <div className="net-panel"><p className="hint">Collecting… the first sample comes a second after the link connects.</p></div>
    }
    const end = latest.at
    const span = Math.max(60_000, end - samples[0].at)
    const x = (at: number) => CHART_W - ((end - at) / span) * CHART_W
    const stacks = samples.map((sample) => stackOf(sample, slots))
    const rateTop = niceCeil(Math.max(...stacks.map((layers) => mbps(layers.reduce((sum, value) => sum + value, 0)))))
    const latencyTop = niceCeil(Math.max(...samples.map((sample) => sample.latencyMs ?? 0)))
    // stacked areas, bottom (slot 0) up; "other" on top
    const bands = Array.from({ length: SLOT_COUNT + 1 }, (_, layer) => {
        const below = stacks.map((layers) => layers.slice(0, layer).reduce((sum, value) => sum + value, 0))
        const above = stacks.map((layers, index) => below[index] + layers[layer])
        if (above.every((value, index) => value === below[index])) {
            return null
        }
        const y = (bytesPerSec: number) => RATE_H - (mbps(bytesPerSec) / rateTop) * RATE_H
        const top = samples.map((sample, index) => `${x(sample.at).toFixed(1)},${y(above[index]).toFixed(1)}`)
        const bottom = samples.map((sample, index) => `${x(sample.at).toFixed(1)},${y(below[index]).toFixed(1)}`).reverse()
        return <polygon key={layer} points={[...top, ...bottom].join(" ")} fill={layer === SLOT_COUNT ? "var(--net-other)" : colorOf(layer)} />
    })
    const latencyLine = samples
        .filter((sample) => sample.latencyMs !== null)
        .map((sample) => `${x(sample.at).toFixed(1)},${(LATENCY_H - (sample.latencyMs! / latencyTop) * LATENCY_H).toFixed(1)}`)
        .join(" ")
    const shown = hover === null ? latest : samples[hover]
    const rows = breakdown(shown)
    const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
        const box = event.currentTarget.getBoundingClientRect()
        const at = end - (1 - (event.clientX - box.left) / box.width) * span
        let nearest = 0
        samples.forEach((sample, index) => {
            if (Math.abs(sample.at - at) < Math.abs(samples[nearest].at - at)) {
                nearest = index
            }
        })
        setHover(nearest)
    }
    const cursor = hover === null ? null : <line className="net-cursor" x1={x(samples[hover].at)} x2={x(samples[hover].at)} y1={0} y2={1000} vectorEffect="non-scaling-stroke" />
    const ago = Math.round((end - shown.at) / 1000)
    return (
        <div className="net-panel" data-testid="network-panel">
            <div className="net-now">
                <span><b>{shown.bytesPerSec === null ? "—" : mbpsText(shown.bytesPerSec)}</b> throughput</span>
                <span><b>{shown.latencyMs === null ? "—" : `${Math.round(shown.latencyMs)} ms`}</b> latency</span>
                <span className="dim">{hover === null ? "now" : `${ago} s ago`}</span>
            </div>
            <div className="net-chart">
                <div className="net-axis"><span>{rateTop} Mbps</span><span>throughput, by stream</span></div>
                <svg viewBox={`0 0 ${CHART_W} ${RATE_H}`} preserveAspectRatio="none" style={{ height: RATE_H }} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Throughput over time, stacked by stream">
                    {bands}
                    {cursor}
                </svg>
            </div>
            <div className="net-chart">
                <div className="net-axis"><span>{latencyTop} ms</span><span>latency (control round trip)</span></div>
                <svg viewBox={`0 0 ${CHART_W} ${LATENCY_H}`} preserveAspectRatio="none" style={{ height: LATENCY_H }} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Latency over time">
                    <polyline points={latencyLine} className="net-latency" vectorEffect="non-scaling-stroke" />
                    {cursor}
                </svg>
                <div className="net-axis dim"><span>−{Math.round(span / 1000)} s</span><span>now</span></div>
            </div>
            <table className="net-streams">
                <thead><tr><th>stream</th><th>Mbps</th><th>share</th></tr></thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row.key} title={row.key}>
                            <td><span className="net-swatch" style={{ background: row.key === OTHER ? "var(--net-other)" : colorOf(slots.get(row.key)) }} />{streamName(row.key)}</td>
                            <td>{mbps(row.bytesPerSec).toFixed(2)}</td>
                            <td>{Math.round(row.share * 100)}%</td>
                        </tr>
                    ))}
                    {!rows.length && <tr><td colSpan={3} className="dim">nothing received in the last second</td></tr>}
                </tbody>
            </table>
            <p className="hint">
                All counted by this browser (WebRTC stats), each second: throughput is the wire's bytes, a stream its data
                channel's payload or its video track's; protocol overhead is the wire beyond everything named (the browser
                doesn't count DTLS/SCTP framing or SCTP resends on their own). Latency is the heartbeat's round trip. <button type="button" className="net-link" onClick={onStatus}>Status</button>
            </p>
        </div>
    )
}
