import { readFileSync } from "node:fs"
import process from "node:process"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { esmFetch } from "./tools/esm_fetch.ts"

// served at /apps/<name>/, so every asset URL is relative; the dev server forwards the gateway and the backend to a
// running Desktop (DESKTOP_URL, default 7077) and to this app's own server through it
const desktop = process.env.DESKTOP_URL ?? "http://127.0.0.1:7077"
const app = process.env.APP_NAME ?? "dim-controller"
const imports: Record<string, string> = JSON.parse(readFileSync(new URL("./deno.json", import.meta.url), "utf8")).imports
// dimos-react: its TypeScript source at its tag on GitHub (deno.json's URLs, the same files deno and the tests read),
// fetched and compiled into the page; its react, react-dom and three resolve to this page's own
const dimosReact = Object.fromEntries(Object.entries(imports).filter(([name]) => name.startsWith("dimos-react")))

export default defineConfig({
    base: "./",
    // dimos-react's source is fetched at build (tools/esm_fetch.ts)
    plugins: [esmFetch(dimosReact), react()],
    server: {
        proxy: {
            // Desktop tells which app a connection is from by its Referer: this page's, as if served at /apps/<name>/
            "/zenoh-gateway": { target: desktop, ws: true, changeOrigin: true, headers: { referer: `${desktop}/apps/${app}/` } },
            // dim-app asks Desktop where the gateway is (gateways/desktop/management/gateways/zenoh)
            "/gateways": { target: desktop, ws: true, changeOrigin: true, headers: { referer: `${desktop}/apps/${app}/` } },
            "/api": { target: `${desktop}/apps/${app}`, changeOrigin: true },
            // served under /apps/<name>/ (vite --base /apps/<name>/, as Desktop serves it, so the page hears its events)
            [`/apps/${app}/api`]: { target: desktop, changeOrigin: true }, // dimos-yaml-check: ignore (the dev proxy, not a call)
        },
    },
    build: { target: "es2022", chunkSizeWarningLimit: 1500 },
})
