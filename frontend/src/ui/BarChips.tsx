// The one bar's status chips (ui/barStatus.ts says when and what): the link's live throughput and latency (coloured
// when it's a problem; quiet, low contrast, when it isn't), TF and render warnings (each opens what fixes it), the
// battery (quiet when it's fine), the robot computer's CPU (only when it's really high) and the gamepad's state. A
// phone shows the same chips in a row under its top buttons.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { splatFallback } from "../core/render/rendering.ts"
import { useEffect, useRef, useState } from "react"
import { gamepadChip, leaseChip, LINK_REDRAW_MS, LINK_SAMPLE_MS, linkChip, smoothed } from "./barStatus.ts"
import { Modal } from "dimos-react"
import { Icon } from "./icons.tsx"
import { NetworkPanel } from "./NetworkPanel.tsx"
import { glassWindow } from "./GlassToGlass.tsx"
import { gamepadStatus } from "./useGamepad.ts"
import type { WorkspaceApi } from "./Workspace.tsx"
import { batteryChip, batteryReadings } from "../core/batteryFeed.ts"
import { slowestVideo, type VideoLatency } from "../core/videoLatency.ts"
import { maxLatencyOf } from "../core/linkWatch.ts"
import { timingWarnings } from "../core/policyControl.ts"

/** The robot's battery (every BatteryState topic; core/batteryFeed.ts), Go2-app style: the outline filled to the charge, a bolt while charging. */
function BatteryChip() {
    const { readings } = useStore(batteryReadings)
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [])
    const chip = batteryChip(readings, now)
    if (!chip) {
        return null
    }
    const fill = chip.percent === null ? 0 : (Math.max(chip.percent, 4) / 100) * 15
    return (
        <span className={`bar-chip bar-battery battery-${chip.tone} ${chip.tone === "ok" ? "quiet" : ""}`} title={chip.detail} data-testid="bar-battery" aria-label={`Battery ${chip.text}${chip.charging ? ", charging" : ""}`}>
            <svg className="battery-icon" width="24" height="13" viewBox="0 0 24 13" aria-hidden="true">
                <rect x="0.75" y="0.75" width="19.5" height="11.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <rect x="21" y="4" width="2.25" height="5" rx="1" fill="currentColor" />
                <rect className="battery-fill" x="3" y="3" width={fill} height="7" rx="1" />
                {chip.charging && <path className="battery-bolt" d="M11.5 1.5 7.5 7h3l-1 4.5 4-5.5h-3z" />}
            </svg>
            <span className="bar-value">{chip.text}</span>
        </span>
    )
}

/** CPU busy at or over this (percent of all cores) shows the CPU chip */
export const CPU_HIGH_PERCENT = 90
/** how often the page asks for the backend's sample (api/host; the backend samples every 5 s) */
const CPU_POLL_MS = 5000

/** The robot computer's CPU (api/host, sampled by the backend): only while it's really high. */
function CpuChip() {
    const [busy, setBusy] = useState<{ percent: number; cores: number } | null>(null)
    useEffect(() => {
        let alive = true
        const poll = async () => {
            try {
                const { cpu } = await (await fetch(new URL("api/host", location.href))).json()
                if (alive) {
                    setBusy(cpu ? { percent: cpu.busyPercent, cores: cpu.cores } : null)
                }
            } catch {
                // an older backend (no api/host) or a blip: no chip
            }
        }
        poll()
        const timer = setInterval(poll, CPU_POLL_MS)
        return () => {
            alive = false
            clearInterval(timer)
        }
    }, [])
    if (!busy || busy.percent < CPU_HIGH_PERCENT) {
        return null
    }
    return (
        <span className={`bar-chip tone-${busy.percent >= 98 ? "bad" : "warn"} bar-cpu`} title={`The robot's computer: ${Math.round(busy.percent)}% of its ${busy.cores} cores busy (sampled every 5 s)`} data-testid="bar-cpu">
            <span className="bar-value">CPU {Math.round(busy.percent)}%</span>
        </span>
    )
}

