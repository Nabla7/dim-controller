// The page's one connection to Desktop's zenoh-gateway (dimos-react's zenoh source: dim-app's shared connection, which
// the backend's events and every 3D layer ride too), the heartbeat driving needs, the link's latency, Reconnect, and
// topic discovery. dimos names a channel `dimos/<topic>/<msg type>`, so the key itself says what a topic carries.
import { dimosKey as libraryDimosKey, parseKey as libraryParseKey, zenohSource } from "dimos-react"
import { Store } from "./settings.ts"

/** `dimos/<name>/<type>` → Topic; anything else → null. */
export const parseKey = libraryParseKey as (key: string) => Topic | null
/** The key dimos uses for a topic of a type. */
export const dimosKey = libraryDimosKey as (topic: string, type: string) => string

// deno-lint-ignore no-explicit-any
export type Message = any
// deno-lint-ignore no-explicit-any
export type SubscribeOptions = Record<string, any>
// deno-lint-ignore no-explicit-any
export type SubscriptionUpdate = Record<string, any>
// deno-lint-ignore no-explicit-any
export type GatewayClient = any
// deno-lint-ignore no-explicit-any
export type Publisher = any

/** zenoh-gateway's publisher priorities (its wire values). */
export const Priority = Object.freeze({ REAL_TIME: 1, INTERACTIVE_HIGH: 2, INTERACTIVE_LOW: 3, DATA_HIGH: 4, DATA: 5, DATA_LOW: 6 })

/** Calling it unsubscribes; `update` changes the running subscription's options in place (same channel and video track). */
export type LiveHandle = (() => void) & { update(changes: SubscriptionUpdate): Promise<void> }

export interface Topic {
    /** the full zenoh key, e.g. dimos/lidar/sensor_msgs.PointCloud2 */
    key: string
    /** the dimos topic name, e.g. /lidar */
    name: string
    /** the message type, e.g. sensor_msgs.PointCloud2 */
    type: string
}

export interface ConnectionState {
    state: "connecting" | "connected" | "degraded" | "lost"
    topics: Topic[]
    droppedPerSecond: number
    rttMs: number | null
    error: string | null
}

/** Ten beats a second; the gateway fires a publisher's deadman after `heartbeatMisses` silent beats. */
export const HEARTBEAT_HZ = 10
const DISCOVERY_MS = 2000
/** A topic stays listed this long after discovery last saw it: a slow publisher (a 0.5 Hz map) can miss a round's probe. */
export const TOPIC_FORGET_MS = 20000

/** Folds one discovery round into `lastSeen` (key → topic and when it was last found) and returns the topics still listed. */
export function rememberTopics(lastSeen: Map<string, { topic: Topic; at: number }>, found: Topic[], now: number, forgetMs = TOPIC_FORGET_MS): Topic[] {
    for (const topic of found) {
        lastSeen.set(topic.key, { topic, at: now })
    }
    for (const [key, seen] of lastSeen) {
        if (now - seen.at > forgetMs) {
            lastSeen.delete(key)
        }
    }
    return [...lastSeen.values()].map((seen) => seen.topic).sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
}

export class Connection {
    client: GatewayClient | null = null
    readonly status = new Store<ConnectionState>({ state: "connecting", topics: [], droppedPerSecond: 0, rttMs: null, error: null })
    /** the data source every dimos-react hook and layer reads through (the same shared connection) */
    // deno-lint-ignore no-explicit-any
    readonly source: any
    #lastDropped = 0
    /** the last RTT sample seen and when (performance.now()): a link that stops answering stops changing it */
    #lastRtt: { value: number | null; at: number } = { value: null, at: 0 }
    #reconnecting: Promise<void> | null = null

    /** Makes the page's shared connection (the first one made: its options win), with the heartbeat drive needs. */
    constructor(deadmanMs = 400) {
        const heartbeatMisses = Math.max(2, Math.round((deadmanMs / 1000) * HEARTBEAT_HZ))
        this.source = zenohSource({ connectOptions: { heartbeatHz: HEARTBEAT_HZ, heartbeatMisses } })
    }

    async start() {
        const client = (await this.source.zenoh.ready).client
        this.client = client
        this.status.update({ state: "connected", error: null })
        client.onState((state: ConnectionState["state"]) => this.status.update({ state }))
        setInterval(() => {
            const dropped = Object.values(client.stats as Record<string, { dropped?: number }>).reduce((sum, stats) => sum + (stats.dropped || 0), 0)
            this.status.update({ droppedPerSecond: dropped - this.#lastDropped, rttMs: client.rttMs ?? null })
            this.#lastDropped = dropped
        }, 1000)
        this.#lastRtt = { value: client.rttMs ?? null, at: performance.now() }
        const lastSeen = new Map<string, { topic: Topic; at: number }>()
        for (;;) {
            try {
                const found: { key: string }[] = await client.listTopics("dimos/**", { probeMs: 800 })
                const topics = rememberTopics(lastSeen, found.map((topic) => parseKey(topic.key) as Topic | null).filter((topic): topic is Topic => topic !== null), Date.now())
                const before = this.status.get().topics
                if (topics.length !== before.length || topics.some((topic, index) => topic.key !== before[index].key)) {
                    this.status.update({ topics })
                }
            } catch {
                // the gateway is reconnecting; the next round tries again
            }
            await new Promise((resolve) => setTimeout(resolve, DISCOVERY_MS))
        }
    }

    /**
     * The control link's latency now (ms): the heartbeat's round trip, or, once replies stop coming, how long since the
     * last one (a stalled link keeps its last RTT forever). Null before the first sample.
     */
    latencyMs(now = performance.now()): number | null {
        const client = this.client
        if (!client || this.#reconnecting) {
            return null
        }
        const rtt = client.rttMs ?? null
        if (rtt !== this.#lastRtt.value) {
            this.#lastRtt = { value: rtt, at: now }
        }
        if (rtt === null) {
            return null
        }
        const heartbeat = client.options?.heartbeatHz ?? 0
        // without a heartbeat RTT is sampled only now and then, so its age says nothing
        const silence = heartbeat > 0 ? now - this.#lastRtt.at - 1000 / heartbeat : 0
        return Math.max(rtt, silence)
    }

    /**
     * Drops the gateway session and opens a new one the way the first connect does (the client's _open: a new peer,
     * every subscription and publisher re-attached, declarations remade). If that fails the client keeps retrying.
     */
    reconnect(): Promise<void> {
        const client = this.client
        if (!client) {
            return Promise.resolve()
        }
        this.#reconnecting ??= (async () => {
            this.status.update({ state: "connecting", rttMs: null })
            // the old peer's close events come after _open bumps the client's generation, so they're ignored
            client._peer?.close()
            try {
                await client._open()
            } finally {
                this.#lastRtt = { value: client.rttMs ?? null, at: performance.now() }
                this.status.update({ state: client.state, rttMs: client.rttMs ?? null })
                this.#reconnecting = null
            }
        })()
        return this.#reconnecting
    }

    /** Subscribes (now, or once connected); the returned function unsubscribes, its `update` changes the options in place. */
    subscribe(key: string, options: SubscribeOptions, onMessage: (message: Message) => void): LiveHandle {
        return this.source.subscribe(key, options, onMessage)
    }

    /** Gateway clock now (ms), the clock message timestamps are in. */
    bridgeNow(): number {
        return this.client ? this.source.now() : performance.timeOrigin + performance.now()
    }
}
