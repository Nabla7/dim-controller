// What's running, for the first-run messages and the drive topic: Desktop's GET /dimos-gateway/active (+ the running
// blueprint's modules and streams), refreshed live on Desktop's zenoh `runs` and the dimos server's `launch` events, and again
// after the zenoh-gateway connection comes back (docs/events.md: snapshot + live). GET /dimos-gateway/info says if dimOS is there.
import { getZenoh } from "dimos-react/dim-app/zenoh.js"
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
    /** each running blueprint's modules and their streams (Desktop's /dimos-gateway/catalog/blueprints/<name>); null = unknown */
    blueprints: Record<string, Module[] | null>
}

type Active = { running?: boolean; blueprint?: string | null; launch?: { blueprint?: string; phase?: string } | null }
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
        const response = await fetch(desktopUrl(`dimos-gateway/catalog/blueprints/${encodeURIComponent(name)}?fields=modules`))
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
            const info = await (await fetch(desktopUrl("dimos-gateway/info"))).json()
            dimosInstalled = !!(info.found && info.installed)
        } catch {
            // no Desktop here: keep what we knew
        }
        try {
            const response = await fetch(desktopUrl("dimos-gateway/active"))
            if (!response.ok) {
                throw new Error(String(response.status))
            }
            const active: Active = await response.json()
            const phase = active.launch?.phase
            const running = new Set<string>()
            if (active.running && active.blueprint) {
                running.add(active.blueprint)
            }
            if (phase === "running" && active.launch?.blueprint) {
                running.add(active.launch.blueprint)
            }
            const starting = phase === "starting" ? active.launch?.blueprint ?? null : null
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

/** A running blueprint has dimos's ManipulationModule (the arm planner viser sits on): the controller's Plan and move
 * shows whatever the controller format, since a robot that drives can have arms too (an R1 Pro's nav). */
export function plannerRunning(state: RunState): boolean {
    return Object.values(state.blueprints).some((modules) => (modules ?? []).some((module) => module.name?.toLowerCase() === "manipulationmodule"))
}
