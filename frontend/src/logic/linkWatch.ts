// Holds driving when the control link is too slow (latency over Settings → Max latency) or gone, and lets it go again:
// a latency hold waits for the Reconnect button, a lost link's hold ends when the link is back (it reconnected).
import type { DriveHalt } from "./drive.ts"
import type { ConnectionState } from "./connection.ts"

export const DEFAULT_MAX_LATENCY_MS = 1000
/** how often the link is checked */
export const LINK_CHECK_MS = 100

export type LinkAction = { halt: Omit<DriveHalt, "reconnecting"> } | { resume: true } | null

/** What to do with driving given the link now and the current hold. */
export function checkLink(
    { state, latencyMs, maxMs, halt, hidden = false }: { state: ConnectionState["state"]; latencyMs: number | null; maxMs: number; halt: DriveHalt | null; hidden?: boolean },
): LinkAction {
    if (halt?.reconnecting) {
        return null
    }
    if (state === "lost") {
        return halt?.reason === "lost" ? null : { halt: { reason: "lost", latencyMs: null, maxMs } }
    }
    if (halt?.reason === "lost") {
        return state === "connected" ? { resume: true } : null
    }
    // a hidden tab's timers run at ~1 Hz, so its heartbeat looks stalled; it can't drive anyway (hiding stops)
    if (!halt && !hidden && state !== "connecting" && latencyMs !== null && maxMs > 0 && latencyMs > maxMs) {
        return { halt: { reason: "latency", latencyMs: Math.round(latencyMs), maxMs } }
    }
    return null
}

/** Settings' max latency (ms), or the default for a missing or nonsense value. */
export function maxLatencyOf(value: unknown): number {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : DEFAULT_MAX_LATENCY_MS
}
