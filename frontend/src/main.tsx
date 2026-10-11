import { createRoot } from "react-dom/client"
import { AppProvider, CameraStreamsProvider } from "dimos-react"
import "./layout.css"
import { App } from "./App.tsx"
import { ControllerApp } from "./logic/controller.ts"
import { loadSettings } from "./logic/settings.ts"

declare global {
    interface Window {
        __lv?: ControllerApp
    }
}

// the settings are the backend's (api/settings): the app starts once they're here
loadSettings().then(() => {
    const app = new ControllerApp()
    window.__lv = app
    createRoot(document.getElementById("root")!).render(
        <AppProvider source={app.connection.source} url={false} toastPosition="bottom">
            <CameraStreamsProvider streams={app.cameras}>
                <App app={app} />
            </CameraStreamsProvider>
        </AppProvider>,
    )
})
