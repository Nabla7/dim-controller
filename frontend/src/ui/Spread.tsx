// A latency spread as every view shows it: "(spike 179)" muted, then the typical "20" on the right (p50; the spike is p95, the slowest 1 in 20 frames).
import type { LatencySpread } from "../core/videoLatency.ts"
import { spreadParts } from "../core/videoLatency.ts"

export function Spread({ spread, parts = spreadParts(spread) }: { spread?: LatencySpread | null; parts?: { typical: string; spike: string | null } }) {
    return <>{parts.spike && <span className="spread-spike">({parts.spike}) </span>}{parts.typical}</>
}
