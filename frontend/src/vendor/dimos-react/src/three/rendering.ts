// Rendering choices for every point layer: the default point style (a layer can pick its own), cube shading, and the
// automatic fallback that draws splats as cubes when they can't keep up.
import { localStore, Store } from "./store.ts"
import type { CubeShade, PointLook, PointStyle } from "./point_material.ts"
import type { EditablePointLook } from "./look_editor.tsx"

export interface RenderingDefaults {
    pointStyle: PointStyle
    cubeShade: CubeShade
    /** meters (PointLook.nearShrink) for every layer whose look doesn't set it; null = the app's default */
    nearShrink: number | null
}

/** The page-wide defaults (saved per viewer). A layer whose look says style "default" follows `pointStyle`. */
export const rendering = localStore<RenderingDefaults>("dimos-react.rendering", {
    pointStyle: "voxel",
    cubeShade: "soft",
    nearShrink: null,
})

/** What an app picks for the fields a viewer left on default (setRenderingDefaults); never saved. */
export const appRendering = new Store<{ nearShrink: number }>({ nearShrink: 0 })

/**
 * An app's own rendering defaults, e.g. `setRenderingDefaults({ nearShrink: 1.5 })` to see through walls the camera
 * is next to. A viewer's choice in Settings → Rendering still wins.
 */
export function setRenderingDefaults(defaults: Partial<{ nearShrink: number }>) {
    appRendering.update(defaults)
}

/** The near-shrink distance in effect: the viewer's choice, else the app's. */
export function resolveNearShrink(): number {
    return rendering.get().nearShrink ?? appRendering.get().nearShrink
}

/** Set while splats are drawn as cubes because frames took longer than FRAME_BUDGET_MS for 3 s (the Viewer sets it). */
export const splatFallback = new Store({ active: false, frameMs: 0 })

export const FRAME_BUDGET_MS = 16

/**
 * The style a layer draws with: its own, else the page default, with the fallback applied. A name that isn't a
 * POINT_STYLES key passes through (applyLook draws it as "disc").
 */
export function resolveStyle(style?: string | null): PointStyle {
    const chosen = !style || style === "default" ? rendering.get().pointStyle : (style as PointStyle)
    return chosen === "splat" && splatFallback.get().active ? "voxel" : chosen
}

/** A look with "default" style and the page's cube shading resolved, ready for applyLook. */
export function resolveLook(look: EditablePointLook): PointLook {
    return {
        ...look,
        style: resolveStyle(look.style),
        cubeShade: look.cubeShade ?? rendering.get().cubeShade,
        nearShrink: look.nearShrink ?? resolveNearShrink(),
    }
}
