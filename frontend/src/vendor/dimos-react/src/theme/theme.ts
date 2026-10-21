// Desktop's theme, without React: which skin / corners Desktop saved, applying them to <html>, and following changes.
//
// Every value lives in dimOS Desktop: it serves every skin's tokens as /theme.css and saves the user's choice in
// localStorage ("portal.theme" / "portal.corners", Desktop's origin, which an app under /apps/<name>/ shares), so a
// change in Settings → Appearance is a `storage` event in every open app. Off Desktop the bundled copy of those tokens
// (tokens.js) stands in. Components (css.js) use only the tokens, so they follow every skin.
import { SKINS, TOKENS_CSS } from "./tokens.ts"
import { COMPONENT_CSS } from "./css.ts"

export { SKINS }

export const SKIN_KEY = "portal.theme"
export const CORNERS_KEY = "portal.corners"
export const DESKTOP_THEME_URL = "/theme.css"

/** Corners: "sharp", "rounded", or "theme" (the skin's own). */
export type Corners = "sharp" | "rounded" | "theme"

/** The theme's palette (themeColors()): CSS color strings, plus the mono / sans font stacks. */
export interface ThemeColors {
    bg: string
    surface: string
    raised: string
    card: string
    fg: string
    mutedFg: string
    border: string
    primary: string
    primaryFg: string
    ok: string
    warn: string
    danger: string
    info: string
    sceneBg: string
    sceneGrid: string
    sceneGridMajor: string
    /** a floor plan's floor, wall and wall-edge colors (optional tokens: "" when a skin leaves them out) */
    sceneFloor: string
    sceneWall: string
    sceneWallRim: string
    axisX: string
    axisY: string
    axisZ: string
    /** the four categorical colors */
    cat: string[]
    mono: string
    sans: string
}

/** What applyTheme put in effect. */
export interface AppliedTheme {
    skin: string
    corners: Corners
    dark: boolean
    square: boolean
}

function stored(key: string): string | null {
    try {
        return globalThis.localStorage?.getItem(key) ?? null
    } catch {
        return null
    }
}

/** Whether this page is one of Desktop's apps (served at /apps/<name>/, so Desktop's /theme.css is there). */
export function onDesktop(): boolean {
    return !!globalThis.location?.pathname?.startsWith("/apps/")
}

/** Desktop's saved skin id ("portal", "research", "vibeslop", …); "portal" when nothing is saved. */
export function desktopSkin(): string {
    return stored(SKIN_KEY) || "portal"
}

/** Desktop's corners setting: "sharp", "rounded", or "theme" (the skin's own). */
export function desktopCorners(): Corners {
    const value = stored(CORNERS_KEY)
    return value === "sharp" || value === "rounded" ? value : "theme"
}

/** Adds a <style> (once per id) holding `css`; returns it. */
function ensureStyle(id: string, css: string, { first = false }: { first?: boolean } = {}): HTMLStyleElement {
    let style = document.querySelector<HTMLStyleElement>(`style[data-dimos-react="${id}"]`)
    if (!style) {
        style = document.createElement("style")
        style.dataset.dimosReact = id
        if (first) {
            document.head.prepend(style)
        } else {
            document.head.append(style)
        }
    }
    if (style.textContent !== css) {
        style.textContent = css
    }
    return style
}

/**
 * Puts the theme's stylesheets in the page: Desktop's /theme.css (on Desktop, or `themeUrl`), else the bundled
 * tokens; then the components' CSS. Both go first in <head> so the app's own CSS still wins ties.
 * @returns resolves when the tokens are in effect
 */
export function installThemeCss({
    themeUrl = null,
    bundled,
}: { themeUrl?: string | null; bundled?: boolean } = {}): Promise<void> {
    if (typeof document === "undefined") {
        return Promise.resolve()
    }
    ensureStyle("components", COMPONENT_CSS, { first: true })
    const url = themeUrl ?? (onDesktop() ? DESKTOP_THEME_URL : null)
    const useBundled = bundled ?? !url
    if (useBundled) {
        ensureStyle("tokens", TOKENS_CSS, { first: true })
        return Promise.resolve()
    }
    if (!url) {
        // bundled: false off Desktop with no themeUrl: no tokens wanted and no sheet to link
        return Promise.resolve()
    }
    const existing = document.querySelector("link[data-dimos-react-theme]")
    if (existing && existing.getAttribute("href") === url) {
        return Promise.resolve()
    }
    existing?.remove()
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = url
    link.dataset.dimosReactTheme = ""
    const loaded = new Promise<void>((resolve) => {
        link.addEventListener("load", () => resolve(), { once: true })
        link.addEventListener(
            "error",
            () => {
                // Desktop's sheet unreachable: the bundled copy keeps the page themed
                ensureStyle("tokens", TOKENS_CSS, { first: true })
                resolve()
            },
            { once: true },
        )
    })
    document.head.prepend(link)
    return loaded
}

