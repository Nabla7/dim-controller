// The Network modal's glass-to-glass test (core/glassToGlass.ts): a moving QR code to hold up to a robot camera, and
// each camera's latency from the code being drawn here to its frame being on this screen.
import { useEffect, useRef, useState } from "react"
import { Button } from "dimos-react"
import { type CameraResult, quantile, showCode, watchCameras } from "../core/glassToGlass.ts"
import { panelTitle } from "./commands.ts"

const CODE_PX = 260

export function GlassToGlass({ onClose }: { onClose: () => void }) {
    const canvas = useRef<HTMLCanvasElement>(null)
    const [results, setResults] = useState<CameraResult[]>([])
    useEffect(() => {
        const element = canvas.current!
        // opened at the bottom of the modal: bring the code into view
        element.scrollIntoView({ block: "center", behavior: "smooth" })
        // a crisp code on a high-DPI screen: the canvas at device pixels
        element.width = element.height = Math.round(CODE_PX * devicePixelRatio)
        const stopCode = showCode(element)
        const stopWatch = watchCameras(setResults)
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
                            {results.map((result) => (
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
                p95). The camera needs to be streaming in a panel; up to one screen refresh (~17 ms) is this screen's own.
            </p>
            <Button onClick={onClose}>Stop</Button>
        </section>
    )
}
