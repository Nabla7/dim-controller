// The TF tree's frames (to offer for following), read once a second while `enabled`; the same array while unchanged.
import { useEffect, useState } from "react"
import type { ViewerApp } from "../core/app.ts"

export function useTfFrames(app: ViewerApp, enabled = true): string[] {
    const [frames, setFrames] = useState<string[]>([])
    useEffect(() => {
        if (!enabled) {
            return
        }
        const read = () => {
            const next = app.tf.snapshot(app.viewer.fixedFrame).frames
            setFrames((old) => old.length === next.length && old.every((frame, index) => frame === next[index]) ? old : next)
        }
        read()
        const timer = setInterval(read, 1000)
        return () => clearInterval(timer)
    }, [app, enabled])
    return frames
}
