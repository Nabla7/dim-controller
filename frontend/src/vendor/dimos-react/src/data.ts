// deno-lint-ignore-file no-explicit-any -- payloads decoded from any topic have any shape
// Where live data comes from. Every hook and 3D layer reads through a *data source*, so the same components show a
// live robot (Desktop's zenoh-gateway), a replay (a recording app pushing its own messages) or test data.
//
//     h(ZenohProvider, null, h(App))                         // live: the page's zenoh-gateway connection
//     const source = memorySource(); h(DataSourceProvider, { source }, h(App)); source.publish(key, bytes)
//     const { value } = useTopic("dimos/odom/nav_msgs.Odometry")   // decoded LCM, re-rendered per message
//     const topics = useTopicList()                                 // [{ key, name, type }]
//     useBackendEvents((event) => ...)                              // the app backend's `events` frontend topic
//
// A source is `{ subscribe, subscribeFrontend, listTopics, state, onState, now }`; see zenohSource / memorySource.
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
// @deno-types="./vendor/dim-app/zenoh.d.ts"
import { type AppZenoh, type ConnectionState, getZenoh, type GetZenohOptions } from "./vendor/dim-app/zenoh.js"
import { decode as decodeLcm } from "./lcm.ts"

export type { AppZenoh }

/** A source's connection state: "connecting" | "connected" | "degraded" | "lost". */
export type SourceState = ConnectionState

/** A dimos topic: its zenoh key, its name ("/odom") and LCM type ("nav_msgs.Odometry"). */
export interface Topic {
    key: string
    name: string
    type: string
}

/** A topic a source lists (`{ key }`, plus whatever else the source knows about it). */
export interface ListedTopic {
    key: string
    [field: string]: unknown
}

/**
 * One message off a source: zenoh-gateway's `{ key, bytes, timestamp, … }`. `decoded` is the gateway's own decoding
 * (encodings like dimos_lcm_pointcloud2); `value` is what an in-page source was given (not bytes).
 */
export interface Message {
    key: string
    bytes: Uint8Array
    timestamp?: number
    kind?: string
    seq?: number
    decoded?: unknown
    value?: unknown
}

/** What a frontend-topic callback gets alongside the payload. */
export interface FrontendMessage {
    key: string
    timestamp?: number
}

/** How a message becomes a value (see decodeMessage). */
export type Decoder = "auto" | "decoded" | "lcm" | "json" | "text" | "bytes" | ((message: Message) => any)

/** Options a source's subscribe takes (zenoh-gateway's: delivery, maxHz, encoding, encodeOptions, minQuality, …). */
export interface SubscribeOptions {
    delivery?: "latest" | "reliable"
    maxHz?: number
    encoding?: string
    encodeOptions?: Record<string, unknown>
    minQuality?: number
    [option: string]: unknown
}

/** A source's subscribe returns this: call it (or `.unsubscribe()`) to stop; `.update(changes)` changes options. */
export type Subscription = (() => void) & {
    unsubscribe(): void
    update(changes: Record<string, unknown>): Promise<void>
}

/** A pose topic's whole recorded route: `points` are `[tSeconds, x, y, z]`. */
export interface Route {
    frame: string
    points: [number, number, number, number][]
}

/** Where live data comes from (zenohSource, memorySource, or anything with this shape). */
export interface DataSource {
    kind: string
    readonly state: ConnectionState
    /** a replay: `now()` is the playhead, so staleness, fading and lifetimes follow it (not the wall clock) */
    replay?: boolean
    subscribe(key: string, options: SubscribeOptions | undefined, onMessage: (message: Message) => void): Subscription
    subscribeFrontend(
        topic: string,
        callback: (payload: any, message: FrontendMessage) => void,
        options?: Record<string, unknown>,
    ): () => void
    listTopics(filter?: string, options?: { probeMs?: number }): Promise<ListedTopic[]>
    onState(listener: (state: ConnectionState) => void): () => void
    onReconnect?(listener: () => void): () => void
    /** the topic list changed (a source that knows, rather than has to probe) */
    onTopics?(listener: () => void): () => void
    now(): number
    seek?(): void
    onSeek?(listener: () => void): () => void
    route?: ((key: string) => Route | null | Promise<Route | null>) | null
}

/** The live source (zenohSource): `zenoh` is the page's dim-app connection. */
export interface ZenohSource extends DataSource {
    kind: "zenoh"
    readonly zenoh: AppZenoh
    onReconnect(listener: () => void): () => void
}

