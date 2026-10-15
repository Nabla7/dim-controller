// The link's recent past for the Network panel (ui/NetworkPanel.tsx): once a second, the throughput reaching the page and
// the control link's latency, and each stream's share. A stream's rate is the gateway's own count (each subscription's
// `bytesSent` in its stats: data-channel frames handed to SCTP, or video handed to the track) differenced between two
// stats replies; what the wire carried beyond their sum (SCTP/DTLS/UDP and RTP framing, control, heartbeats) is "other".
// Pure (no DOM): tested in test/netHistory.test.ts.

/** one gateway channel as a stats reply lists it (zenoh-gateway SPEC "Stats": `channels`) */
export interface ChannelReport {
    id: number | null
    type: string
    key: string
    stats: Record<string, unknown>
}

export interface NetSample {
    /** ms (performance.now()) */
    at: number
    /** wire bytes/s reaching the page; null: no data */
    bytesPerSec: number | null
    latencyMs: number | null
    /** subscription key → bytes/s the gateway sent it (summed over that key's subscriptions); empty: no fresh stats */
    streams: Record<string, number>
}

/** 5 minutes at one sample a second */
export const HISTORY_SAMPLES = 300
/** stats older than this (the gateway asks for them at most every 10 s on a slow link) no longer count as now */
export const STREAM_STALE_MS = 12_000

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

/**
 * Per subscription key, bytes/s between two stats replies: each channel's `bytesSent` growth over the time between them.
 * A channel new since the last reply, or whose count went back (a reconnect remade it), has no rate yet.
 */
export function streamRates(previous: Map<number, number> | null, channels: ChannelReport[], elapsedMs: number): Record<string, number> {
    const rates: Record<string, number> = {}
    if (!previous || elapsedMs <= 0) {
        return rates
    }
    for (const channel of channels) {
        const bytes = Number(channel.stats.bytesSent)
        const before = channel.id === null ? undefined : previous.get(channel.id)
        if (channel.type !== "sub" || !Number.isFinite(bytes) || before === undefined || bytes < before) {
            continue
        }
        rates[channel.key] = (rates[channel.key] ?? 0) + ((bytes - before) * 1000) / elapsedMs
    }
    return rates
}

/** Each channel's `bytesSent` now, by id: the next reply's baseline. */
export function sentById(channels: ChannelReport[]): Map<number, number> {
    const sent = new Map<number, number>()
    for (const channel of channels) {
        const bytes = Number(channel.stats.bytesSent)
        if (channel.id !== null && Number.isFinite(bytes)) {
            sent.set(channel.id, bytes)
        }
    }
    return sent
}

export interface StreamShare {
    /** a subscription key, or "other" (wire bytes no stream accounts for) */
    key: string
    bytesPerSec: number
    /** of the wire total (or of the streams' sum without one), 0..1 */
    share: number
}

export const OTHER = "other"

/** Who's using the link in one sample, largest first; "other" is what the wire carried beyond the streams' sum. */
export function breakdown(sample: Pick<NetSample, "bytesPerSec" | "streams">): StreamShare[] {
    const rows = Object.entries(sample.streams).map(([key, bytesPerSec]) => ({ key, bytesPerSec }))
    const counted = rows.reduce((sum, row) => sum + row.bytesPerSec, 0)
    if (sample.bytesPerSec !== null && sample.bytesPerSec > counted) {
        rows.push({ key: OTHER, bytesPerSec: sample.bytesPerSec - counted })
    }
    const total = Math.max(sample.bytesPerSec ?? 0, counted)
    return rows.map((row) => ({ ...row, share: total > 0 ? row.bytesPerSec / total : 0 })).sort((a, b) => b.bytesPerSec - a.bytesPerSec)
}

/** The samples, and each stream's latest rate from the stats replies between them. */
export class NetHistory {
    readonly samples: Ring<NetSample>
    #sent: Map<number, number> | null = null
    #statsAt = -Infinity
    #streams: Record<string, number> = {}
    constructor(capacity = HISTORY_SAMPLES) {
        this.samples = new Ring(capacity)
    }

    /** A stats reply arrived at `at`: the streams' rates since the last one. */
    recordStats(channels: ChannelReport[], at: number) {
        this.#streams = streamRates(this.#sent, channels, at - this.#statsAt)
        this.#sent = sentById(channels)
        this.#statsAt = at
    }

    /** One sample (once a second); stream rates from stats older than STREAM_STALE_MS are left out. */
    sample(at: number, bytesPerSec: number | null, latencyMs: number | null) {
        const fresh = at - this.#statsAt <= STREAM_STALE_MS
        this.samples.push({ at, bytesPerSec, latencyMs, streams: fresh ? { ...this.#streams } : {} })
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
