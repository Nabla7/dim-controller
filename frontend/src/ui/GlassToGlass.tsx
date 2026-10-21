// The glass-to-glass test (core/glassToGlass.ts), opened from the Network modal into its own window over the view (the
// modal closes, so the camera shows): a moving QR code to hold up to a robot camera, and each camera's latency from the
// code being drawn here to its frame being on this screen. The window drags by its header.
import { useEffect, useRef, useState } from "react"
import { Store, useStore } from "../core/store.ts"
import { startPointerDrag } from "./panelDrag.ts"
import { Button } from "dimos-react"
import { type CameraResult, holdMs, quantile, showCode, watchCameras } from "../core/glassToGlass.ts"
import { panelTitle } from "./commands.ts"
import type { ViewerApp } from "../core/app.ts"

const CODE_PX = 220

/** the test's window: open or not (the Network modal opens it) */
export const glassWindow = new Store<{ open: boolean }>({ open: false })

/** The test in a window that floats over the view and drags by its header (kept on screen). */
export function GlassWindow({ app }: { app: ViewerApp }) {
    const { open } = useStore(glassWindow)
    const [at, setAt] = useState({ x: 16, y: 72 })
    const [width, setWidth] = useState(300)
    if (!open) {
        return null
    }
    const keepOnScreen = (x: number, y: number) => ({ x: Math.max(0, Math.min(innerWidth - 120, x)), y: Math.max(0, Math.min(innerHeight - 40, y)) })
    return (
        <div className="g2g-window" style={{ left: at.x, top: at.y, width }} data-testid="glass-window">
            <header
                className="g2g-window-head"
                onPointerDown={(event) => {
                    if ((event.target as HTMLElement).closest("button")) {
                        return
                    }
                    const start = at
                    startPointerDrag(event, (dx, dy) => setAt(keepOnScreen(start.x + dx, start.y + dy)))
                }}
            >
                <span>Glass-to-glass</span>
                <button type="button" className="net-icon-button" aria-label="Close the glass-to-glass test" onClick={() => glassWindow.set({ open: false })}>×</button>
            </header>
            <GlassToGlass app={app} onClose={() => glassWindow.set({ open: false })} />
            <div
                className="g2g-window-resize"
                title="Drag to resize"
                aria-label="Resize"
                onPointerDown={(event) => {
                    event.preventDefault()
                    const start = width
                    startPointerDrag(event, (dx) => setWidth(Math.max(200, Math.min(innerWidth - at.x - 4, start + dx))))
                }}
            />
        </div>
    )
}

export function GlassToGlass({ app, onClose }: { app: ViewerApp; onClose: () => void }) {
    const canvas = useRef<HTMLCanvasElement>(null)
    const [results, setResults] = useState<CameraResult[]>([])
    useEffect(() => {
        const element = canvas.current!
        // a crisp code on a high-DPI screen: the canvas at device pixels, following its shown size (the window resizes)
        const fit = () => {
            const size = Math.round((element.clientWidth || CODE_PX) * devicePixelRatio)
            if (element.width !== size) {
                element.width = element.height = size
            }
        }
        fit()
        const sized = new ResizeObserver(fit)
        sized.observe(element)
        // the gateway's clock (this page's plus its sync offset), so a code shown here can be read by any other viewer
        const client = app.connection.client
        const offset = () => client?.clockOffsetMs ?? 0
        const stopCode = showCode(element, () => (client ? client.now() : performance.timeOrigin + performance.now()) + offset())
        const stopWatch = watchCameras(setResults, (performanceMs) => performance.timeOrigin + performanceMs + offset())
        return () => {
            sized.disconnect()
            stopCode()
            stopWatch()
        }
    }, [])
    return (
        <section className="g2g" data-testid="glass-to-glass">
            <p className="g2g-intro">
                Show this to a camera on the controller to get a{" "}
                <a href="https://bloggeek.me/webrtcglossary/glass-to-glass/" target="_blank" rel="noreferrer">glass-to-glass</a>{" "}
                latency test.
            </p>
            <canvas ref={canvas} className="g2g-code" aria-label="Glass-to-glass test code" />
            {results.length === 0
                ? <p className="g2g-status dim">Looking for the code in the camera views…</p>
                : (
                    <table className="g2g-table">
                        <thead>
                            <tr><th>Camera</th><th>typical</th><th>spike</th><th>best</th><th>frames</th></tr>
                        </thead>
                        <tbody>
                            {results.map((result) => result.unreadable && !result.samples.length
                                ? (
                                    <tr key={result.panel} data-testid="g2g-row">
                                        <td>{panelTitle(result.panel)}</td>
                                        <td colSpan={4} className="g2g-unreadable">
                                            this browser won't let the page read its video (Firefox on Android:{" "}
                                            <a href="https://bugzilla.mozilla.org/show_bug.cgi?id=1479947" target="_blank" rel="noreferrer">bug 1479947</a>):
                                            show the code here and read it in another viewer, or use Chrome
                                        </td>
                                    </tr>
                                )
                                : (
                                    <tr key={result.panel} data-testid="g2g-row">
                                        <td>{panelTitle(result.panel)}</td>
                                        <td>{Math.round(quantile(result.samples, 0.5))} ms</td>
                                        <td>{Math.round(quantile(result.samples, 0.95))} ms</td>
                                        <td>{Math.round(Math.min(...result.samples))} ms</td>
                                        <td>{result.samples.length}</td>
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                )}
            <p className="g2g-note dim">
                From this page drawing the code to the camera's frame showing it reaching this screen (typical is the median, spike the
                p95). Typical is what you see: it includes waiting for the camera's next frame (a change in front of the robot waits the same), so a slow camera reads high; best is the luckiest frame. Each code stays up two camera frames ({Math.round(holdMs())} ms). The camera needs to be streaming in a panel.
            </p>
            <Button onClick={onClose}>Stop</Button>
        </section>
    )
}
