// The one bar's status chips (ui/barStatus.ts says when and what): the link's live throughput and latency (coloured
// when it's a problem), TF and render warnings (each opens what fixes it), and the gamepad's state. A phone shows the
// same chips over the top of the main view.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { splatFallback } from "../core/render/rendering.ts"
import { useEffect, useRef, useState } from "react"
import { gamepadChip, leaseChip, LINK_REDRAW_MS, LINK_SAMPLE_MS, linkChip, phoneChipText, smoothed } from "./barStatus.ts"
import { Modal } from "dimos-react"
import { Icon } from "./icons.tsx"
import { NetworkPanel } from "./NetworkPanel.tsx"
import { gamepadStatus } from "./useGamepad.ts"
import type { WorkspaceApi } from "./Workspace.tsx"
import { batteryChip, batteryReadings } from "../core/batteryFeed.ts"
import { slowestVideo, type VideoLatency } from "../core/videoLatency.ts"

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
        <span className={`bar-chip bar-battery battery-${chip.tone}`} title={chip.detail} data-testid="bar-battery" aria-label={`Battery ${chip.text}${chip.charging ? ", charging" : ""}`}>
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
    const link = linkChip({ ...connection, throughputBytesPerSec: average.rate }, average.latency, average.video)
    const lease = leaseChip(useStore(app.connection.lease.state), api.mobile)
    return (
        <>
            {lease && (
                <button type="button" className={`bar-chip tone-${lease.tone} bar-button bar-lease`} title={lease.detail} data-testid="bar-lease" onClick={() => void app.connection.takeBack()}>
                    <Icon name="warn" size={13} />
                    <span className="bar-value">{lease.text}</span>
                </button>
            )}
            <button type="button" className={`bar-chip tone-${link.tone} bar-button bar-link`} title={`${link.detail} (open Network: history and who's using the link)`} data-testid="bar-link" onClick={() => setNetworkOpen(true)}>
                <span className="bar-dot" />
                {api.mobile ? (
                    // a phone: unpadded, the video latency on a second line, so both fit between the corners
                    <span className="bar-link-lines">
                        <span className="bar-value">{phoneChipText(link.text)}</span>
                        {link.video && <span className="bar-value bar-video" data-testid="bar-video">{link.video}</span>}
                    </span>
                ) : (
                    <>
                        <span className="bar-value">{link.text}</span>
                        {link.video && <span className="bar-value bar-video" data-testid="bar-video">· {link.video}</span>}
                    </>
                )}
            </button>
            <Modal open={networkOpen} onClose={() => setNetworkOpen(false)} title="Network" size="lg" data-testid="network-modal">
                {networkOpen && <NetworkPanel app={app} onStatus={() => {
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
            {pad && (
                <span className={`bar-chip tone-${pad.tone} bar-gamepad`} title={`Gamepad · ${pad.detail}`} data-testid="bar-gamepad">
                    <Icon name="gamepad" size={14} />
                    <span className="bar-value">{pad.text}</span>
                </span>
            )}
        </>
    )
}
