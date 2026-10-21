// A tiny observable value: the 3D core (no React) writes it, components read it with useStore.
import { useSyncExternalStore } from "react"

export class Store<T> {
    #value: T
    #listeners: Set<() => void> = new Set()
    constructor(value: T) {
        this.#value = value
    }
    get(): T {
        return this.#value
    }
    set(value: T) {
        this.#value = value
        for (const listener of [...this.#listeners]) {
            listener()
        }
    }
    update(patch: Partial<T>) {
        this.set({ ...this.#value, ...patch })
    }
    subscribe = (listener: () => void): () => void => {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }
}

/** The store's current value, re-rendered on every change. */
export function useStore<T>(store: Store<T>): T {
    return useSyncExternalStore(
        store.subscribe,
        () => store.get(),
        () => store.get(),
    )
}

/**
 * localStorage JSON, or the fallback (private windows and blocked storage throw or return nothing). The saved JSON is
 * trusted to have the fallback's shape.
 */
export function readLocal<T>(key: string, fallback: T): T {
    try {
        const raw = globalThis.localStorage?.getItem(key)
        return raw ? JSON.parse(raw) : fallback
    } catch {
        return fallback
    }
}

/** Saves JSON to localStorage; without storage the value lasts for this page only. */
export function writeLocal(key: string, value: unknown) {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value))
    } catch {
        // storage unavailable
    }
}

/**
 * A Store saved in localStorage under `key` (fields missing from what's saved come from `defaults`). Apps that keep
 * settings elsewhere (a backend) pass their own `persist(key, defaults)` to the components that take one.
 */
export function localStore<T>(key: string, defaults: T): Store<T> {
    const saved: unknown = readLocal(key, null)
    const store = new Store(
        saved && typeof saved === "object" && !Array.isArray(saved) ? { ...defaults, ...saved } : defaults,
    )
    store.subscribe(() => writeLocal(key, store.get()))
    return store
}
