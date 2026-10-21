import process from "node:process"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// served at /apps/<name>/, so every asset URL is relative; the dev server forwards the gateway and the backend to a
// running Desktop (DESKTOP_URL, default 7077) and to this app's own server through it
const desktop = process.env.DESKTOP_URL ?? "http://127.0.0.1:7077"
const app = process.env.APP_NAME ?? "dim-controller"
const vendor = new URL("./src/vendor/dimos-react/src", import.meta.url).pathname

export default defineConfig({
    base: "./",
    plugins: [react()],
    // dimos-react is vendored source (deno task vendor-dimos-react); deno.json maps the same names
    resolve: {
        alias: [
            { find: /^dimos-react$/, replacement: `${vendor}/index.ts` },
            { find: /^dimos-react\/(three|graph)$/, replacement: `${vendor}/$1.ts` },
            { find: /^dimos-react\/dim-app\//, replacement: `${vendor}/vendor/dim-app/` },
        ],
    },
    server: {
        proxy: {
            "/zenoh-gateway": { target: desktop, ws: true, changeOrigin: true },
            "/api": { target: `${desktop}/apps/${app}`, changeOrigin: true },
        },
    },
    build: { target: "es2022", chunkSizeWarningLimit: 1500 },
})
