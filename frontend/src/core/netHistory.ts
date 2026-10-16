// The link's recent past for the Network panel (ui/NetworkPanel.tsx): once a second, the throughput reaching the page,
// the control link's latency, and what used it, all from this page's own WebRTC stats (RTCPeerConnection.getStats):
// each subscription's data channel (its label names the key), each video track's payload (its m-line's mid, also in its
// data channel's label), the video's RTP headers and resent packets, the gateway's control and heartbeat channels, and
// the rest of the wire (DTLS/SCTP framing and acks, SCTP resends, ICE: the browser counts these only in the total).
// Pure (no DOM): tested in test/netHistory.test.ts.

export interface NetSample {
    /** ms (performance.now()) */
    at: number
    /** wire bytes/s reaching the page; null: no data */
    bytesPerSec: number | null
    latencyMs: number | null
    /** what used the wire, bytes/s: a subscription key, or one of the named parts (CONTROL, HEARTBEAT, RTP_HEADERS, RESENT) */
    streams: Record<string, number>
}

/** 5 minutes at one sample a second */
export const HISTORY_SAMPLES = 300

/** the wire beyond everything counted */
export const OTHER = "other"
export const CONTROL = "control"
export const HEARTBEAT = "heartbeat"
export const RTP_HEADERS = "rtp headers"
export const RESENT = "video resent"

/** A fixed-size ring: the newest `capacity` items, oldest first. */
export class Ring<T> {
    #items: T[] = []
    #start = 0
    constructor(readonly capacity: number) {}
    push(item: T) {
        if (this.#items.length < this.capacity) {
            this.#items.push(item)
            return
        }
        this.#items[this.#start] = item
        this.#start = (this.#start + 1) % this.capacity
    }
    get length() {
        return this.#items.length
    }
    toArray(): T[] {
        return [...this.#items.slice(this.#start), ...this.#items.slice(0, this.#start)]
    }
    last(): T | undefined {
        return this.#items.length ? this.#items[(this.#start + this.#items.length - 1) % this.#items.length] : undefined
    }
}

/** the counters this needs from one getStats report: the wire total and, per part, bytes received so far */
export interface WireCounts {
    wire: number | null
    parts: Record<string, number>
}

type Stat = Record<string, unknown>
const count = (value: unknown) => typeof value === "number" ? value : 0

/** What a data channel carries, from the label zenoh-gateway's client gives it: a key, control or the heartbeat. */
function channelOf(label: string): { part: string; mid?: string } {
    if (label === "control") {
        return { part: CONTROL }
    }
    try {
        const parsed = JSON.parse(label) as { type?: string; key?: string; mid?: string | number }
        if (parsed.type === "heartbeat") {
            return { part: HEARTBEAT }
        }
        if (typeof parsed.key === "string") {
            return { part: parsed.key, mid: parsed.mid === undefined ? undefined : String(parsed.mid) }
        }
    } catch {
        // another app's channel: counted under its own label
    }
    return { part: label }
}

/**
 * One getStats report as counters: the transport's bytesReceived (the wire), each data channel's under its key, each
 * video m-line's payload under the key whose channel names its mid (minus resent bytes), its RTP headers and resends.
 */
export function wireCounts(report: { forEach(callback: (stat: Stat) => void): void }): WireCounts {
    const stats: Stat[] = []
    report.forEach((stat) => stats.push(stat))
    let wire: number | null = null
    const parts: Record<string, number> = {}
    const add = (part: string, bytes: number) => {
        parts[part] = (parts[part] ?? 0) + bytes
    }
    const keyOfMid = new Map<string, string>()
    for (const stat of stats) {
        if (stat.type === "transport" && typeof stat.bytesReceived === "number") {
            wire = Math.max(wire ?? 0, stat.bytesReceived)
        } else if (stat.type === "data-channel" && typeof stat.label === "string") {
            const { part, mid } = channelOf(stat.label)
            add(part, count(stat.bytesReceived))
            if (mid !== undefined) {
                keyOfMid.set(mid, part)
            }
        }
    }
    for (const stat of stats) {
        if (stat.type !== "inbound-rtp") {
            continue
        }
        const resent = count(stat.retransmittedBytesReceived)
        add(keyOfMid.get(String(stat.mid)) ?? `video (mid ${stat.mid})`, count(stat.bytesReceived) - resent)
        add(RTP_HEADERS, count(stat.headerBytesReceived))
        add(RESENT, resent)
    }
    return { wire, parts }
}

/** Bytes/s per part between two reports; a part new since the last, or whose count went back (a channel remade), has none. */
export function partRates(previous: Record<string, number>, next: Record<string, number>, elapsedMs: number): Record<string, number> {
    const rates: Record<string, number> = {}
    for (const [part, bytes] of Object.entries(next)) {
        const before = previous[part]
        if (elapsedMs > 0 && before !== undefined && bytes >= before) {
            rates[part] = ((bytes - before) * 1000) / elapsedMs
        }
    }
    return rates
}

export interface StreamShare {
    /** a part (a subscription key or a named one), or OTHER */
    key: string
    bytesPerSec: number
    /** of the wire total (or of the parts' sum without one), 0..1 */
    share: number
}

/** The mean of several samples (the wire and each stream), so a table built from it doesn't jump every second. */
export function averageOf(samples: Pick<NetSample, "bytesPerSec" | "streams">[]): Pick<NetSample, "bytesPerSec" | "streams"> {
    const wire = samples.map((sample) => sample.bytesPerSec).filter((value): value is number => value !== null)
    const streams: Record<string, number> = {}
    for (const sample of samples) {
        for (const [key, rate] of Object.entries(sample.streams)) {
            streams[key] = (streams[key] ?? 0) + rate / samples.length
        }
    }
    return { bytesPerSec: wire.length ? wire.reduce((sum, value) => sum + value, 0) / wire.length : null, streams }
}

/** Who's using the link in one sample, largest first; OTHER is what the wire carried beyond the parts' sum. */
export function breakdown(sample: Pick<NetSample, "bytesPerSec" | "streams">): StreamShare[] {
    const rows = Object.entries(sample.streams).filter(([, bytesPerSec]) => bytesPerSec > 0).map(([key, bytesPerSec]) => ({ key, bytesPerSec }))
    const counted = rows.reduce((sum, row) => sum + row.bytesPerSec, 0)
    if (sample.bytesPerSec !== null && sample.bytesPerSec > counted) {
        rows.push({ key: OTHER, bytesPerSec: sample.bytesPerSec - counted })
    }
    const total = Math.max(sample.bytesPerSec ?? 0, counted)
    return rows.map((row) => ({ ...row, share: total > 0 ? row.bytesPerSec / total : 0 })).sort((a, b) => b.bytesPerSec - a.bytesPerSec)
}

/** The samples: each one the wire and parts since the last report. */
export class NetHistory {
    readonly samples: Ring<NetSample>
    #last: { at: number; counts: WireCounts } | null = null
    constructor(capacity = HISTORY_SAMPLES) {
        this.samples = new Ring(capacity)
    }

