// What this viewer alone remembers (localStorage, not the backend's shared settings): panel boxes, the 3D view's off
// switch. A phone and a desktop don't share these.
import { Store } from "./settings.ts"

/** localStorage JSON, or the fallback (private windows, blocked storage and tests throw or return nothing). */
export function readLocal<T>(key: string, fallback: T): T {
    try {
        const raw = globalThis.localStorage?.getItem(key)
        return raw ? JSON.parse(raw) as T : fallback
    } catch {
        return fallback
    }
}

export function writeLocal(key: string, value: unknown) {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value))
    } catch {
        // storage unavailable: the choice lasts for this page only
    }
}

const PANEL_KEY = "lv.scene"

/** The 3D view's panel, per viewer: off (nothing subscribed), and where the picture-in-picture sits (-1: its corner). */
export interface ScenePanelState {
    off: boolean
    x: number
    y: number
    width: number
    height: number
}

export const scenePanel = new Store<ScenePanelState>({ off: false, x: -1, y: -1, width: -1, height: -1, ...readLocal<Partial<ScenePanelState>>(PANEL_KEY, {}) })

export function updateScenePanel(patch: Partial<ScenePanelState>) {
    scenePanel.update(patch)
    writeLocal(PANEL_KEY, scenePanel.get())
}
