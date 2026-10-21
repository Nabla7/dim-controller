// Point-cloud presets: the bandwidth-vs-detail tradeoff, per cloud and per viewer, as gateway subscription options
// (zenoh-dimos-codecs' dimos_lcm_pointcloud2 thins to 1 point in round(1/quality), at most 1 in 16, and quantizes to
// int16; `encodeOptions.quality` caps what the bandwidth allocator may pick, `minQuality` floors it). Per viewer (a
// phone on cellular wants less than a desktop on the LAN): localStorage.
import { readLocal, Store, writeLocal } from "./store.ts"
import type { DataSource, Message, SubscribeOptions, Subscription } from "../data.ts"

export type CloudQuality = "low" | "balanced" | "full"

export interface CloudPreset {
    id: CloudQuality
    label: string
    about: string
    maxHz: number
    quality: number
    minQuality?: number
}

export interface CloudRate {
    hz: number
    pointsPerSecond: number
    bytesPerSecond: number
}

export const CLOUD_PRESETS: CloudPreset[] = [
    {
        id: "low",
        label: "Low bandwidth",
        about: "up to 5 Hz, at most 1 point in 4 (fewer when the link is short)",
        maxHz: 5,
        quality: 0.25,
    },
    {
        id: "balanced",
        label: "Balanced",
        about: "up to 20 Hz, every point unless the link is short",
        maxHz: 20,
        quality: 1,
    },
    {
        id: "full",
        label: "Full",
        about: "up to 30 Hz, every point, never thinned (drops scans instead)",
        maxHz: 30,
        quality: 1,
        minQuality: 1,
    },
]

/** The preset with `id`, else Balanced. */
export const cloudPreset = (id?: string | null): CloudPreset =>
    CLOUD_PRESETS.find((preset) => preset.id === id) ?? CLOUD_PRESETS[1]

/** The gateway subscription for a cloud at a preset. */
export function cloudOptions(preset: CloudPreset): SubscribeOptions {
    return {
        delivery: "latest",
        encoding: "dimos_lcm_pointcloud2",
        maxHz: preset.maxHz,
        encodeOptions: { quality: preset.quality },
        ...(preset.minQuality !== undefined ? { minQuality: preset.minQuality } : {}),
    }
}

/** What changes going to `to` (zenoh-gateway >= 0.5.1's Subscription.update: null removes an option). */
export function cloudChanges(to: CloudPreset) {
    return { maxHz: to.maxHz, minQuality: to.minQuality ?? null, encodeOptions: { quality: to.quality } }
}

const QUALITY_KEY = "dimos-react.clouds.quality"

/** topic key → this viewer's preset (missing = Balanced) */
export const cloudQualities = new Store(readLocal<Record<string, CloudQuality>>(QUALITY_KEY, {}))

export function setCloudQuality(key: string, quality: CloudQuality) {
    cloudQualities.update({ [key]: quality })
    writeLocal(QUALITY_KEY, cloudQualities.get())
}

export const cloudQualityOf = (key: string): CloudQuality => cloudPreset(cloudQualities.get()[key]).id

/** topic key → live rate of each cloud being drawn (gone when it stops) */
export const cloudRates = new Store<Record<string, CloudRate>>({})

export function setCloudRate(key: string, rate: CloudRate | null | undefined) {
    const next = { ...cloudRates.get() }
    if (rate) {
        next[key] = rate
    } else {
        delete next[key]
    }
    cloudRates.set(next)
}

/** A decoded cloud's `positions` (x, y, z, ...), if `value` has them. */
const positionsOf = (value: unknown): ArrayLike<number> | undefined =>
    (value as { positions?: ArrayLike<number> } | null | undefined)?.positions

/**
 * One cloud's subscription at its preset: a preset change updates it in place where the gateway can (else opens the
 * new one, then closes the old), and it counts what arrives.
 */
export class CloudStream {
    #stop: Subscription
    #preset: CloudPreset
    #closed = false
    #counted = { scans: 0, points: 0, bytes: 0, since: 0 }
    onMessage: (message: Message) => void
    key: string
    source: Pick<DataSource, "subscribe">

    /**
     * @param source a data source
     */
    constructor(
        source: Pick<DataSource, "subscribe">,
        key: string,
        quality: CloudQuality,
        onMessage: (message: Message) => void,
        now = performance.now(),
    ) {
        this.source = source
        this.key = key
        this.onMessage = onMessage
        this.#preset = cloudPreset(quality)
        this.#counted.since = now
        this.#stop = this.#open()
    }

    get quality(): CloudQuality {
        return this.#preset.id
    }

    #open(): Subscription {
        return this.source.subscribe(this.key, cloudOptions(this.#preset), (message) => {
            const positions = positionsOf(message.decoded) ?? positionsOf(message.value)
            this.#counted.scans++
            this.#counted.points += positions ? positions.length / 3 : 0
            this.#counted.bytes += message.bytes?.byteLength ?? 0
            this.onMessage(message)
        })
    }

    async setQuality(quality: CloudQuality) {
        const preset = cloudPreset(quality)
        if (this.#closed || preset.id === this.#preset.id) {
            return
        }
        this.#preset = preset
        const handle = this.#stop
        if (handle.update) {
            try {
                await handle.update(cloudChanges(preset))
                return
            } catch {
                // a gateway without in-place updates: resubscribe below
            }
        }
        if (this.#closed || this.#stop !== handle || this.#preset !== preset) {
            return
        }
        this.#stop = this.#open()
        handle()
    }

    /** scans, points and bytes a second since the last call */
    sample(now = performance.now()): CloudRate {
        const seconds = Math.max(1e-3, (now - this.#counted.since) / 1000)
        const rate = {
            hz: this.#counted.scans / seconds,
            pointsPerSecond: this.#counted.points / seconds,
            bytesPerSecond: this.#counted.bytes / seconds,
        }
        this.#counted = { scans: 0, points: 0, bytes: 0, since: now }
        return rate
    }

    close() {
        this.#closed = true
        this.#stop()
    }
}

export const formatCount = (count: number) =>
    count >= 1e6
        ? `${(count / 1e6).toFixed(1)}M`
        : count >= 1000
        ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`
        : String(Math.round(count))

export const formatBytes = (bytes: number) =>
    bytes >= 1e6
        ? `${(bytes / 1e6).toFixed(1)} MB`
        : bytes >= 1000
        ? `${Math.round(bytes / 1000)} kB`
        : `${Math.round(bytes)} B`