    /** One sample (once a second) from a getStats report's counts; null counts (no connection) record no data. */
    sample(at: number, counts: WireCounts | null, latencyMs: number | null) {
        const last = this.#last
        this.#last = counts && { at, counts }
        if (!counts || !last) {
            this.samples.push({ at, bytesPerSec: null, latencyMs, streams: {} })
            return
        }
        const elapsed = at - last.at
        const wire = counts.wire !== null && last.counts.wire !== null && counts.wire >= last.counts.wire && elapsed > 0 ? ((counts.wire - last.counts.wire) * 1000) / elapsed : null
        this.samples.push({ at, bytesPerSec: wire, latencyMs, streams: partRates(last.counts.parts, counts.parts, elapsed) })
    }
}

/** Gives each new stream key the first free colour slot (0..count-1) and keeps it, so a stream's colour never follows its rank; past `count` a key gets none (drawn as "other"). */
export function assignSlots(slots: Map<string, number>, keys: string[], count: number) {
    for (const key of keys) {
        if (slots.has(key) || key === OTHER) {
            continue
        }
        const taken = new Set(slots.values())
        const free = Array.from({ length: count }, (_, slot) => slot).find((slot) => !taken.has(slot))
        if (free !== undefined) {
            slots.set(key, free)
        }
    }
}

/** a round axis top just over `value` (1, 1.5, 2, 3, 4, 5, 6, 8 × 10^n), so the plot uses most of its height */
export function niceCeil(value: number): number {
    if (!(value > 0)) {
        return 1
    }
    const power = 10 ** Math.floor(Math.log10(value))
    return Number((([1, 1.5, 2, 3, 4, 5, 6, 8, 10].find((step) => step * power >= value * (1 - 1e-9)) ?? 10) * power).toPrecision(6))
}

/** The `fraction` (0..1) percentile of `values` by nearest rank; null for none. */
export function percentile(values: number[], fraction: number): number | null {
    if (!values.length) {
        return null
    }
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]
}

