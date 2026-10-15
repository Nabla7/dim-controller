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
