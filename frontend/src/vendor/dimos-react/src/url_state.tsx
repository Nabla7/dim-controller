// URL state: the URL is the UI's state, so back/forward, reloads and shared links all reproduce the same screen, and
// the app's backend can drive the UI by changing the URL.
//
//     backend:  publishEvent({ type: "url", set: { recording: "2026-10-11_run3", t: "12.5" } })
//                 ↓ (the app's `events` frontend topic, over Desktop's zenoh-gateway)
//     page:     <UrlStateProvider>  → history.pushState(…?recording=2026-10-11_run3&t=12.5)
//                 ↓
//     UI:       const [recording] = useUrlState("recording")   // renders from the URL
//
// A url event: `{ type: "url", set?: { key: value | null }, replace?: boolean, clear?: boolean }` — `set` merges into
// the current params (null removes one), `clear` drops the others first, `replace` uses replaceState (no new history
// entry). Params live in the query string (mode "search", default) or in the hash (mode "hash": #a=1&b=2).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import type { ReactNode } from "react"
import { useDataSource } from "./data.ts"
import type { DataSource } from "./data.ts"

/** Where the params live: the query string ("search") or the hash ("hash": #a=1&b=2). */
export type UrlMode = "search" | "hash"

/** The URL's params as a plain object of strings. */
export type UrlParams = Record<string, string>

/** Param changes: a value is written as a string (objects as JSON); null / undefined / "" remove the param. */
export type UrlChanges = Record<string, unknown>

/** How a change is written: `replace` uses replaceState (no new history entry), `clear` drops the other params. */
export interface UrlSetOptions {
    replace?: boolean
    clear?: boolean
}

/** The parts of a window the URL store uses (the real window, or createMemoryWindow()). */
export interface UrlWindow {
    location: { readonly href: string }
    history: {
        readonly state: unknown
        pushState(state: unknown, title: string, href: string): void
        replaceState(state: unknown, title: string, href: string): void
    }
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
}

/** The URL as a store (createUrlStore). */
export interface UrlStore {
    mode: UrlMode
    href(): string
    /** the params (the same object until the URL changes) */
    get(): UrlParams
    subscribe(listener: () => void): () => void
    /** true if the URL changed */
    set(changes: UrlChanges, options?: UrlSetOptions): boolean
    /** Applies a backend url event; true if the URL changed. */
    applyEvent(event: unknown, options?: { eventType?: string }): boolean
}

