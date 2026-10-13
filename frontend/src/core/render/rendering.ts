// Rendering choices that apply to every point layer: the default point style (a layer can override it), cube shading, and the
// automatic fallback that swaps splats for cubes when they can't keep up. The materials themselves are dimos-react's.
import type * as THREE from "three"

import type { Viewer } from "dimos-react/three"
import { persistentStore, Store } from "../store.ts"

export type PointStyle = "voxel" | "splat" | "disc" | "square"
export type CubeShade = "soft" | "sky" | "outline" | "bevel" | "memworld"
export type ColorMode = "height" | "intensity" | "range" | "solid"

/** A point layer's look (its settings); "default" style follows Settings → Rendering. */
export interface PointLook {
    style: PointStyle | "default"
    /** meters: the point's diameter, or the voxel's edge */
    size: number
    colorMode: ColorMode
    gradient: string
    /** for "height": which axis of the fixed frame */
    axis: 0 | 1 | 2
    /** null = auto from the data */
    rangeMin: number | null
    rangeMax: number | null
    solid: string
    opacity: number
}

// v2: the default moved from glow to cubes, and a stored "glow" from before that shouldn't hide the new default
export const rendering = persistentStore<{ pointStyle: PointStyle; cubeShade: CubeShade }>("lv.rendering.v2", { pointStyle: "voxel", cubeShade: "soft" })

/** Set while splats are being drawn as cubes because frames took longer than FRAME_BUDGET_MS for a while. */
export const splatFallback = new Store<{ active: boolean; frameMs: number }>({ active: false, frameMs: 0 })

/** The style a layer draws with: its own choice, else the global default, with the fallback applied. */
export function resolveStyle(style: PointStyle | "default"): PointStyle {
    const chosen = style === "default" ? rendering.get().pointStyle : style
    return chosen === "splat" && splatFallback.get().active ? "voxel" : chosen
}

/** The look dimos-react's applyLook takes: the style resolved, the global cube shading added. */
export function materialLook(look: PointLook) {
    return { ...look, style: resolveStyle(look.style), cubeShade: rendering.get().cubeShade }
}

export const FRAME_BUDGET_MS = 16

/** Splats that can't keep up for 3 s in a row are drawn as cubes instead (the top bar says so; clicking it retries). */
export function watchSplatBudget(viewer: Viewer) {
    let slowSeconds = 0
    viewer.stats.subscribe(() => {
        const fps = viewer.stats.get().fps
        const frameMs = fps > 0 ? 1000 / fps : 0
        let splats = false
        viewer.scene.traverseVisible((object) => {
            const material = (object as THREE.Points).isPoints ? ((object as THREE.Points).material as THREE.ShaderMaterial) : null
            splats ||= !!material && "SPLAT" in (material.defines ?? {})
        })
        slowSeconds = splats && frameMs > FRAME_BUDGET_MS * 1.25 ? slowSeconds + 1 : 0
        if (slowSeconds >= 3 && !splatFallback.get().active) {
            splatFallback.set({ active: true, frameMs })
        }
    })
}
