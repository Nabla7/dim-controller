// One entry per discovered topic that some layer type draws (the Controller's layer list): an enabled entry gets a
// live instance inside <TopicLayers> (subscribed), a disabled one has none (unsubscribed, so it costs no bandwidth).
// Which topics are on and each topic's settings persist through `persist(key, defaults)` (localStorage by default;
// an app that keeps settings in its backend passes its own).
import { parseKey } from "../../data.ts"
import type { DataSource, ListedTopic, Topic } from "../../data.ts"
import { localStore, Store } from "../store.ts"
import { defaultSettings, layerTypeFor } from "./registry.ts"
import type { LayerStatus, LayerType } from "./registry.ts"

/** A topic's settings bag: whatever its layer type keeps (see LayerType's `S`). */
export interface LayerEntry {
    topic: Topic
    type: LayerType
    enabled: boolean
    status: LayerStatus
    // deno-lint-ignore no-explicit-any -- a layer's settings, whatever its type declares
    settings: Store<any>
}

/** Saves a Store under `key` (fields missing from what's saved come from `defaults`); localStore by default. */
export type Persist = <T extends object>(key: string, defaults: T) => Store<T>

export interface LayerManagerOptions {
    source: DataSource
    persist?: Persist
    storagePrefix?: string
    forgetMs?: number
}

/** A listed topic that already says its name and type. */
const isTopic = (item: ListedTopic): item is ListedTopic & Topic =>
    !!item.name && !!item.type && typeof item.name === "string" && typeof item.type === "string"

export class LayerManager {
    entries: Store<{ list: LayerEntry[] }> = new Store<{ list: LayerEntry[] }>({ list: [] })
    /** every topic seen (drawn or not), sorted by name */
    topics: Store<{ list: Topic[] }> = new Store<{ list: Topic[] }>({ list: [] })
    /** the 3D view is off: no layer runs (nothing subscribed); the switches keep what to start again */
    paused: Store<{ paused: boolean }> = new Store({ paused: false })
    /** topic key → switched on, as saved */
    #enabled: Store<Record<string, boolean>>
    #persist: Persist
    #prefix: string
    #lastSeen: Map<string, { topic: Topic; at: number }> = new Map()
    forgetMs: number
    source: DataSource

    constructor({
        source,
        persist = localStore,
        storagePrefix = "dimos-react.layers",
        forgetMs = 20000,
    }: LayerManagerOptions) {
        this.source = source
        this.#persist = persist
        this.#prefix = storagePrefix
        this.forgetMs = forgetMs
        this.#enabled = persist<Record<string, boolean>>(`${storagePrefix}.enabled`, {})
        // turned on or off elsewhere (another tab, an agent writing the setting)
        this.#enabled.subscribe(() => {
            for (const entry of this.entries.get().list) {
                const wanted = this.#enabled.get()[entry.topic.key]
                if (wanted !== undefined && wanted !== entry.enabled) {
                    this.#patch(entry.topic.key, { enabled: wanted })
                }
            }
        })
    }

    /** Lists the source's topics now and every `intervalMs` (and on the source's topic events). Returns stop. */
    watch({ filter = "dimos/**", intervalMs = 2000 }: { filter?: string; intervalMs?: number } = {}): () => void {
        let live = true
        let timer: ReturnType<typeof setTimeout> | undefined
        const round = async () => {
            try {
                this.setTopics(await this.source.listTopics(filter))
            } catch {
                // reconnecting: next round
            }
            if (live) {
                timer = setTimeout(round, intervalMs)
            }
        }
        round()
        const offTopics = this.source.onTopics?.(() => {
            clearTimeout(timer)
            round()
        })
        return () => {
            live = false
            clearTimeout(timer)
            offTopics?.()
        }
    }

    /** Topics found (`[{ key }]` or `[{ key, name, type }]`): new drawable ones become entries; gone ones are kept for `forgetMs`. */
    setTopics(found: ListedTopic[]) {
        const now = Date.now()
        for (const item of found) {
            const topic = isTopic(item) ? item : parseKey(item.key)
            if (topic) {
                this.#lastSeen.set(topic.key, { topic, at: now })
            }
        }
        for (const [key, seen] of this.#lastSeen) {
            if (now - seen.at > this.forgetMs) {
                this.#lastSeen.delete(key)
            }
        }
        const all = [...this.#lastSeen.values()]
            .map((seen) => seen.topic)
            .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
        const old = this.topics.get().list
        if (old.length !== all.length || old.some((topic, index) => topic.key !== all[index].key)) {
            this.topics.set({ list: all })
        }
        this.#sync(all)
    }

    #sync(topics: Topic[]) {
        const list = this.entries.get().list
        const known = new Set(list.map((entry) => entry.topic.key))
        const added: LayerEntry[] = []
        for (const topic of topics) {
            const type = layerTypeFor(topic.type)
            if (!type || known.has(topic.key)) {
                continue
            }
            const saved = this.#enabled.get()[topic.key]
            const enabled = saved ?? type.enabledByDefault?.(topic) ?? true
            const settings = this.#persist(`${this.#prefix}.${type.id}.${topic.key}`, defaultSettings(type, topic))
            added.push({ topic, type, enabled, status: {}, settings })
        }
        if (added.length) {
            this.entries.set({ list: [...list, ...added].sort((a, b) => a.topic.name.localeCompare(b.topic.name)) })
        }
    }

    /** Switches a topic's layer on (subscribes) or off (unsubscribes); remembered. */
    setEnabled(key: string, enabled: boolean) {
        this.#enabled.update({ [key]: enabled })
        this.#patch(key, { enabled })
    }

    /** Off: every layer stops; on: the enabled ones start again. */
    setPaused(paused: boolean) {
        if (paused !== this.paused.get().paused) {
            this.paused.set({ paused })
        }
    }

    /** Topics of these types being drawn (e.g. to pick a robot pose source). */
    enabledOfType(...types: string[]): Topic[] {
        return this.entries
            .get()
            .list.filter((entry) => entry.enabled && types.includes(entry.topic.type))
            .map((entry) => entry.topic)
    }

    /** The drawn layers' data frames (for the TF check). */
    layerFrames(): { name: string; frame: string }[] {
        return this.entries
            .get()
            .list.flatMap((entry) =>
                entry.enabled && entry.status.frame ? [{ name: entry.topic.name, frame: entry.status.frame }] : []
            )
    }

    /** A layer reports info / a problem / its frame (only real changes re-render). */
    setStatus(key: string, status: LayerStatus) {
        const current = this.entries.get().list.find((entry) => entry.topic.key === key)?.status
        if (
            !current ||
            (Object.keys(status) as (keyof LayerStatus)[]).some((field) => current[field] !== status[field])
        ) {
            this.#patch(key, { status: { ...current, ...status } })
        }
    }

    /** A layer stopped: its info and problem go with it. */
    clearStatus(key: string) {
        this.#patch(key, { status: {} })
    }

    #patch(key: string, patch: Partial<LayerEntry>) {
        const list = this.entries.get().list
        if (list.some((entry) => entry.topic.key === key)) {
            this.entries.set({ list: list.map((entry) => (entry.topic.key === key ? { ...entry, ...patch } : entry)) })
        }
    }
}
