// <AppProvider>: everything an app needs once, at its root: Desktop's theme (live), the data source (zenoh-gateway
// unless `source` is given), URL state driven by the backend's url events, toasts and confirm/prompt dialogs.
//
//     createRoot(document.getElementById("root")).render(h(AppProvider, null, h(App)))
import type { ComponentProps, ReactNode } from "react"
import { DimThemeProvider } from "./theme/provider.tsx"
import type { DimThemeProviderProps } from "./theme/provider.tsx"
import { DataSourceProvider } from "./data.ts"
import type { DataSource } from "./data.ts"
import { UrlStateProvider } from "./url_state.tsx"
import type { UrlStateProviderProps } from "./url_state.tsx"
import { DialogProvider, ToastProvider } from "./components/feedback.tsx"

export interface AppProviderProps {
    /** DimThemeProvider props (skin, corners, themeUrl…) */
    theme?: Omit<DimThemeProviderProps, "children">
    /** a data source (memorySource(), …; default: the page's zenoh-gateway connection) */
    source?: DataSource
    /** UrlStateProvider props, or false for none */
    url?: Omit<UrlStateProviderProps, "children"> | false
    /** where toasts appear (ToastProvider's `position`) */
    toastPosition?: ComponentProps<typeof ToastProvider>["position"]
    children?: ReactNode
}

/**
 * `theme`: DimThemeProvider props (skin, corners, themeUrl…); `source`: a data source (memorySource(), …; default:
 * the page's zenoh-gateway connection); `url`: UrlStateProvider props, or false for none
 */
export function AppProvider({ theme = {}, source, url = {}, toastPosition, children }: AppProviderProps) {
    let tree = (
        <DialogProvider>
            <ToastProvider position={toastPosition}>{children}</ToastProvider>
        </DialogProvider>
    )
    if (url !== false) {
        tree = <UrlStateProvider {...url}>{tree}</UrlStateProvider>
    }
    if (source) {
        tree = <DataSourceProvider source={source}>{tree}</DataSourceProvider>
    }
    return <DimThemeProvider {...theme}>{tree}</DimThemeProvider>
}