/** The params of `href` as a plain object of strings. */
export function parseUrlState(href: string, { mode = "search" }: { mode?: UrlMode } = {}): UrlParams {
    const url = new URL(href, "http://localhost/")
    const raw = mode === "hash" ? url.hash.replace(/^#/, "") : url.search
    return Object.fromEntries(new URLSearchParams(raw))
}

/** `href` with `changes` applied (null / undefined / "" remove a param; `clear` drops every other param first). */
export function urlWith(
    href: string,
    changes: UrlChanges | null | undefined,
    { mode = "search", clear = false }: { mode?: UrlMode; clear?: boolean } = {},
): string {
    const url = new URL(href, "http://localhost/")
    const params = new URLSearchParams(clear ? "" : mode === "hash" ? url.hash.replace(/^#/, "") : url.search)
    for (const [key, value] of Object.entries(changes ?? {})) {
        if (value === null || value === undefined || value === "") {
            params.delete(key)
        } else {
            params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value))
        }
    }
    params.sort()
    const text = params.toString()
    if (mode === "hash") {
        url.hash = text
    } else {
        url.search = text
    }
    return url.href
}

/** A backend url event (`type` is "url" unless the provider says otherwise); `params` is an older name for `set`. */
export interface UrlEvent {
    type: string
    set?: UrlChanges
    params?: UrlChanges
    replace?: boolean
    clear?: boolean
}

/**
 * What a backend event does to the URL: `{ href, replace }`, or null if it isn't a url event (or changes nothing).
 * @param href the current URL
 * @param event a backend event (anything; only `{ type: eventType, … }` objects count)
 */
export function applyUrlEvent(
    href: string,
    event: unknown,
    { mode = "search", eventType = "url" }: { mode?: UrlMode; eventType?: string } = {},
): { href: string; replace: boolean } | null {
    if (!event || typeof event !== "object" || (event as UrlEvent).type !== eventType) {
        return null
    }
    const urlEvent = event as UrlEvent
    const next = urlWith(href, urlEvent.set ?? urlEvent.params ?? {}, { mode, clear: !!urlEvent.clear })
    if (next === new URL(href, "http://localhost/").href) {
        return null
    }
    return { href: next, replace: !!urlEvent.replace }
}

/** What a memory window's listeners get: `{ type, state }` (the history entry's state). */
export type MemoryWindowListener = (event: { type: string; state: unknown }) => void

/**
 * A window stand-in with a working location + history (pushState, replaceState, back, forward, go → popstate), for
 * tests and server rendering.
 */
export function createMemoryWindow(initialHref = "http://localhost/") {
    const entries: { href: string; state: unknown }[] = [{ href: new URL(initialHref).href, state: null }]
    let index = 0
    const listeners = new Map<string, Set<MemoryWindowListener>>()
    const fire = (type: string) => {
        for (const listener of [...(listeners.get(type) ?? [])]) {
            listener({ type, state: entries[index].state })
        }
    }
    const fakeWindow = {
        location: {
            get href() {
                return entries[index].href
            },
            get search() {
                return new URL(entries[index].href).search
            },
            get hash() {
                return new URL(entries[index].href).hash
            },
            get pathname() {
                return new URL(entries[index].href).pathname
            },
        },
        history: {
            get length() {
                return entries.length
            },
            get state() {
                return entries[index].state
            },
            pushState(state: unknown, _title: string, href: string | URL) {
                entries.splice(index + 1)
                entries.push({ href: new URL(href, entries[index].href).href, state })
                index = entries.length - 1
            },
            replaceState(state: unknown, _title: string, href: string | URL) {
                entries[index] = { href: new URL(href, entries[index].href).href, state }
            },
            go(delta: number) {
                const next = Math.min(entries.length - 1, Math.max(0, index + delta))
                if (next !== index) {
                    index = next
                    fire("popstate")
                }
            },
            back() {
                this.go(-1)
            },
            forward() {
                this.go(1)
            },
        },
        addEventListener(type: string, listener: MemoryWindowListener) {
            if (!listeners.has(type)) {
                listeners.set(type, new Set())
            }
            listeners.get(type)!.add(listener)
        },
        removeEventListener(type: string, listener: MemoryWindowListener) {
            listeners.get(type)?.delete(listener)
        },
    }
    return fakeWindow
}

/**
 * The URL as a store: `get()` → params (the same object until the URL changes), `subscribe(listener)`,
 * `set(changes, { replace, clear })`, `applyEvent(event)`, `href()`. Follows back/forward (popstate, hashchange).
 */
export function createUrlStore({
    window: win = globalThis.window,
    mode = "search",
}: { window?: UrlWindow; mode?: UrlMode } = {}): UrlStore {
    const listeners = new Set<() => void>()
    let lastHref: string | null = null
    let lastParams: UrlParams = {}
    const notify = () => listeners.forEach((listener) => listener())
    const store: UrlStore = {
        mode,
        href: () => win?.location?.href ?? "http://localhost/",
        get() {
            const href = store.href()
            if (href !== lastHref) {
                lastHref = href
                lastParams = parseUrlState(href, { mode })
            }
            return lastParams
        },
        subscribe(listener) {
            listeners.add(listener)
            if (listeners.size === 1 && win) {
                win.addEventListener("popstate", notify)
                win.addEventListener("hashchange", notify)
            }
            return () => {
                listeners.delete(listener)
                if (listeners.size === 0 && win) {
                    win.removeEventListener("popstate", notify)
                    win.removeEventListener("hashchange", notify)
                }
            }
        },
        set(changes, { replace = false, clear = false } = {}) {
            const href = store.href()
            const next = urlWith(href, changes, { mode, clear })
            if (next === new URL(href, "http://localhost/").href) {
                return false
            }
            win?.history?.[replace ? "replaceState" : "pushState"](win.history.state ?? null, "", next)
            notify()
            return true
        },
        applyEvent(event, { eventType = "url" } = {}) {
            const change = applyUrlEvent(store.href(), event, { mode, eventType })
            if (!change) {
                return false
            }
            win?.history?.[change.replace ? "replaceState" : "pushState"](win.history.state ?? null, "", change.href)
            notify()
            return true
        },
    }
    return store
}

/**
 * Wires a data source's backend events to a URL store (non-React pages): every url event on the frontend topic
 * `topic` changes the URL. Returns unsubscribe.
 */
export function bindUrlEvents(
    source: DataSource,
    store: UrlStore,
    { topic = "events", eventType = "url" }: { topic?: string; eventType?: string } = {},
): () => void {
    return source.subscribeFrontend(topic, (event) => store.applyEvent(event, { eventType }))
}

const UrlStateContext = createContext<UrlStore | null>(null)
let defaultStore: UrlStore | null = null
const getDefaultStore = () => (defaultStore ??= createUrlStore())

export interface UrlStateProviderProps {
    mode?: UrlMode
    /** the window whose URL is the state (tests: createMemoryWindow()) */
    window?: UrlWindow
    /** a ready-made store */
    store?: UrlStore
    /** the frontend topic of the backend's url events, or false for none */
    events?: string | boolean
    eventType?: string
    children?: ReactNode
}

/**
 * Provides the URL store below it and (unless `events={false}`) lets the app's backend change the URL with url events
 * on its `events` frontend topic (`events` may name another topic). `window` (tests: createMemoryWindow()) and
 * `mode` ("search" | "hash") pick where the params live; `store` passes a ready-made one.
 */
export function UrlStateProvider({
    mode = "search",
    window: win,
    store: givenStore,
    events = "events",
    eventType = "url",
    children,
}: UrlStateProviderProps) {
    const store = useMemo(
        () => givenStore ?? createUrlStore({ window: win ?? globalThis.window, mode }),
        [givenStore, win, mode],
    )
    const source = useDataSource()
    useEffect(() => {
        if (!events) {
            return
        }
        return bindUrlEvents(source, store, { topic: typeof events === "string" ? events : "events", eventType })
    }, [source, store, events, eventType])
    return <UrlStateContext.Provider value={store}>{children}</UrlStateContext.Provider>
}

/** The URL store in effect (the provider's, else one over the real window). */
export function useUrlStore(): UrlStore {
    // deno-lint-ignore react-rules-of-hooks -- useContext always runs; the ?? only picks a fallback
    return useContext(UrlStateContext) ?? getDefaultStore()
}

/** `[params, setParams(changes, { replace, clear })]`: every URL param, re-rendered on any URL change. */
export function useUrlParams(): [UrlParams, (changes: UrlChanges, options?: UrlSetOptions) => boolean] {
    const store = useUrlStore()
    const params = useSyncExternalStore(store.subscribe, store.get, store.get)
    const set = useCallback((changes: UrlChanges, options?: UrlSetOptions) => store.set(changes, options), [store])
    return [params, set]
}

/** How one param's value is read from and written to its text (`format` → null removes the param). */
// deno-lint-ignore no-explicit-any -- a codec defaults to any value type
export interface UrlCodec<T = any> {
    parse(text: string): T | undefined
    format(value: T): string | null
}

export type UrlCodecName = "string" | "number" | "boolean" | "json"

const CODECS: Record<UrlCodecName, UrlCodec> = {
    string: { parse: (text) => text, format: (value) => value },
    number: {
        parse: (text) => {
            const number = Number(text)
            return Number.isFinite(number) ? number : undefined
        },
        format: (value) => (Number.isFinite(value) ? String(value) : null),
    },
    boolean: { parse: (text) => text === "1" || text === "true", format: (value) => (value ? "1" : null) },
    json: {
        parse: (text) => {
            try {
                return JSON.parse(text)
            } catch {
                return undefined
            }
        },
        format: (value) => (value === undefined ? null : JSON.stringify(value)),
    },
}

export interface UseUrlStateOptions<T> {
    codec?: UrlCodecName | UrlCodec<T>
    replace?: boolean
}

/** useUrlState's setter: a value or `(old) => value`; options as UrlStore.set's. */
export type UrlStateSetter<T> = (next: T | ((old: T) => T), options?: UrlSetOptions) => void

/**
 * One URL param as state: `const [tab, setTab] = useUrlState("tab", "map")`. The default isn't written to the URL
 * (setting it back removes the param). `codec`: "string" (default) | "number" | "boolean" | "json" | { parse, format };
 * `replace: true` for values that change often (a scrubber, a camera pose) so they don't flood history.
 */
export function useUrlState<T = string>(
    key: string,
    defaultValue: T,
    options?: UseUrlStateOptions<T>,
): [T, UrlStateSetter<T>]
export function useUrlState<T = string>(
    key: string,
    defaultValue?: T,
    options?: UseUrlStateOptions<T>,
): [T | undefined, UrlStateSetter<T | undefined>]
export function useUrlState<T = string>(
    key: string,
    defaultValue?: T,
    { codec = "string", replace = false }: UseUrlStateOptions<T> = {},
): [T | undefined, UrlStateSetter<T>] {
    const store = useUrlStore()
    const { parse, format } = typeof codec === "string" ? CODECS[codec] : codec
    const raw = useSyncExternalStore(
        store.subscribe,
        () => store.get()[key],
        () => store.get()[key],
    )
    const value: T | undefined = raw === undefined ? defaultValue : (parse(raw) ?? defaultValue)
    const latest = useRef(value)
    latest.current = value
    const set = useCallback(
        (next: T | ((old: T) => T), options: UrlSetOptions = {}) => {
            const resolved = typeof next === "function" ? (next as (old: T | undefined) => T)(latest.current) : next
            const same = JSON.stringify(resolved) === JSON.stringify(defaultValue)
            store.set({ [key]: same ? null : format(resolved) }, { replace, ...options })
        },
        [store, key, replace, format, JSON.stringify(defaultValue)],
    )
    return [value, set]
}