/** The in-page source (memorySource). */
export interface MemorySource extends DataSource {
    kind: "memory"
    state: ConnectionState
    replay: boolean
    onReconnect(listener: () => void): () => void
    onTopics(listener: () => void): () => void
    seek(): void
    onSeek(listener: () => void): () => void
    route: ((key: string) => Route | null | Promise<Route | null>) | null
    /** Delivers a message to every subscriber whose key expression matches `key`. */
    publish(key: string, payload: unknown, options?: { timestamp?: number }): void
    /** What the app backend's publishFrontend(topic, payload) does: JSON to `subscribeFrontend(topic)` listeners. */
    publishFrontend(topic: string, payload: unknown): void
    setTopics(keys: string[]): void
    setState(next: ConnectionState): void
}

export interface MemorySourceOptions {
    topics?: string[]
    state?: ConnectionState
    /** the playhead (ms): makes the source a replay */
    clock?: () => number
    route?: (key: string) => Route | null | Promise<Route | null>
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** `dimos/<name>/<type>` → `{ key, name: "/<name>", type }`; anything else → null. */
export function parseKey(key: string): Topic | null {
    const parts = String(key).split("/")
    if (parts.length < 3 || parts[0] !== "dimos" || key.includes("*")) {
        return null
    }
    const type = parts[parts.length - 1]
    if (!/^\w+\.\w+$/.test(type)) {
        return null
    }
    return { key, name: "/" + parts.slice(1, -1).join("/"), type }
}

/** The zenoh key dimos uses for a topic of a type: dimosKey("/odom", "nav_msgs.Odometry"). */
export const dimosKey = (topic: string, type: string): string => `dimos/${String(topic).replace(/^\/+/, "")}/${type}`

/** zenoh key-expression matching (`*` = one chunk, `**` = any number of chunks). */
export function keyMatches(pattern: string, key: string): boolean {
    const want = pattern.split("/")
    const have = key.split("/")
    const match = (i: number, j: number): boolean => {
        if (i === want.length) {
            return j === have.length
        }
        if (want[i] === "**") {
            for (let k = j; k <= have.length; k++) {
                if (match(i + 1, k)) {
                    return true
                }
            }
            return false
        }
        return j < have.length && (want[i] === "*" || want[i] === have[j]) && match(i + 1, j + 1)
    }
    return match(0, 0)
}

/**
 * Turns a message into a value: "lcm" (dimos LCM, the type from the key or `type`), "json", "text", "bytes", or a
 * function `(message) => value`. A message the gateway already decoded (an encoding like dimos_lcm_pointcloud2)
 * keeps `message.decoded`.
 */
export function decodeMessage(message: Message, how: Decoder = "auto", type?: string): any {
    if (typeof how === "function") {
        return how(message)
    }
    if (message.decoded !== undefined && (how === "auto" || how === "decoded")) {
        return message.decoded
    }
    if (message.value !== undefined && how === "auto") {
        return message.value
    }
    const kind = how === "auto" ? (type || parseKey(message.key)?.type ? "lcm" : "json") : how
    if (kind === "bytes") {
        return message.bytes
    }
    if (kind === "text") {
        return decoder.decode(message.bytes)
    }
    if (kind === "json") {
        return JSON.parse(decoder.decode(message.bytes))
    }
    return decodeLcm(type ?? parseKey(message.key)!.type, message.bytes)
}

/**
 * The live source: the page's one zenoh-gateway connection (dim-app's getZenoh(), shared with everything else on the
 * page). `options` go to getZenoh on first use (app, connectOptions, …).
 */
export function zenohSource(options: GetZenohOptions = {}): ZenohSource {
    let zenoh: AppZenoh | null = null
    const get = () => (zenoh ??= getZenoh(options))
    return {
        kind: "zenoh",
        get zenoh() {
            return get()
        },
        subscribe: (key, subscribeOptions, onMessage) => get().subscribe(key, subscribeOptions ?? {}, onMessage),
        subscribeFrontend: (topic, callback, frontendOptions) =>
            get().subscribeFrontend(topic, callback, frontendOptions),
        listTopics: async (filter = "dimos/**", { probeMs = 800 } = {}) => {
            const client = (await get().ready).client!
            // plain objects: a ListedTopic takes any field
            return (await client.listTopics(filter, { probeMs })).map((topic): ListedTopic => ({ ...topic }))
        },
        get state() {
            return get().state
        },
        onState: (listener) => get().onState(listener),
        onReconnect: (listener) => get().onReconnect(listener),
        now: () => {
            const client = get().client
            return client?.now ? client.now() + (client.clockOffsetMs ?? 0) : Date.now()
        },
    }
}

/**
 * An in-page source: whatever calls `publish` is the data (tests, demos, a replay app feeding recorded messages).
 * `publish(key, payload)` takes bytes (LCM etc.), or any value (delivered as `message.value`, decoded as itself).
 * A replay passes `clock` (the playhead, ms: `now()` returns it), calls `seek()` when the playhead jumps and may pass
 * `route(key)` (a pose topic's whole recorded route) so the 3D view can draw it.
 */
export function memorySource({
    topics = [],
    state = "connected",
    clock,
    route,
}: MemorySourceOptions = {}): MemorySource {
    const subscribers = new Set<{ key: string; onMessage: (message: Message) => void }>()
    const frontend = new Set<{ topic: string; callback: (payload: any, message: FrontendMessage) => void }>()
    const stateListeners = new Set<(state: ConnectionState) => void>()
    const topicListeners = new Set<() => void>()
    const seekListeners = new Set<() => void>()
    let known = new Map<string, ListedTopic>(topics.map((key) => [key, { key }]))
    const source: MemorySource = {
        kind: "memory",
        state,
        /** a replay: `now()` is the playhead, so staleness, fading and lifetimes follow it (not the wall clock) */
        replay: !!clock,
        subscribe(key, _options, onMessage) {
            const entry = { key, onMessage }
            subscribers.add(entry)
            const off = () => subscribers.delete(entry)
            return Object.assign(off, { unsubscribe: off, update: async () => {} })
        },
        subscribeFrontend(topic, callback) {
            const entry = { topic, callback }
            frontend.add(entry)
            return () => frontend.delete(entry)
        },
        listTopics: (filter = "**") =>
            Promise.resolve([...known.values()].filter((topic) => keyMatches(filter, topic.key))),
        onState(listener) {
            stateListeners.add(listener)
            return () => stateListeners.delete(listener)
        },
        onReconnect: () => () => {},
        onTopics(listener) {
            topicListeners.add(listener)
            return () => topicListeners.delete(listener)
        },
        now: clock ?? (() => Date.now()),
        /** A replay's playhead jumped (seek, scrub, loop): layers drop what they gathered over time. */
        seek() {
            seekListeners.forEach((listener) => listener())
        },
        onSeek(listener) {
            seekListeners.add(listener)
            return () => seekListeners.delete(listener)
        },
        /**
         * A pose topic's whole route, when the source knows it up front (a recording):
         * `Promise<{ frame, points: [tSeconds, x, y, z][] } | null>`.
         */
        route: route ?? null,
        /** Delivers a message to every subscriber whose key expression matches `key`. */
        publish(key, payload, { timestamp = source.now() } = {}) {
            if (!known.has(key)) {
                known.set(key, { key })
                topicListeners.forEach((listener) => listener())
            }
            const message: Message = payload instanceof Uint8Array
                ? { key, bytes: payload, timestamp }
                : { key, value: payload, bytes: encoder.encode(JSON.stringify(payload ?? null)), timestamp }
            for (const entry of [...subscribers]) {
                if (keyMatches(entry.key, key)) {
                    entry.onMessage(message)
                }
            }
        },
        /** What the app backend's publishFrontend(topic, payload) does: JSON to `subscribeFrontend(topic)` listeners. */
        publishFrontend(topic, payload) {
            for (const entry of [...frontend]) {
                if (keyMatches(entry.topic, topic)) {
                    entry.callback(payload, { key: topic, timestamp: Date.now() })
                }
            }
        },
        setTopics(keys) {
            known = new Map(keys.map((key) => [key, { key }]))
            topicListeners.forEach((listener) => listener())
        },
        setState(next) {
            source.state = next
            stateListeners.forEach((listener) => listener(next))
        },
    }
    return source
}

const DataSourceContext = createContext<DataSource | null>(null)
let defaultSource: ZenohSource | null = null

export interface DataSourceProviderProps {
    source: DataSource
    children?: ReactNode
}

/** Makes `source` the data source of everything below. */
export function DataSourceProvider({ source, children }: DataSourceProviderProps) {
    return createElement(DataSourceContext.Provider, { value: source }, children)
}

export interface ZenohProviderProps extends GetZenohOptions {
    children?: ReactNode
}

/** DataSourceProvider with the live zenoh-gateway source (props go to getZenoh on first use). */
export function ZenohProvider({ children, ...options }: ZenohProviderProps) {
    const source = useMemo(() => zenohSource(options), [])
    return createElement(DataSourceContext.Provider, { value: source }, children)
}

/** The data source in effect: the nearest provider's, else the page's zenoh-gateway connection. */
export function useDataSource(): DataSource {
    const source = useContext(DataSourceContext)
    return source ?? (defaultSource ??= zenohSource())
}

/** The zenoh connection behind the source (dim-app's AppZenoh), or null for a non-zenoh source. */
export function useZenoh(): AppZenoh | null {
    const source = useDataSource()
    return source.kind === "zenoh" ? (source as ZenohSource).zenoh : null
}

export interface UseSubscriptionOptions extends SubscribeOptions {
    /** how a message becomes a value (decodeMessage's `how`) */
    decode?: Decoder
    /** the LCM type, when the key doesn't say */
    type?: string
}

/**
 * Calls `onMessage(value, message)` for every message on `key` (null key: nothing). The callback may change freely.
 * @param key a zenoh key expression
 */
export function useSubscription<T = any>(
    key: string | null | undefined,
    onMessage: (value: T, message: Message) => void,
    options: UseSubscriptionOptions = {},
): void {
    const source = useDataSource()
    const callback = useRef(onMessage)
    callback.current = onMessage
    const { decode = "auto", type, ...subscribeOptions } = options
    const optionsKey = JSON.stringify(subscribeOptions)
    useEffect(() => {
        if (!key) {
            return
        }
        const off = source.subscribe(key, { delivery: "latest", ...JSON.parse(optionsKey) }, (message) => {
            let value
            try {
                value = decodeMessage(message, decode, type)
            } catch (error) {
                console.debug(`[dimos-react] ${message.key}: cannot decode (${(error as Error)?.message ?? error})`)
                return
            }
            callback.current(value, message)
        })
        return () => off()
    }, [source, key, optionsKey, typeof decode === "string" ? decode : "fn", type])
}

export interface UseTopicOptions<T = any> extends UseSubscriptionOptions {
    /** the value before the first message */
    initial?: T
}

/** The latest message on a topic and its decoded value (`initial` until the first message). */
export interface TopicState<T = any> {
    value: T | undefined
    message: Message | null
    timestamp: number | null
    count: number
}

/** The latest message on a topic, re-rendered per message (throttle with `maxHz`). */
export function useTopic<T = any>(key: string | null | undefined, options: UseTopicOptions<T> = {}): TopicState<T> {
    const [latest, setLatest] = useState<TopicState<T>>({
        value: options.initial,
        message: null,
        timestamp: null,
        count: 0,
    })
    useEffect(() => setLatest({ value: options.initial, message: null, timestamp: null, count: 0 }), [key])
    useSubscription(
        key,
        (value, message) => {
            setLatest((old) => ({ value, message, timestamp: message.timestamp ?? Date.now(), count: old.count + 1 }))
        },
        options,
    )
    return latest
}

/**
 * The dimos topics on the bus (`[{ key, name, type }]`, sorted), re-listed every `intervalMs`. A topic stays listed
 * `forgetMs` after it was last seen (slow publishers miss a probe now and then).
 */
export function useTopicList({
    filter = "dimos/**",
    intervalMs = 2000,
    forgetMs = 20000,
    types,
}: { filter?: string; intervalMs?: number; forgetMs?: number; types?: string[] } = {}): Topic[] {
    const source = useDataSource()
    const [topics, setTopics] = useState<Topic[]>([])
    const typesKey = types ? types.join(",") : ""
    useEffect(() => {
        let live = true
        let timer: ReturnType<typeof setTimeout> | undefined
        const lastSeen = new Map<string, { topic: Topic; at: number }>()
        const round = async () => {
            try {
                const found = await source.listTopics(filter)
                const now = Date.now()
                for (const item of found) {
                    const topic = parseKey(item.key)
                    if (topic && (!typesKey || typesKey.split(",").includes(topic.type))) {
                        lastSeen.set(topic.key, { topic, at: now })
                    }
                }
                for (const [key, seen] of lastSeen) {
                    if (now - seen.at > forgetMs) {
                        lastSeen.delete(key)
                    }
                }
                const next = [...lastSeen.values()]
                    .map((seen) => seen.topic)
                    .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
                if (live) {
                    setTopics((old) =>
                        old.length === next.length && old.every((topic, index) => topic.key === next[index].key)
                            ? old
                            : next
                    )
                }
            } catch {
                // reconnecting: next round
            }
            if (live) {
                timer = setTimeout(round, intervalMs)
            }
        }
        round()
        const offTopics = source.onTopics?.(() => {
            clearTimeout(timer)
            round()
        })
        return () => {
            live = false
            clearTimeout(timer)
            offTopics?.()
        }
    }, [source, filter, intervalMs, forgetMs, typesKey])
    return topics
}

/** The source's connection state: "connecting" | "connected" | "degraded" | "lost". */
export function useConnectionState(): ConnectionState {
    const source = useDataSource()
    const [state, setState] = useState<ConnectionState>(() => source.state ?? "connecting")
    useEffect(() => {
        setState(source.state ?? "connecting")
        return source.onState((next) => setState(next))
    }, [source])
    return state
}

/**
 * The app backend's events (dim-app's publishEvent / publishFrontend("events", …)): `onEvent(event)` per event.
 * `onReconnect` runs when the link comes back (events sent while it was down are gone: re-GET what you show).
 */
export function useBackendEvents(
    onEvent: (event: any) => void,
    { topic = "events", onReconnect }: { topic?: string; onReconnect?: () => void } = {},
): void {
    const source = useDataSource()
    const handler = useRef(onEvent)
    handler.current = onEvent
    const reconnect = useRef(onReconnect)
    reconnect.current = onReconnect
    useEffect(() => {
        const off = source.subscribeFrontend(topic, (event) => handler.current(event))
        const offReconnect = source.onReconnect?.(() => reconnect.current?.())
        return () => {
            off()
            offReconnect?.()
        }
    }, [source, topic])
}

export interface UseBackendStateOptions<T = any> {
    /** where to GET the snapshot (default `api/state/<key>`) */
    url?: string
    /** the frontend topic announcing changes (default `state/<key>`) */
    topic?: string
    /** the value before the first GET answers */
    initial?: T
    debounceMs?: number
    fetch?: typeof fetch
}

/** useBackendState's second element. */
export interface BackendStateStatus {
    loading: boolean
    error: Error | null
    refresh: () => Promise<void>
}

/**
 * Snapshot + live backend state (dim-app's convention): GET `api/state/<key>` (or `url`), then re-GET whenever the
 * backend's stateChanged(key) announces a change on the frontend topic `state/<key>`, and after a reconnect.
 */
export function useBackendState<T = any>(
    key: string | null | undefined,
    { url, topic, initial, debounceMs = 100, fetch: fetchImpl }: UseBackendStateOptions<T> = {},
): [T | undefined, BackendStateStatus] {
    const source = useDataSource()
    const [snapshot, setSnapshot] = useState<{ data: T | undefined; loading: boolean; error: Error | null }>({
        data: initial,
        loading: true,
        error: null,
    })
    const href = url ?? `api/state/${key}` // dimos-yaml-check: ignore (an app that calls useBackendState lists it)
    const generation = useRef(0)
    const refresh = useCallback(async () => {
        const mine = ++generation.current
        try {
            const response = await (fetchImpl ?? globalThis.fetch)(new URL(href, globalThis.location?.href).href)
            if (!response.ok) {
                throw new Error(`GET ${href}: HTTP ${response.status}`)
            }
            const data = await response.json()
            if (mine === generation.current) {
                setSnapshot({ data, loading: false, error: null })
            }
        } catch (error) {
            if (mine === generation.current) {
                setSnapshot((old) => ({ ...old, loading: false, error: error as Error }))
            }
        }
    }, [href, fetchImpl])
    useEffect(() => {
        if (!key && !url) {
            return
        }
        refresh()
        let timer: ReturnType<typeof setTimeout> | undefined
        const later = () => {
            clearTimeout(timer)
            timer = setTimeout(refresh, debounceMs)
        }
        const off = source.subscribeFrontend(topic ?? `state/${key}`, later)
        const offReconnect = source.onReconnect?.(later)
        return () => {
            clearTimeout(timer)
            off()
            offReconnect?.()
        }
    }, [source, key, href, topic, debounceMs, refresh])
    return [snapshot.data, { loading: snapshot.loading, error: snapshot.error, refresh }]
}
