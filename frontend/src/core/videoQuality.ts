// Camera presets: the latency-vs-quality tradeoff, per camera and per viewer, as bridge subscription options
// (zenoh-gateway's video policy: maxResolution, maxBitrate, minResolutionScale, minQuality, qualityToHzTradeoff,
// playoutDelay): the gateway encodes a smaller picture at fewer bits (each frame is fewer packets: on the wire, decoded and
// on screen sooner, and a squeezed link keeps the rate) or the full picture at more bits (dropping frames, not detail, when
// short). playoutDelay is the browser side: the gateway marks each video packet with it, and the receiver may hold frames
// that long to even out their arrival ([0, 0], the default, shows each the moment it decodes).
// A change applies in place (Subscription.update, zenoh-gateway >= 0.5.1): same subscription and track, no gap; leaving
// High quality's buffered playout takes a new subscription instead (core/video.ts needsNewReceiver: Firefox froze).
// The choice is per viewer (a phone on cellular wants low latency, a desktop on the LAN quality): localStorage, not the
// backend's shared settings.
import type { SubscribeOptions } from "./transport.ts"

export type VideoQuality = "latency" | "balanced" | "quality"

export interface QualityPreset {
    id: VideoQuality
    label: string
    about: string
    options: SubscribeOptions
}

// No preset sets maxHz: zenoh-gateway >= 0.5.1 encodes at min(maxHz, the source's measured rate), so a cap would only
// matter for a camera faster than it, and every preset wants the camera's own rate.
export const QUALITY_PRESETS: QualityPreset[] = [
    {
        id: "latency",
        label: "Low latency",
        about: "fits 640×360 at the gateway's default bits per pixel; small frames arrive and decode soonest, the rate kept when the link is squeezed",
        options: { maxResolution: [640, 360], qualityToHzTradeoff: 1 },
    },
    {
        id: "balanced",
        label: "Balanced",
        about: "the gateway picks size and bitrate for the bandwidth, at the camera's rate",
        options: {},
    },
    {
        id: "quality",
        label: "High quality",
        about: "full size, never shrunk, up to 20 Mbit/s (1080p30 at the gateway's 0.3 bits per pixel is ~18; at least 30% of it); drops frames before detail when the link is squeezed, and the browser buffers 100-400 ms to play frames out evenly",
        // the buffer is here, not in Low latency or Balanced (what driving uses): it trades a fraction of a second for even
        // motion, which is worth it when watching but not when steering; big full-size frames arrive the most unevenly
        options: { minResolutionScale: 1, maxBitrate: 20_000_000, minQuality: 0.3, qualityToHzTradeoff: 0, playoutDelay: [100, 400] },
    },
]

/** presets before 2026-10-07 (a size-vs-rate choice) → the nearest one now */
const RENAMED: Record<string, VideoQuality> = { auto: "balanced", smooth: "latency", sharp: "quality" }

export const presetFor = (id: string | undefined): QualityPreset =>
    QUALITY_PRESETS.find((preset) => preset.id === (RENAMED[id ?? ""] ?? id)) ?? QUALITY_PRESETS[1]

const QUALITY_KEY = "lv.video.quality"

/** This viewer's preset for a topic key (Balanced when unset, or storage is unavailable). */
export function loadQuality(topicKey: string): VideoQuality {
    return presetFor(readLocal<Record<string, string>>(QUALITY_KEY, {})[topicKey]).id
}

export function saveQuality(topicKey: string, quality: VideoQuality) {
    writeLocal(QUALITY_KEY, { ...readLocal<Record<string, string>>(QUALITY_KEY, {}), [topicKey]: quality })
}

/** localStorage JSON, or the fallback (private windows, blocked storage and tests throw or return nothing). */
export function readLocal<T>(key: string, fallback: T): T {
    try {
        const raw = globalThis.localStorage?.getItem(key)
        return raw ? JSON.parse(raw) as T : fallback
    } catch {
        return fallback
    }
}

export function writeLocal(key: string, value: unknown) {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value))
    } catch {
        // storage unavailable: the choice lasts for this page only
    }
}
