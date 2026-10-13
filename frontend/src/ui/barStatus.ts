// What the one bar (ui/ActionDock.tsx; a phone's corner buttons) says about problems, worked out here so it's tested
// (test/barStatus.test.ts): the link when it isn't healthy, driving when it's disengaged (latency over the max, the link
// lost), and the gamepad's state. A healthy link says nothing: the Status panel has the numbers.
import type { ConnectionState } from "../core/transport.ts"
import type { DriveHalt } from "../core/drive.ts"
import type { GamepadStatus } from "../core/gamepad.ts"

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

/** A rate, short: "940 B/s", "240 KB/s", "3.1 MB/s". */
export function rateText(bytesPerSecond: number): string {
    return bytesPerSecond < 1000 ? `${Math.round(bytesPerSecond)} B/s` : bytesPerSecond < 1e6 ? `${Math.round(bytesPerSecond / 1000)} KB/s` : `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`
}

/** The link chip, always shown: live throughput and latency ("240 KB/s · 89 ms"), coloured by linkProblem; lost or connecting says so instead. */
export function linkChip(connection: Pick<ConnectionState, "state" | "rttMs" | "droppedPerSecond" | "error" | "throughputBytesPerSec">, latencyMs: number | null): { text: string; tone: Tone; detail: string } {
    const problem = linkProblem(connection)
    if (connection.state === "lost" || connection.state === "connecting") {
        return problem!
    }
    const rate = connection.throughputBytesPerSec === null ? "— B/s" : rateText(connection.throughputBytesPerSec)
    const latency = latencyMs === null ? "— ms" : `${Math.round(latencyMs)} ms`
    return { text: `${rate} · ${latency}`, tone: problem?.tone ?? "ok", detail: `${problem?.detail ?? "Link healthy"}. Throughput reaching this page and the control link's round trip` }
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
