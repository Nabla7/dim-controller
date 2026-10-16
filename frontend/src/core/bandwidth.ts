// The Network modal's "Bandwidth Consumers" controls: this viewer's override of any stream's subscription options, by
// topic key: paused (no subscription at all), its bandwidth priority (levels on top of the page's own), and the advanced ones (quality ↔ Hz tradeoff,
// delivery, max Hz, max bitrate). core/transport.ts applies them under every subscription the page makes (the app's own
// options, then these on top), in place where zenoh-gateway's Subscription.update can (>= 0.5.1), by resubscribing
// where it can't (delivery). Per viewer like the camera and cloud presets (a phone on cellular and a desktop on the LAN
// want different things): localStorage, not the backend's shared settings. Pure but for the store: tested in
// test/bandwidth.test.ts.
import { Store } from "./store.ts"
import type { SubscribeOptions, SubscriptionUpdate } from "./transport.ts"
import { readLocal, writeLocal } from "./videoQuality.ts"

export interface StreamOverride {
    /** force-unsubscribed: closed (or never opened) while set, opened again when cleared */
    paused?: boolean
    /**
     * Levels on top of the priority the page gives the stream (PRIORITY_TIERS): each +1 doubles zenoh-gateway's
     * bandwidthPriority (a short link's cut is split by demand / priority), each −1 halves it; PRIORITY_LAST gives up first.
     */
    priorityOffset?: number
    /** 0 keeps quality and drops Hz, 1 keeps Hz and drops quality (gateway default 0.5) */
    qualityToHzTradeoff?: number
    /** "latest" (most recent: newest only, never resent) or "reliable" (every message, in order, never shrunk) */
    delivery?: "latest" | "reliable"
    maxHz?: number
    /** video only (the gateway refuses it on a data channel), bits/s */
    maxBitrate?: number
}

/** the overridable subscription options (all but paused) */
export const OVERRIDE_OPTIONS = ["qualityToHzTradeoff", "delivery", "maxHz", "maxBitrate"] as const

/** what zenoh-gateway's Subscription.update changes in place (SubscriptionUpdate); anything else takes a new subscription */
export const UPDATABLE_OPTIONS = new Set(["maxHz", "minQuality", "qualityToHzTradeoff", "bandwidthPriority", "maxBitrate", "minResolutionScale", "maxResolution", "playoutDelay", "encodeOptions"])

/** the gateway's default when a subscription doesn't set one */
export const DEFAULT_PRIORITY = 1

/**
 * This page's default bandwidthPriority tiers (levels +2 / 0 / −1 / −2): when the link is short, small control-critical
 * state keeps flowing, what you're looking at comes next, then the other views, then bulk.
 */
export const PRIORITY_TIERS = { state: 4, viewed: 1, background: 0.5, bulk: 0.25 } as const

/** small messages you can't control the robot without */
const STATE_TYPES = /^(sensor_msgs\.(JointState|BatteryState|Imu)|nav_msgs\.(Odometry|Path)|geometry_msgs\.\w+|std_msgs\.\w+)$/

/** The priority a subscription to a topic of `type` gets when its code sets none: small state high, maps bulk. */
export function defaultBandwidthPriority(type: string): number | undefined {
    if (STATE_TYPES.test(type)) {
        return PRIORITY_TIERS.state
    }
    if (type === "nav_msgs.OccupancyGrid") {
        return PRIORITY_TIERS.bulk
    }
    return undefined
}
export const DEFAULT_TRADEOFF = 0.5

/** the − / + range of an override's priorityOffset; PRIORITY_LAST yields everything before any other stream gives up anything */
export const PRIORITY_LAST = -4
export const PRIORITY_MAX = 3

/** A bandwidthPriority as a level (log2): the default 1 is 0, 0 is PRIORITY_LAST. */
export const levelOf = (priority: number) => (priority <= 0 ? PRIORITY_LAST : Math.round(Math.log2(priority)))

/** A level as the Network tab shows it: 0, +1, −2 or "last". */
export function priorityLabel(level: number): string {
    if (level <= PRIORITY_LAST) {
        return "last"
    }
    return level > 0 ? `+${level}` : `${level}`
}

/** One step up (+1) or down (−1) from an offset, kept within PRIORITY_LAST..PRIORITY_MAX. */
export const stepPriority = (offset: number, direction: 1 | -1) => Math.max(PRIORITY_LAST, Math.min(PRIORITY_MAX, offset + direction))

/** The bandwidthPriority a stream runs with: the page's, moved by the viewer's offset. */
export function offsetPriority(base: number | undefined, offset: number): number {
    return offset <= PRIORITY_LAST ? 0 : (base ?? DEFAULT_PRIORITY) * 2 ** offset
}

/** Whether options make a video channel (where delivery must stay "latest" and maxBitrate applies). */
export function isVideoOptions(options: SubscribeOptions, channelName?: string | null): boolean {
    const channel = channelName ?? options.channel
    if (channel) {
        return channel.startsWith("video")
    }
    // the gateway's dimos image encodings go out as H.264 unless asked otherwise; depth is a data encoding
    return typeof options.encoding === "string" && /image$/.test(options.encoding)
}