export interface NetSummary {
    /** bytes/s: the newest sample, the mean over the last `averageMs`, the most over all of them */
    rateNow: number | null
    rateAverage: number | null
    ratePeak: number | null
    /** ms: the newest, the 95th percentile and the most over all of them */
    latencyNow: number | null
    latencyP95: number | null
    latencyMax: number | null
}

/** The dashboard's headline numbers from the samples (oldest first); a missing value is skipped, not counted as 0. */
export function netSummary(samples: NetSample[], averageMs = 60_000): NetSummary {
    const end = samples.at(-1)?.at ?? 0
    const rates = samples.map((sample) => sample.bytesPerSec).filter((value): value is number => value !== null)
    const recent = samples.filter((sample) => end - sample.at < averageMs).map((sample) => sample.bytesPerSec).filter((value): value is number => value !== null)
    const latencies = samples.map((sample) => sample.latencyMs).filter((value): value is number => value !== null)
    return {
        rateNow: samples.at(-1)?.bytesPerSec ?? null,
        rateAverage: recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : null,
        ratePeak: rates.length ? Math.max(...rates) : null,
        latencyNow: samples.at(-1)?.latencyMs ?? null,
        latencyP95: percentile(latencies, 0.95),
        latencyMax: latencies.length ? Math.max(...latencies) : null,
    }
}

/**
 * A table order that doesn't jump: the previous order kept (keys no longer in `rates` dropped, new ones added at the
 * bottom), then a row moves above its neighbour only when its rate is over (1 + margin) times the neighbour's.
 */
export function stableOrder(previous: string[], rates: Record<string, number>, margin = 0.25): string[] {
    const order = previous.filter((key) => key in rates)
    order.push(...Object.keys(rates).filter((key) => !order.includes(key)).sort((a, b) => rates[b] - rates[a]))
    for (let moved = true; moved;) {
        moved = false
        for (let index = 1; index < order.length; index++) {
            if (rates[order[index]] > rates[order[index - 1]] * (1 + margin)) {
                ;[order[index - 1], order[index]] = [order[index], order[index - 1]]
                moved = true
            }
        }
    }
    return order
}

/**
 * The streams table: the last `averageSamples`' average of every stream with traffic in the last `orderSamples`, and of
 * every `alwaysKeys` one (the page's subscriptions, paused ones too: 0 without traffic), in a stableOrder by the longer
 * average (a stream gone quiet shows 0 until it leaves that window).
 */
export function streamTable(samples: NetSample[], previousOrder: string[], averageSamples: number, orderSamples: number, alwaysKeys: string[] = []): StreamShare[] {
    const shown = new Map(breakdown(averageOf(samples.slice(-averageSamples))).map((row) => [row.key, row]))
    const longRates = Object.fromEntries(breakdown(averageOf(samples.slice(-orderSamples))).map((row) => [row.key, row.bytesPerSec]))
    for (const key of [...shown.keys(), ...alwaysKeys]) {
        longRates[key] ??= 0
    }
    return stableOrder(previousOrder, longRates).map((key) => shown.get(key) ?? { key, bytesPerSec: 0, share: 0 })
}

/** The index of the sample nearest `at` (samples oldest first); -1 for none. */
export function nearestIndex(samples: Pick<NetSample, "at">[], at: number): number {
    let nearest = -1
    samples.forEach((sample, index) => {
        if (nearest < 0 || Math.abs(sample.at - at) < Math.abs(samples[nearest].at - at)) {
            nearest = index
        }
    })
    return nearest
}

/** A sample's bytes/s per colour slot (index `slotCount`: everything without one, and the wire beyond the parts), bottom to top in slot order. */
export function stackOf(sample: Pick<NetSample, "bytesPerSec" | "streams">, slots: Map<string, number>, slotCount: number): number[] {
    const layers = new Array(slotCount + 1).fill(0)
    for (const [key, rate] of Object.entries(sample.streams)) {
        layers[slots.get(key) ?? slotCount] += rate
    }
    const counted = layers.reduce((sum, value) => sum + value, 0)
    layers[slotCount] += Math.max(0, (sample.bytesPerSec ?? 0) - counted)
    return layers
}
