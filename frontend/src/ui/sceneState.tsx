// What the 3D view knows that the rest of the page shows: its render numbers (the top bar, Status) and the TF tree's
// issues (the top bar's badge, the footnote, the TF tab, Status).
import { useEffect, useState } from "react"
import { useTfIssues as libraryUseTfIssues } from "dimos-react/three"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"

export interface SceneStats {
    fps: number
    frameMs: number
    latencyP50: number | null
    latencyP95: number | null
    arrivalToFrameMs: number | null
    drawCalls: number
    points: number
}

const NO_STATS: SceneStats = { fps: 0, frameMs: 0, latencyP50: null, latencyP95: null, arrivalToFrameMs: null, drawCalls: 0, points: 0 }

/** The mounted 3D view's render numbers (zeros while it isn't mounted). */
export function useSceneStats(app: ControllerApp): SceneStats {
    const { ready } = useStore(app.sceneReady)
    const [stats, setStats] = useState<SceneStats>(NO_STATS)
    useEffect(() => {
        const store = ready ? app.scene?.viewer?.stats : null
        if (!store) {
            setStats(NO_STATS)
            return
        }
        const read = () => setStats({ ...NO_STATS, ...store.get() })
        read()
        return store.subscribe(read)
    }, [app, ready])
    return stats
}

// deno-lint-ignore no-explicit-any
export type TfIssue = { kind: string; summary: string; detail: string; frames: string[] } & Record<string, any>

/** Checks the TF tree every 2 s (a problem shows once two checks in a row see it) into app.tfIssues; mount once. */
export function TfIssuesWatch({ app }: { app: ControllerApp }) {
    useStore(app.layers.entries)
    const issues: TfIssue[] = libraryUseTfIssues({ layers: app.layers.layerFrames(), tf: app.tf, fixedFrame: app.fixedFrame })
    useEffect(() => {
        if (JSON.stringify(issues) !== JSON.stringify(app.tfIssues.get().issues)) {
            app.tfIssues.set({ issues })
        }
    }, [app, issues])
    return null
}

export function useTfIssues(app: ControllerApp): TfIssue[] {
    return useStore(app.tfIssues).issues
}
