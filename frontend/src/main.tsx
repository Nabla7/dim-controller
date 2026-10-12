import { createRoot } from "react-dom/client"
// Portal (dark) / Research (light), following dimOS Desktop's theme; set before the first render
import { initTheme } from "./dim-app/source/theme.js"
import "./dim-app/source/theme.css"
import "./styles.css"
// every built-in layer type registers itself on import; a fork adds its own files to layers/index.ts
import "./layers/index.ts"
import { App } from "./App.tsx"
import { loadSettings } from "./core/store.ts"

initTheme()

// the settings are the backend's (api/settings): the app starts once they're here
loadSettings().then(() => createRoot(document.getElementById("root")!).render(<App />))
