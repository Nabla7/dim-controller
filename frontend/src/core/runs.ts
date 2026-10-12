// What's running, for the first-run messages and the drive topic: Desktop's GET /dimos/runs (+ each running
// blueprint's modules and streams), refreshed live on Desktop's zenoh `runs` and the dimos server's `launch` events, and again
// after the zenoh-gateway connection comes back (docs/events.md: snapshot + live). GET /dimos/info says if dimOS is there.
import { getZenoh } from "../dim-app/source/zenoh.js"
import { Store } from "./store.ts"
import type { Module } from "./cmdvel.ts"

export interface RunState {
    /** false until the first answer (or when there's no Desktop dimos API here: dev server, remote robot) */
    known: boolean
    /** Desktop's /dimos API answered */
    desktop: boolean
    /** null = unknown */
    dimosInstalled: boolean | null
    /** blueprints running now */
    running: string[]
    /** a blueprint the Launcher is starting, or null */
    starting: string | null
    /** each running blueprint's modules and their streams (Desktop's /dimos/blueprints/<name>); null = unknown */
    blueprints: Record<string, Module[] | null>
}

type Runs = { launch?: { blueprint?: string; phase?: string } | null; runs?: { blueprint: string }[] }
type Blueprint = { modules?: Module[] }

const desktopUrl = (path: string) => new URL(`../../${path}`, location.href)

export class RunWatch {
    readonly state = new Store<RunState>({ known: false, desktop: false, dimosInstalled: null, running: [], starting: null, blueprints: {} })
    #pending: Promise<void> | null = null
    #again = false
    #blueprints = new Map<string, Module[]>()

    start() {
        const zenoh = getZenoh()
        zenoh.subscribeDesktop("runs", () => this.refresh())
        zenoh.subscribeDimos("launch", () => this.refresh())
        zenoh.onReconnect(() => this.refresh())
        this.refresh()
        // a slow safety net only: the events above are what make it live
        setInterval(() => this.refresh(), 30_000)
    }

    /** Re-GETs (coalesced: a call while one is in flight runs once more after it). */
    refresh(): Promise<void> {
        if (this.#pending) {
            this.#again = true
            return this.#pending
        }
        this.#pending = this.#load().finally(() => {
            this.#pending = null
            if (this.#again) {
                this.#again = false
                this.refresh()
            }
        })
        return this.#pending
    }

    async #modulesOf(name: string): Promise<Module[]> {
        const cached = this.#blueprints.get(name)
        if (cached) {
            return cached
        }
        const response = await fetch(desktopUrl(`dimos/blueprints/${encodeURIComponent(name)}`))
        if (!response.ok) {
            throw new Error(String(response.status))
        }
        const blueprint: Blueprint = await response.json()
        const modules = blueprint.modules ?? []
        this.#blueprints.set(name, modules)
        return modules
    }

    async #load() {
        let dimosInstalled = this.state.get().dimosInstalled
        try {
            const info = await (await fetch(desktopUrl("dimos/info"))).json()
            dimosInstalled = !!(info.found && info.installed)
        } catch {
            // no Desktop here: keep what we knew
        }
        try {
            const response = await fetch(desktopUrl("dimos/runs"))
            if (!response.ok) {
                throw new Error(String(response.status))
            }
            const runs: Runs = await response.json()
            const phase = runs.launch?.phase
            const running = new Set<string>((runs.runs ?? []).map((run) => run.blueprint).filter(Boolean))
            if (phase === "running" && runs.launch?.blueprint) {
                running.add(runs.launch.blueprint)
            }
            const starting = phase === "starting" ? runs.launch?.blueprint ?? null : null
            const blueprints: Record<string, Module[] | null> = {}
            for (const name of running) {
                try {
                    blueprints[name] = await this.#modulesOf(name)
                } catch {
                    blueprints[name] = null // its metadata isn't available: auto falls back to the standard topics
                }
            }
            this.state.set({ known: true, desktop: true, dimosInstalled, running: [...running], starting, blueprints })
        } catch {
            // no Desktop dimos API here (dev server, remote robot): the profile's list and the bridge are enough
            this.state.update({ known: true, desktop: false, dimosInstalled })
        }
    }
}