/** The link's throughput and latency averaged over a few seconds and redrawn once a second, so the chip is readable; driving's latency gate still uses the raw round trip. */
function useSmoothedLink(app: ViewerApp): { rate: number | null; latency: number | null; video: VideoLatency | null } {
    const average = useRef<{ rate: number | null; latency: number | null }>({ rate: null, latency: null })
    const [shown, setShown] = useState<{ rate: number | null; latency: number | null; video: VideoLatency | null }>({ ...average.current, video: null })
    useEffect(() => {
        const sample = setInterval(() => {
            const { rate, latency } = average.current
            average.current = {
                rate: smoothed(rate, app.connection.status.get().throughputBytesPerSec, LINK_SAMPLE_MS),
                latency: smoothed(latency, app.connection.latencyMs(), LINK_SAMPLE_MS),
            }
        }, LINK_SAMPLE_MS)
        // the video's is already over its last few seconds of frames
        const redraw = setInterval(() => setShown({ ...average.current, video: slowestVideo(Object.values(app.video.latencies())) }), LINK_REDRAW_MS)
        return () => {
            clearInterval(sample)
            clearInterval(redraw)
        }
    }, [app])
    return shown
}

export function BarChips({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    const [networkOpen, setNetworkOpen] = useState(false)
    const connection = useStore(app.connection.status)
    const { issues: tfIssues } = useStore(app.tfIssues)
    const fallback = useStore(splatFallback)
    const pad = gamepadChip(useStore(gamepadStatus))
    const average = useSmoothedLink(app)
    const link = linkChip({ ...connection, throughputBytesPerSec: average.rate }, average.latency, average.video, maxLatencyOf(useStore(app.settings).maxLatencyMs))
    const lease = leaseChip(useStore(app.connection.lease.state), api.mobile)
    const policy = useStore(app.policy.state)
    const controlWarnings = policy.required ? timingWarnings(policy) : []
    return (
        <>
            {policy.required && <button type="button" className={`bar-chip bar-button tone-${policy.stale || policy.status?.fault_reason ? "bad" : controlWarnings.length ? "warn" : "ok"}`}
                title={controlWarnings.length ? controlWarnings.join("\n") : "Control timing measurements"} data-testid="bar-control-timing" onClick={() => api.act("sonic", "show")}>
                <Icon name={controlWarnings.length ? "warn" : "humanoid"} size={13} />
                <span className="bar-value">{policy.stale ? "Control stale" : controlWarnings.length ? "Control timing" : "Control"}</span>
            </button>}
            {lease && (
                <button type="button" className={`bar-chip tone-${lease.tone} bar-button bar-lease`} title={lease.detail} data-testid="bar-lease" onClick={() => void app.connection.takeBack()}>
                    <Icon name="warn" size={13} />
                    <span className="bar-value">{lease.text}</span>
                </button>
            )}
            <button type="button" className={`bar-chip tone-${link.tone} bar-button bar-link ${link.tone === "ok" ? "quiet" : ""}`} title={`${link.detail} (open Network: history and who's using the link)`} data-testid="bar-link" onClick={() => setNetworkOpen(true)}>
                <span className="bar-dot" />
                {/* fixed-width number slots in a fixed-width box, so neither this chip nor its neighbours move as the numbers change */}
                <span className="bar-value bar-link-value">
                    {link.numbers ? <><span className="bar-num bar-num-rate">{link.numbers.rate}</span><span className="bar-unit">Mbps</span><span className="bar-sep">·</span><span className="bar-num bar-num-ms">{link.numbers.ms}</span><span className="bar-unit">ms</span></> : link.text}
                </span>
            </button>
            <Modal open={networkOpen} onClose={() => setNetworkOpen(false)} title="Network" size="lg" data-testid="network-modal">
                {networkOpen && <NetworkPanel app={app} onGlass={() => {
                    setNetworkOpen(false)
                    glassWindow.set({ open: true })
                }} onStatus={() => {
                    setNetworkOpen(false)
                    api.act("status", "show")
                }} />}
            </Modal>
            {tfIssues.length > 0 && (
                <button type="button" className="bar-chip tone-warn bar-button" title={`TF: ${tfIssues[0].summary} (open the TF panel)`} data-testid="bar-tf" onClick={() => api.act("tf", "show")}>
                    <Icon name="warn" size={13} />
                    <span className="bar-value">TF {tfIssues.length}</span>
                </button>
            )}
            {fallback.active && !api.mobile && (
                <button type="button" className="bar-chip tone-warn bar-button" title={`splat frames took ${fallback.frameMs.toFixed(0)} ms (over 16 ms): drawing cubes instead. Click to try splats again.`} onClick={() => splatFallback.set({ active: false, frameMs: 0 })}>
                    <span className="bar-value">splats → cubes</span>
                </button>
            )}
            <BatteryChip />
            <CpuChip />
            {pad && (
                <span className={`bar-chip tone-${pad.tone} bar-gamepad`} title={`Gamepad · ${pad.detail}`} data-testid="bar-gamepad">
                    <Icon name="gamepad" size={14} />
                    <span className="bar-value">{pad.text}</span>
                </span>
            )}
        </>
    )
}
