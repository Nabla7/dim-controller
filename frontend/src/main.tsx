import { createRoot } from "react-dom/client"
import { AppProvider } from "dimos-react"
import "./styles.css"
// every built-in layer type registers itself on import; a fork adds its own files to layers/index.ts
import "./layers/index.ts"
import { App } from "./App.tsx"
import { loadSettings } from "./core/store.ts"

// the settings are the backend's (api/settings): the app starts once they're here. AppProvider: Desktop's skin (live),
// toasts and dialogs; the page's zenoh connection is the app's own (core/transport.ts), so no URL-state bridge
loadSettings().then(() =>
    createRoot(document.getElementById("root")!).render(
        <AppProvider url={false}>
            <App />
        </AppProvider>,
    )
)