/**
 * Sets html[data-skin], html[data-corners] (Desktop's /theme.css keys off both) and html[data-dr-dark] (the
 * components' dark structural rules), and returns what is in effect.
 */
export function applyTheme({
    skin = "portal",
    corners = "theme",
}: { skin?: string; corners?: Corners } = {}): AppliedTheme {
    const root = document.documentElement
    root.dataset.skin = skin
    if (corners === "theme") {
        delete root.dataset.corners
    } else {
        root.dataset.corners = corners
    }
    const style = getComputedStyle(root)
    const dark = !/light/.test(style.getPropertyValue("color-scheme") || style.colorScheme || "")
    root.toggleAttribute("data-dr-dark", dark)
    const square = /^0(px)?$/.test(style.getPropertyValue("--radius-lg").trim())
    root.toggleAttribute("data-dr-square", square)
    return { skin, corners, dark, square }
}

/** Calls `listener()` whenever Desktop saves a new skin or corners (in its own page or another tab). Returns unsubscribe. */
export function watchDesktopTheme(listener: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === SKIN_KEY || event.key === CORNERS_KEY) {
            listener()
        }
    }
    addEventListener("storage", onStorage)
    return () => removeEventListener("storage", onStorage)
}

/** The current palette, for canvases, charts and 3D scenes (read from the theme's variables). */
export function themeColors(): Partial<ThemeColors> {
    if (typeof document === "undefined") {
        return {}
    }
    const style = getComputedStyle(document.body ?? document.documentElement)
    const read = (name: string) => style.getPropertyValue(name).trim()
    return {
        bg: read("--bg"),
        surface: read("--surface"),
        raised: read("--raised"),
        card: read("--card"),
        fg: read("--fg"),
        mutedFg: read("--muted-fg"),
        border: read("--border"),
        primary: read("--primary"),
        primaryFg: read("--primary-fg"),
        ok: read("--ok"),
        warn: read("--warn"),
        danger: read("--danger"),
        info: read("--info"),
        sceneBg: read("--scene-bg"),
        sceneGrid: read("--scene-grid"),
        sceneGridMajor: read("--scene-grid-major"),
        sceneFloor: read("--scene-floor"),
        sceneWall: read("--scene-wall"),
        sceneWallRim: read("--scene-wall-rim"),
        axisX: read("--axis-x"),
        axisY: read("--axis-y"),
        axisZ: read("--axis-z"),
        cat: [read("--cat-1"), read("--cat-2"), read("--cat-3"), read("--cat-4")],
        mono: read("--mono"),
        sans: read("--sans"),
    }
}

/**
 * Tells Desktop (the page around an app's frame) that the app has painted in its theme, so the shell fades the frame
 * in now: `{type: "dimos-ready"}`, once, two frames later.
 */
let readySent = false
export function signalReady(): void {
    if (readySent || typeof window === "undefined" || window.parent === window) {
        return
    }
    readySent = true
    requestAnimationFrame(() =>
        requestAnimationFrame(() => {
            try {
                window.parent.postMessage({ type: "dimos-ready" }, location.origin)
            } catch {
                // not Desktop's origin
            }
        })
    )
}

const INSET_SIDES = ["top", "bottom", "left", "right"]
let insetsInstalled = false
/**
 * Keeps `--dim-inset-top/bottom/left/right` on :root current: how much of the page Desktop's shell covers (its dock),
 * from the shell's `{type: "dimos-inset"}` messages; 0 outside Desktop.
 */
export function installInsets(): void {
    if (insetsInstalled || typeof document === "undefined") {
        return
    }
    insetsInstalled = true
    const root = document.documentElement
    for (const side of INSET_SIDES) {
        if (!root.style.getPropertyValue(`--dim-inset-${side}`)) {
            root.style.setProperty(`--dim-inset-${side}`, "0px")
        }
    }
    addEventListener("message", (event) => {
        const data = event.data
        if (event.origin !== location.origin || data?.type !== "dimos-inset" || event.source !== window.parent) {
            return
        }
        for (const side of INSET_SIDES) {
            const value = Number(data[side])
            root.style.setProperty(`--dim-inset-${side}`, `${Number.isFinite(value) && value > 0 ? value : 0}px`)
        }
    })
    try {
        if (window.parent !== window) {
            window.parent.postMessage({ type: "dimos-inset-request" }, location.origin)
        }
    } catch {
        // no parent to ask
    }
}
