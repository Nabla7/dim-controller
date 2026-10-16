// The Network modal's "Bandwidth Consumers" controls: this viewer's override of any stream's subscription options, by
// topic key: paused (no subscription at all), its bandwidth priority, and the advanced ones (quality ↔ Hz tradeoff,
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
    /** zenoh-gateway's bandwidthPriority (default 1): a short link's cut is split in proportion to demand / priority; 0 gives up everything first */
    bandwidthPriority?: number
    /** 0 keeps quality and drops Hz, 1 keeps Hz and drops quality (gateway default 0.5) */
    qualityToHzTradeoff?: number
    /** "latest" (most recent: newest only, never resent) or "reliable" (every message, in order, never shrunk) */
    delivery?: "latest" | "reliable"
    maxHz?: number
    /** video only (the gateway refuses it on a data channel), bits/s */
    maxBitrate?: number
}

/** the overridable subscription options (all but paused) */
export const OVERRIDE_OPTIONS = ["bandwidthPriority", "qualityToHzTradeoff", "delivery", "maxHz", "maxBitrate"] as const

/** what zenoh-gateway's Subscription.update changes in place (SubscriptionUpdate); anything else takes a new subscription */
export const UPDATABLE_OPTIONS = new Set(["maxHz", "minQuality", "qualityToHzTradeoff", "bandwidthPriority", "maxBitrate", "minResolutionScale", "maxResolution", "playoutDelay", "encodeOptions"])

/** the gateway's default when a subscription doesn't set one */
export const DEFAULT_PRIORITY = 1
export const DEFAULT_TRADEOFF = 0.5

/** the − / + steps of bandwidthPriority: "last" yields everything before any other stream gives up anything, ×N takes 1/N of the cut */
export const PRIORITY_STEPS = [0, 0.25, 0.5, 1, 2, 4, 8]

/** The priority as a level: 0 is the gateway's default, each + / − step doubles or halves the stream's share (log2 of bandwidthPriority). */
export function priorityLabel(priority: number): string {
    if (priority <= 0) {
        return "last"
    }
    const level = Math.round(Math.log2(priority))
    return level > 0 ? `+${level}` : `${level}`
}

/** The next step up (+1) or down (−1) from `priority` (which may sit between steps, e.g. an app's 0.2); the end steps stay. */
export function stepPriority(priority: number, direction: 1 | -1): number {
    if (direction > 0) {
        return PRIORITY_STEPS.find((step) => step > priority + 1e-9) ?? PRIORITY_STEPS.at(-1)!
    }
    return [...PRIORITY_STEPS].reverse().find((step) => step < priority - 1e-9) ?? PRIORITY_STEPS[0]
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
        if (value !== undefined && value !== null && !(name === "paused" && value === false)) {
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
export const bandwidthOverrides = new Store<Record<string, StreamOverride>>(readLocal<Record<string, StreamOverride>>(STORAGE_KEY, {}))

export function setOverride(key: string, patch: Partial<StreamOverride> | null) {
    bandwidthOverrides.set(patchOverrides(bandwidthOverrides.get(), key, patch))
    writeLocal(STORAGE_KEY, bandwidthOverrides.get())
}

export const isPaused = (overrides: Record<string, StreamOverride>, key: string) => !!overrides[key]?.paused
