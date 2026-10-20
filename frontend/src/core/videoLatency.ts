// Video latency, source to screen (zenoh-gateway >= 0.5.21): the client times each frame a camera panel's <video> shows
// (Subscription.watchVideoLatency) against the gateway's per-frame times, and the gateway reports its own stages per
// stream (stats videoLatency, with the RTP pacer's delay). An older gateway sends neither: everything here is null and
// the chip and Network panel show nothing or "—". Pure (no DOM): tested in test/videoLatency.test.ts.
import type { LatencySpread, VideoLatency } from "../vendor/zenoh-gateway/zenoh_gateway.ts"

export type { LatencySpread, VideoLatency }

/** what the chip and the Network panel summarize: the frames shown in the last few seconds */
export const VIDEO_LATENCY_WINDOW_MS = 5000

/** One video stream's stages inside the gateway (its stats' videoLatency), ms; the pacer's are null until it measured. */
export interface GatewayVideoLatency {
    sourceToReceivedMs: number
    receivedToEncodedMs: number
    encodedToWrittenMs: number
    pacerP50Ms: number | null
    pacerP95Ms: number | null
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/** A subscription's gateway stats → its video stages; null from a gateway before 0.5.21 or a stream that isn't video. */
export function gatewayVideoLatency(stats: Record<string, unknown> | null | undefined): GatewayVideoLatency | null {
    const latency = stats?.videoLatency as Record<string, unknown> | null | undefined
    if (!latency || typeof latency !== "object" || !finite(latency.sourceToReceivedMs)) {
        return null
    }
    const or0 = (value: unknown) => finite(value) ? value : 0
    const orNull = (value: unknown) => finite(value) ? value : null
    return {
        sourceToReceivedMs: latency.sourceToReceivedMs,
        receivedToEncodedMs: or0(latency.receivedToEncodedMs),
        encodedToWrittenMs: or0(latency.encodedToWrittenMs),
        pacerP50Ms: orNull(latency.pacerP50Ms),
        pacerP95Ms: orNull(latency.pacerP95Ms),
    }
}

/** The slowest of several cameras (by p50): the one the chip warns about; null when none measured. */
export function slowestVideo(latencies: (VideoLatency | null | undefined)[]): VideoLatency | null {
    let slowest: VideoLatency | null = null
    for (const latency of latencies) {
        if (latency && (!slowest || latency.total.p50 > slowest.total.p50)) {
            slowest = latency
        }
    }
    return slowest
}

const ms = (value: number) => String(Math.max(0, Math.round(value)))

/**
 * A spread as shown: the typical value (p50) and its spike (p95, the slowest 1 in 20 frames), "20" and "spike 179";
 * "—" and no spike without a measurement.
 */
export function spreadParts(spread: LatencySpread | null | undefined): { typical: string; spike: string | null } {
    return spread ? { typical: ms(spread.p50), spike: `spike ${ms(spread.p95)}` } : { typical: "—", spike: null }
}

/** A spread in plain text, "20 ms (spike 179)", or "—" without a measurement (titles and tests). */
export function spreadText(spread: LatencySpread | null | undefined): string {
    const { typical, spike } = spreadParts(spread)
    return spike ? `${typical} ms (${spike})` : typical
}

/** The chip's part: the slowest camera's typical and spike ms; null (nothing shown) before any frame was measured or on an older gateway. */
export function videoChipText(latency: VideoLatency | null): { typical: string; spike: string | null } | null {
    return latency ? spreadParts(latency.total) : null
}

/** One row of a camera's latency details: its typical ms (`value`), the spike beside it when it has one, and what it measures. */
export interface LatencyStage {
    name: string
    value: string
    spike: string | null
    detail: string
}

const spreadRow = (spread: LatencySpread | null | undefined) => {
    const { typical, spike } = spreadParts(spread)
    return { value: typical, spike }
}

/** The rows of a camera's latency details (Network → Bandwidth Consumers), each typical (p50) with its spike (p95) ms, or one number. */
export function latencyStages(latency: VideoLatency | null, gateway: GatewayVideoLatency | null): LatencyStage[] {
    const rows: LatencyStage[] = []
    if (latency) {
        const { stages } = latency
        rows.push({ name: "source → screen", ...spreadRow(latency.total), detail: `${latency.frames} frames measured in the last ${VIDEO_LATENCY_WINDOW_MS / 1000} s${latency.unmatched ? `, ${latency.unmatched} shown frames unmatched` : ""}` })
        rows.push({ name: "to the gateway", ...spreadRow(stages.toGateway), detail: "the sample's timestamp to the gateway getting it (zenoh, and the robot's clock against the gateway's)" })
        rows.push({ name: "encoding", ...spreadRow(stages.encoding), detail: "queued, decoded, scaled and encoded in the gateway" })
        rows.push({ name: "to the track", ...spreadRow(stages.toTrack), detail: "waiting to be written to the video track" })
        rows.push({ name: "track → screen", ...spreadRow(stages.trackToShown), detail: "RTP pacer, network, jitter buffer and decode, to the frame on screen" })
        if (stages.toReceived) {
            rows.push({ name: "· to this browser", ...spreadRow(stages.toReceived), detail: "track to the frame received (pacer and network)" })
        }
        if (stages.receivedToShown) {
            rows.push({ name: "· received → shown", ...spreadRow(stages.receivedToShown), detail: "jitter buffer and decode" })
        }
        if (latency.captureToShown) {
            rows.push({ name: "check: in-packet stamp", ...spreadRow(latency.captureToShown), detail: "source → screen from the timestamp in the frame's own RTP packets; should match the first row" })
        }
    }
    if (gateway) {
        rows.push({ name: "gateway: RTP pacer", ...spreadRow(gateway.pacerP50Ms === null ? null : { p50: gateway.pacerP50Ms, p95: gateway.pacerP95Ms ?? gateway.pacerP50Ms }), detail: "first packet into the gateway's RTP pacer to the last out (its latest 128 frames)" })
        rows.push({ name: "gateway: stages", value: `${ms(gateway.sourceToReceivedMs)} · ${ms(gateway.receivedToEncodedMs)} · ${ms(gateway.encodedToWrittenMs)}`, spike: null, detail: "the gateway's own smoothed to-gateway · encoding · to-track, ms" })
    }
    return rows
}
