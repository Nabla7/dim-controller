// What the one bar (ui/ActionDock.tsx; a phone's corner buttons) says about problems, worked out here so it's tested
// (test/barStatus.test.ts): the link when it isn't healthy, driving when it's disengaged (latency over the max, the link
// lost), and the gamepad's state. A healthy link says nothing: the Status panel has the numbers.
import type { ConnectionState } from "../core/transport.ts"
import type { DriveHalt } from "../core/drive.ts"
import type { GamepadStatus } from "../core/gamepad.ts"
import type { LeaseState } from "../core/lease.ts"
import { spreadText, type VideoLatency } from "../core/videoLatency.ts"

export type Tone = "ok" | "warn" | "bad"

/** a round trip over this (ms) is worth a warning even before it disengages driving */
export const SLOW_RTT_MS = 250

/** The link, only when it's a problem: lost, (re)connecting, degraded, or slow. Null: healthy, nothing to show. */
export function linkProblem(connection: Pick<ConnectionState, "state" | "rttMs" | "droppedPerSecond" | "error">): { text: string; tone: Tone; detail: string } | null {
    if (connection.state === "lost") {
        return { text: "No link", tone: "bad", detail: `The gateway isn't answering${connection.error ? ` (${connection.error})` : ""}: no robot data, no driving` }
    }
    if (connection.state === "connecting") {
        return { text: "Connecting", tone: "warn", detail: "Opening the link to the gateway" }
    }
    if (connection.state === "degraded") {
        return { text: "Link degraded", tone: "warn", detail: `The link is struggling${connection.droppedPerSecond ? ` (${connection.droppedPerSecond} dropped/s)` : ""}` }
    }
    if (connection.rttMs !== null && connection.rttMs > SLOW_RTT_MS) {
        return { text: `Slow link · ${Math.round(connection.rttMs)} ms`, tone: "warn", detail: `Round trip over ${SLOW_RTT_MS} ms: driving reacts late` }
    }
    return null
}

/** the link chip's numbers: sampled every LINK_SAMPLE_MS into an average over ~LINK_SMOOTH_MS, redrawn every LINK_REDRAW_MS */
export const LINK_SAMPLE_MS = 250
export const LINK_SMOOTH_MS = 3000
export const LINK_REDRAW_MS = 1000

/** An exponential moving average with time constant `tauMs`; no sample (no data) clears it, a first sample starts it. */
export function smoothed(previous: number | null, sample: number | null, elapsedMs: number, tauMs = LINK_SMOOTH_MS): number | null {
    if (sample === null || previous === null) {
        return sample
    }
    return previous + (1 - Math.exp(-elapsedMs / tauMs)) * (sample - previous)
}

// Figure spaces are digit-wide and never collapse, so the chip keeps one width as the numbers change.
const padDigits = (text: string, width: number) => text.padStart(width, "\u2007")

/** A rate in megabits, like a speed test, always five characters wide: "  1.9 Mbps", " 25.0 Mbps". */
export function rateText(bytesPerSecond: number): string {
    const megabits = Math.min((bytesPerSecond * 8) / 1e6, 999.9)
    return `${padDigits(megabits.toFixed(1), 5)} Mbps`
}

/**
 * The link chip, always shown: live throughput and latency ("  1.9 Mbps ·   89 ms", padded to a fixed width), the latency
 * the slowest camera's typical (p50) source-to-screen ms once one is measured (zenoh-gateway >= 0.5.21), else the control
 * round trip; its spike and the round trip are in `detail`. Coloured by linkProblem; lost or connecting says so instead.
 */
