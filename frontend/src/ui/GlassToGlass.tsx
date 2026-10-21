// The Network modal's glass-to-glass test (core/glassToGlass.ts): a moving QR code to hold up to a robot camera, and
// each camera's latency from the code being drawn here to its frame being on this screen.
import { useEffect, useRef, useState } from "react"
import { Button } from "dimos-react"
import { type CameraResult, holdMs, quantile, showCode, watchCameras } from "../core/glassToGlass.ts"
import { panelTitle } from "./commands.ts"
import type { ViewerApp } from "../core/app.ts"

const CODE_PX = 260

export function GlassToGlass({ app, onClose }: { app: ViewerApp; onClose: () => void }) {
    const canvas = useRef<HTMLCanvasElement>(null)
    const [results, setResults] = useState<CameraResult[]>([])
    useEffect(() => {
        const element = canvas.current!
        // opened at the bottom of the modal: bring the code into view
        element.scrollIntoView({ block: "center", behavior: "smooth" })
        // a crisp code on a high-DPI screen: the canvas at device pixels
        element.width = element.height = Math.round(CODE_PX * devicePixelRatio)
        // the gateway's clock (this page's plus its sync offset), so a code shown here can be read by any other viewer
        const client = app.connection.client
        const offset = () => client?.clockOffsetMs ?? 0
        const stopCode = showCode(element, () => (client ? client.now() : performance.timeOrigin + performance.now()) + offset())
        const stopWatch = watchCameras(setResults, (performanceMs) => performance.timeOrigin + performanceMs + offset())
        return () => {
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
            <canvas ref={canvas} className="g2g-code" style={{ width: CODE_PX, height: CODE_PX }} aria-label="Glass-to-glass test code" />
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
                p95). Each code stays up for two of the camera's frames ({Math.round(holdMs())} ms), so a reading runs up to one
                camera frame high; best is the closest. The camera needs to be streaming in a panel.
            </p>
            <Button onClick={onClose}>Stop</Button>
        </section>
    )
}
