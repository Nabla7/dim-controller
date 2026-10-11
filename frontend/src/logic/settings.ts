// A tiny observable value (dimos-react's Store, typed here): the logic (no React) writes it, the UI reads it with
// useStore.
import { Store as LibraryStore, useStore as libraryUseStore } from "dimos-react"

export interface Store<T extends object> {
    get(): T
    set(value: T): void
    update(patch: Partial<T>): void
    subscribe(listener: () => void): () => void
}
export const Store = LibraryStore as new <T extends object>(value: T) => Store<T>
export const useStore = libraryUseStore as <T extends object>(store: Store<T>) => T

// Settings live in the backend (GET / PATCH api/settings, server/src/settings.rs), not in the browser, so the agent can
// read and change them and every open viewer follows (a `settings` event). `loadSettings()` runs before the app starts;
// stores made before it (module-level ones) take the loaded value when it arrives.
const stores = new Map<string, { store: Store<object>; defaults: object; pushing: number }>()
let loaded: Record<string, object> = {}
/** while a remote value is applied, the store's own change isn't sent back */
let applying = false
const PUSH_MS = 150

function settingsUrl(): string {
    return new URL("api/settings", location.href).href
}

/** Fetches every setting; call (and await) once before the app reads its settings. */
export async function loadSettings(): Promise<void> {
    try {
        const response = await fetch(settingsUrl())
        if (response.ok) {
            loaded = await response.json()
            for (const [key, value] of Object.entries(loaded)) {
                applyRemoteSetting(key, value)
            }
        }
    } catch {
        // no backend (a static preview): defaults
    }
}

/** A setting changed in the backend (by another page, or the agent): the store takes it. */
export function applyRemoteSetting(key: string, value: unknown) {
    if (!value || typeof value !== "object") {
        return
    }
    loaded[key] = value as object
    const entry = stores.get(key)
    // our own change on its way back: newer local edits win
    if (!entry || entry.pushing > 0) {
        return
    }
    applying = true
    try {
        entry.store.set({ ...entry.defaults, ...value })
    } finally {
        applying = false
    }
}

/** A setting as loaded from the backend (undefined: never saved). */
export function loadedSetting(key: string): object | undefined {
    return loaded[key]
}

/** Saves fields of a setting now (PATCH api/settings), e.g. before a reload. */
export async function saveSetting(key: string, value: object): Promise<void> {
    await fetch(settingsUrl(), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, value }) })
}

/** A store whose value is the backend setting `key` (defaults filled in); a local change is sent to the backend. */
export function persistentStore<T extends object>(key: string, defaults: T): Store<T> {
    const existing = stores.get(key)
    if (existing) {
        return existing.store as Store<T>
    }
    const store = new Store<T>({ ...defaults, ...(loaded[key] ?? {}) })
    const entry = { store: store as Store<object>, defaults, pushing: 0 }
    stores.set(key, entry)
    let timer = 0
    store.subscribe(() => {
        // a remote value being applied; or no page around it (unit tests)
        if (applying || typeof location === "undefined") {
            return
        }
        entry.pushing++
        clearTimeout(timer)
        timer = setTimeout(async () => {
            try {
                await fetch(settingsUrl(), {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ key, value: store.get() }),
                })
            } catch {
                // backend down: the page keeps its value
            } finally {
                // the echo of this change arrives about now; later remote changes apply again
                setTimeout(() => (entry.pushing = 0), 500)
            }
        }, PUSH_MS) as unknown as number
    })
    return store
}