export function linkChip(connection: Pick<ConnectionState, "state" | "rttMs" | "droppedPerSecond" | "error" | "throughputBytesPerSec">, latencyMs: number | null, video: VideoLatency | null = null, badMs = Infinity): { text: string; tone: Tone; detail: string; numbers?: { rate: string; ms: string } } {
    const problem = linkProblem(connection)
    if (connection.state === "lost" || connection.state === "connecting") {
        return problem!
    }
    const rate = connection.throughputBytesPerSec === null ? `${padDigits("—", 5)} Mbps` : rateText(connection.throughputBytesPerSec)
    const shownMs = video ? video.total.p50 : latencyMs
    const ms = shownMs === null ? "—" : String(Math.min(Math.round(shownMs), 9999))
    const latency = `${padDigits(ms, 4)} ms`
    const roundTrip = latencyMs === null ? "—" : `${Math.round(latencyMs)} ms`
    // the number shown colours the chip too: slow past SLOW_RTT_MS, bad past driving's own max latency (`badMs`)
    const shownTone: Tone = shownMs === null ? "ok" : shownMs > badMs ? "bad" : shownMs > SLOW_RTT_MS ? "warn" : "ok"
    const tones: Tone[] = ["ok", "warn", "bad"]
    const tone = tones[Math.max(tones.indexOf(problem?.tone ?? "ok"), tones.indexOf(shownTone))]
    return {
        text: `${rate} · ${latency}`,
        numbers: { rate: rate.replace(" Mbps", "").replaceAll("\u2007", ""), ms },
        tone,
        detail: `${problem?.detail ?? (shownTone === "ok" ? "Link healthy" : `${video ? "Video" : "Round trip"} ${Math.round(shownMs!)} ms: ${shownTone === "bad" ? `over driving's ${badMs} ms max` : `over ${SLOW_RTT_MS} ms`}`)}. ${video
            ? `Throughput reaching this page and the slowest camera's typical (p50) source-to-screen latency over the last 5 s: ${spreadText(video.total)}, the spike being its p95, the slowest 1 in 20 frames; control round trip ${roundTrip}`
            : "Throughput reaching this page and the control link's round trip"}`,
    }
}

/** Driving stopped by the link watch, in full ("Disengaged: latency 1240 ms > 1000 ms max. Reconnect to drive."). */
export function disengagedText(halt: Pick<DriveHalt, "reason" | "latencyMs" | "maxMs">): string {
    return halt.reason === "lost"
        ? "Disengaged: link lost. Reconnect to drive."
        : `Disengaged: latency ${halt.latencyMs !== null ? `${halt.latencyMs} ms > ` : "over "}${halt.maxMs} ms max. Reconnect to drive.`
}

/** The same, a few words (a chip, a Status row). */
export function disengagedShort(halt: Pick<DriveHalt, "reason" | "latencyMs" | "maxMs">): string {
    return halt.reason === "lost" ? "Disengaged · link lost" : `Disengaged · ${halt.latencyMs !== null ? `${halt.latencyMs} ms` : `over ${halt.maxMs} ms`}`
}

/** The gamepad chip: nothing without a pad. */
export function gamepadChip(pad: GamepadStatus): { text: string; tone: Tone; detail: string } | null {
    if (!pad.connected) {
        return null
    }
    if (pad.stopped) {
        return { text: "pad stopped", tone: "warn", detail: "LT + RT stopped it: press A to drive again" }
    }
    return pad.ready
        ? { text: "pad ready", tone: "ok", detail: "the sticks drive (LT + RT: STOP)" }
        : { text: "center sticks", tone: "warn", detail: "nothing is sent until both sticks are at rest and the triggers are out" }
}

/** The text a page shows once a newer viewer took the drive lease (the bar's chip). */
export const TAKEN_OVER_TEXT = "Another viewer is driving"
export const TAKE_BACK_TEXT = "Take control back"

/** The drive lease, only when another viewer has it: the bar's chip, a button that takes control back. Null: nothing to show. */
export function leaseChip(lease: LeaseState, mobile = false): { text: string; tone: Tone; detail: string } | null {
    if (lease.status !== "takenOver") {
        return null
    }
    return {
        text: mobile ? TAKE_BACK_TEXT : `${TAKEN_OVER_TEXT} · ${TAKE_BACK_TEXT}`,
        tone: "bad",
        detail: `${TAKEN_OVER_TEXT}: a newer viewer drove, so the gateway drops this page's commands (watching goes on). Click, or drive again after a pause, to take control back${lease.reason ? ` (${lease.reason})` : ""}.`,
    }
}
