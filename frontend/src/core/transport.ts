// The page's one connection to Desktop's zenoh-gateway (dim-app's getZenoh(): the backend's events ride it too), and
// topic discovery. dimos names a channel
// `dimos/<topic>/<msg type>`, so the key itself says what a topic carries.
import { connect, type Message, Priority, type Publisher, type SubscribeOptions, type Subscription, type SubscriptionUpdate, type ZenohGateway } from "../vendor/zenoh_gateway/zenoh_gateway.ts"
import { getZenoh } from "../dim-app/source/zenoh.js"
import { Store } from "./store.ts"

export { Priority }
export type { Message, Publisher, SubscribeOptions, SubscriptionUpdate }

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

/** `dimos/<name>/<type>` → Topic; anything else (wildcards, other prefixes) → null. */
export function parseKey(key: string): Topic | null {
    const parts = key.split("/")
    if (parts.length < 3 || parts[0] !== "dimos" || key.includes("*")) {
        return null
    }
    const type = parts[parts.length - 1]
    if (!/^\w+\.\w+$/.test(type)) {
        return null
    }
    return { key, name: "/" + parts.slice(1, -1).join("/"), type }
}

/** The key dimos's zenoh transport uses for a topic of a type. */
export const dimosKey = (topic: string, type: string) => `dimos/${topic.replace(/^\/+/, "")}/${type}`

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
    client: ZenohGateway | null = null
    readonly status = new Store<ConnectionState>({ state: "connecting", topics: [], droppedPerSecond: 0, rttMs: null, error: null })
    #subscriptions = new Set<LiveSubscription>()
    #lastDropped = 0
    #shared: ReturnType<typeof getZenoh>
    /** the last RTT sample seen and when (performance.now()): a link that stops answering stops changing it */
    #lastRtt: { value: number | null; at: number } = { value: null, at: 0 }
    #reconnecting: Promise<void> | null = null

    /** Makes the page's shared connection (the first getZenoh() call: its options win), with the heartbeat drive needs. */
    constructor(deadmanMs = 400) {
        const heartbeatMisses = Math.max(2, Math.round((deadmanMs / 1000) * HEARTBEAT_HZ))
        this.#shared = getZenoh({ connect: connect as never, connectOptions: { heartbeatHz: HEARTBEAT_HZ, heartbeatMisses } })
    }

    async start() {
        const client = (await this.#shared.ready).client as ZenohGateway
        this.client = client
        this.status.update({ state: "connected", error: null })
        client.onState((state) => this.status.update({ state }))
        for (const subscription of this.#subscriptions) {
            subscription.open(client)
        }
        setInterval(() => {
            const dropped = Object.values(client.stats).reduce((sum, stats) => sum + (stats.dropped || 0), 0)
            this.status.update({ droppedPerSecond: dropped - this.#lastDropped, rttMs: client.rttMs ?? null })
            this.#lastDropped = dropped
        }, 1000)
        this.#lastRtt = { value: client.rttMs ?? null, at: performance.now() }
        const lastSeen = new Map<string, { topic: Topic; at: number }>()
        for (;;) {
            try {
                const found = await client.listTopics("dimos/**", { probeMs: 800 })
                const topics = rememberTopics(lastSeen, found.map((topic) => parseKey(topic.key)).filter((topic): topic is Topic => topic !== null), Date.now())
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

    /** Subscribes now or once connected; the returned function unsubscribes, its `update` changes the options in place. */
    subscribe(key: string, options: SubscribeOptions, onMessage: (message: Message) => void): LiveHandle {
        const subscription = new LiveSubscription(key, options, onMessage)
        this.#subscriptions.add(subscription)
        if (this.client) {
            subscription.open(this.client)
        }
        const unsubscribe = () => {
            this.#subscriptions.delete(subscription)
            subscription.close()
        }
        return Object.assign(unsubscribe, { update: (changes: SubscriptionUpdate) => subscription.update(changes) })
    }

    /** Gateway clock now (ms), the clock message timestamps are in. */
    bridgeNow(): number {
        const client = this.client
        return client ? client.now() + (client.clockOffsetMs ?? 0) : performance.timeOrigin + performance.now()
    }
}

class LiveSubscription {
    #handle: Subscription | null = null
    constructor(readonly key: string, public options: SubscribeOptions, readonly onMessage: (message: Message) => void) {}
    open(client: ZenohGateway) {
        this.#handle = client.subscribe(this.key, this.options, this.onMessage)
    }
    /** zenoh-gateway >= 0.5.1: the running subscription takes the new options; before it opens, it opens with them. */
    async update(changes: SubscriptionUpdate) {
        if (this.#handle) {
            await this.#handle.update(changes)
            this.options = this.#handle.options
            return
        }
        const options: Record<string, unknown> = { ...this.options }
        for (const [name, value] of Object.entries(changes)) {
            if (value === null) {
                delete options[name]
            } else {
                options[name] = name === "encodeOptions" ? { ...this.options.encodeOptions, ...(value as object) } : value
            }
        }
        this.options = options as SubscribeOptions
    }
    close() {
        this.#handle?.close()
        this.#handle = null
    }
}