/** The options a subscription runs with: the app's, then this viewer's override on top (delivery and maxBitrate only where the gateway takes them). */
export function applyOverride(base: SubscribeOptions, override: StreamOverride | undefined, video = isVideoOptions(base)): SubscribeOptions {
    const options: SubscribeOptions = { ...base }
    if (!override) {
        return options
    }
    for (const name of OVERRIDE_OPTIONS) {
        const value = override[name]
        if (value === undefined || (name === "delivery" && video) || (name === "maxBitrate" && !video)) {
            continue
        }
        ;(options as Record<string, unknown>)[name] = value
    }
    if (override.priorityOffset !== undefined) {
        options.bandwidthPriority = offsetPriority(base.bandwidthPriority, override.priorityOffset)
    }
    return options
}

/** `options` with SubscriptionUpdate-style changes applied (null removes an option; encodeOptions merges). */
export function withChanges(options: SubscribeOptions, changes: SubscriptionUpdate | Record<string, unknown>): SubscribeOptions {
    const next: Record<string, unknown> = { ...options }
    for (const [name, value] of Object.entries(changes)) {
        if (value === null) {
            delete next[name]
        } else if (value !== undefined) {
            next[name] = name === "encodeOptions" ? { ...options.encodeOptions, ...(value as object) } : value
        }
    }
    return next as SubscribeOptions
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * What going from one set of options to another takes: the in-place update (null puts an option back to the gateway's
 * default), or a new subscription when anything else changed (delivery, encoding, channel, compress). encodeOptions can
 * only change its quality in place.
 */
export function optionDiff(from: SubscribeOptions, to: SubscribeOptions): { update: SubscriptionUpdate; resubscribe: boolean } {
    const update: Record<string, unknown> = {}
    let resubscribe = false
    const names = new Set([...Object.keys(from), ...Object.keys(to)])
    for (const name of names) {
        const before = (from as Record<string, unknown>)[name]
        const after = (to as Record<string, unknown>)[name]
        if (same(before, after)) {
            continue
        }
        if (name === "encodeOptions") {
            const { quality: qualityBefore, ...restBefore } = (before ?? {}) as Record<string, unknown>
            const { quality: qualityAfter, ...restAfter } = (after ?? {}) as Record<string, unknown>
            if (!same(restBefore, restAfter) || (qualityAfter === undefined && qualityBefore !== undefined)) {
                resubscribe = true
            } else {
                update.encodeOptions = { quality: qualityAfter }
            }
        } else if (UPDATABLE_OPTIONS.has(name)) {
            update[name] = after === undefined ? null : after
        } else {
            resubscribe = true
        }
    }
    return { update: update as SubscriptionUpdate, resubscribe }
}

/** An override without unset fields; null when nothing is left (the stream back to the app's options). */
export function normalizeOverride(override: StreamOverride): StreamOverride | null {
    const kept: StreamOverride = {}
    for (const [name, value] of Object.entries(override)) {
        if (value !== undefined && value !== null && !(name === "paused" && value === false) && !(name === "priorityOffset" && value === 0)) {
            ;(kept as Record<string, unknown>)[name] = value
        }
    }
    return Object.keys(kept).length ? kept : null
}

/** The overrides with one stream's patched (undefined clears a field). */
export function patchOverrides(overrides: Record<string, StreamOverride>, key: string, patch: Partial<StreamOverride> | null): Record<string, StreamOverride> {
    const next = { ...overrides }
    const merged = patch === null ? null : normalizeOverride({ ...overrides[key], ...patch })
    if (merged) {
        next[key] = merged
    } else {
        delete next[key]
    }
    return next
}

/** A consumption heat 0..1 from a stream's rate: its share of the busiest stream's, on a square-root scale so a 10% stream still shows. */
export function heatOf(bytesPerSec: number, busiestBytesPerSec: number): number {
    if (!(bytesPerSec > 0) || !(busiestBytesPerSec > 0)) {
        return 0
    }
    return Math.min(1, Math.sqrt(bytesPerSec / busiestBytesPerSec))
}

const STORAGE_KEY = "lv.bandwidth"

/** topic key → this viewer's override */
export const bandwidthOverrides = new Store<Record<string, StreamOverride>>(migrateOverrides(readLocal<Record<string, unknown>>(STORAGE_KEY, {})))

/** Saved before offsets: an absolute bandwidthPriority, taken as levels from the default. */
export function migrateOverrides(saved: Record<string, unknown>): Record<string, StreamOverride> {
    const overrides: Record<string, StreamOverride> = {}
    for (const [key, value] of Object.entries(saved ?? {})) {
        const { bandwidthPriority, ...rest } = (value ?? {}) as StreamOverride & { bandwidthPriority?: number }
        const migrated = normalizeOverride(typeof bandwidthPriority === "number" && rest.priorityOffset === undefined ? { ...rest, priorityOffset: levelOf(bandwidthPriority) } : rest)
        if (migrated) {
            overrides[key] = migrated
        }
    }
    return overrides
}

export function setOverride(key: string, patch: Partial<StreamOverride> | null) {
    bandwidthOverrides.set(patchOverrides(bandwidthOverrides.get(), key, patch))
    writeLocal(STORAGE_KEY, bandwidthOverrides.get())
}

export const isPaused = (overrides: Record<string, StreamOverride>, key: string) => !!overrides[key]?.paused
