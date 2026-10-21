// <DimThemeProvider>: the app takes Desktop's current skin, light/dark mode and corners, and follows every change.
//
//     h(DimThemeProvider, null, h(App))                        // Desktop's choice, live
//     h(DimThemeProvider, { skin: "research" }, h(App))        // pinned (demos, screenshots)
//     const { skin, dark, corners, colors } = useTheme()
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import {
    applyTheme,
    desktopCorners,
    desktopSkin,
    installInsets,
    installThemeCss,
    signalReady,
    themeColors,
    watchDesktopTheme,
} from "./theme.ts"
import type { Corners, ThemeColors } from "./theme.ts"

const useIsoLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect

/** What useTheme() gives: the skin and corners in effect, what they look like, and per-page setters. */
export interface ThemeContextValue {
    skin: string
    corners: Corners
    dark: boolean
    square: boolean
    colors: Partial<ThemeColors>
    /** the theme's stylesheet has been applied (absent outside a DimThemeProvider) */
    ready?: boolean
    /** this page only; undefined goes back to Desktop's */
    setSkin: (next: string | undefined) => void
    setCorners: (next: Corners | undefined) => void
}

export interface DimThemeProviderProps {
    /** pin the skin (default: Desktop's saved choice, followed live) */
    skin?: string
    /** pin the corners (default: Desktop's saved choice, followed live) */
    corners?: Corners
    /** Desktop's tokens stylesheet (default /theme.css on Desktop, the bundled copy elsewhere) */
    themeUrl?: string
    bundled?: boolean
    /** style <body> too (default true) */
    global?: boolean
    children?: ReactNode
}

const ThemeContext = createContext<ThemeContextValue>({
    skin: "portal",
    corners: "theme",
    dark: true,
    square: true,
    colors: {},
    setSkin: () => {},
    setCorners: () => {},
})

/**
 * `skin` / `corners`: pin them (default: Desktop's saved choice, followed live). `themeUrl`: Desktop's tokens
 * stylesheet (default /theme.css on Desktop, the bundled copy elsewhere). `global`: style <body> too (default true).
 */
export function DimThemeProvider({ skin, corners, themeUrl, bundled, global = true, children }: DimThemeProviderProps) {
    const [desktop, setDesktop] = useState<{ skin: string; corners: Corners }>(() => ({
        skin: typeof window === "undefined" ? "portal" : desktopSkin(),
        corners: typeof window === "undefined" ? "theme" : desktopCorners(),
    }))
    const [override, setOverride] = useState<{ skin?: string; corners?: Corners }>({})
    const [state, setState] = useState<{
        dark: boolean
        square: boolean
        colors: Partial<ThemeColors>
        ready: boolean
    }>({ dark: true, square: true, colors: {}, ready: false })
    const wantedSkin = skin ?? override.skin ?? desktop.skin
    const wantedCorners = corners ?? override.corners ?? desktop.corners

    useEffect(() => {
        installInsets()
        return watchDesktopTheme(() => setDesktop({ skin: desktopSkin(), corners: desktopCorners() }))
    }, [])

    useIsoLayoutEffect(() => {
        if (typeof document === "undefined") {
            return
        }
        let live = true
        const update = () => {
            if (!live) {
                return
            }
            const applied = applyTheme({ skin: wantedSkin, corners: wantedCorners })
            setState({ dark: applied.dark, square: applied.square, colors: themeColors(), ready: true })
            document.body?.classList.toggle("dr-body", global)
            dispatchEvent(new CustomEvent("dimos-react-theme", { detail: applied }))
        }
        update()
        installThemeCss({ themeUrl, bundled }).then(() => {
            update()
            signalReady()
        })
        return () => {
            live = false
        }
    }, [wantedSkin, wantedCorners, themeUrl, bundled, global])

    const value = useMemo<ThemeContextValue>(
        () => ({
            skin: wantedSkin,
            corners: wantedCorners,
            dark: state.dark,
            square: state.square,
            colors: state.colors,
            ready: state.ready,
            setSkin: (next) => setOverride((old) => ({ ...old, skin: next })),
            setCorners: (next) => setOverride((old) => ({ ...old, corners: next })),
        }),
        [wantedSkin, wantedCorners, state],
    )
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** `{ skin, corners, dark, square, colors, ready, setSkin, setCorners }` (setSkin/setCorners: this page only). */
export function useTheme(): ThemeContextValue {
    return useContext(ThemeContext)
}

/** The theme's colors (themeColors()), re-read on every skin change: for canvases, charts and 3D scenes. */
export function useThemeColors(): Partial<ThemeColors> {
    return useContext(ThemeContext).colors
}
