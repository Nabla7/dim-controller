// The page's one connection to Desktop's zenoh-gateway (dim-app's getZenoh(): the backend's events ride it too), and
// topic discovery. dimos names a channel
// `dimos/<topic>/<msg type>`, so the key itself says what a topic carries.
import { connect, type Message, Priority, type Publisher, type SubscribeOptions, type Subscription, type SubscriptionUpdate, type ZenohGateway } from "dimos-react/dim-app/vendor/zenoh-gateway/zenoh_gateway.js"
import { getZenoh } from "dimos-react/dim-app/zenoh.js"
import { Store } from "./store.ts"
import { NetHistory, wireCounts, type WireCounts } from "./netHistory.ts"
import { isLeasedKey, isLeaseRejection, LeaseKeeper, type LeaseClient } from "./lease.ts"
import { applyOverride, bandwidthOverrides, defaultBandwidthPriority, isVideoOptions, optionDiff, type StreamOverride, withChanges } from "./bandwidth.ts"

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
    /** bytes per second reaching this page over the wire (the WebRTC transport's received bytes), else the gateway's own count; null before the first sample */
    throughputBytesPerSec: number | null
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

/** Bytes per second the gateway got through to this page: its delivered data plus the video it sent (null without stats). */
export function throughputOf(stats: Record<string, Record<string, unknown> | null> | null): number | null {
    const bandwidth = stats?.bandwidth
    const delivered = bandwidth?.deliveredBytesPerSec
    if (typeof delivered !== "number") {
        return null
    }
    const video = bandwidth?.videoSentBytesPerSec
    return delivered + (typeof video === "number" ? video : 0)
}

/** The page's WebRTC counters so far (core/netHistory.ts): the wire's bytes (data, video and overhead) and each part's; null without a connection. */
export async function peerCounts(peer: RTCPeerConnection | null | undefined): Promise<WireCounts | null> {
    if (!peer || peer.connectionState === "closed") {
        return null
    }
    return wireCounts(await peer.getStats())
}

/** Bytes the page's WebRTC transport has received so far (wire bytes: data, video and overhead); null without a connection. */
export async function transportBytesReceived(peer: RTCPeerConnection | null | undefined): Promise<number | null> {
    return (await peerCounts(peer))?.wire ?? null
}

/** What the page subscribes to on one key (the Network modal's Bandwidth Consumers): every subscription the app holds on it, paused or not. */
export interface Consumer {
    subscriptions: number
    /** the app's own options (the first subscription's), before this viewer's override */
    base: SubscribeOptions
    /** a video track (delivery stays "latest"; maxBitrate applies) */
    video: boolean
}

export class Connection {
    client: ZenohGateway | null = null
    readonly status = new Store<ConnectionState>({ state: "connecting", topics: [], droppedPerSecond: 0, rttMs: null, throughputBytesPerSec: null, error: null })
    #subscriptions = new Set<LiveSubscription>()
    #lastDropped = 0
    #shared: ReturnType<typeof getZenoh>
    /** the last RTT sample seen and when (performance.now()): a link that stops answering stops changing it */
    #lastRtt: { value: number | null; at: number } = { value: null, at: 0 }
    #reconnecting: Promise<void> | null = null
    /** the last few minutes of throughput, latency and each stream's rate (the Network panel), sampled from start */
    readonly network = new NetHistory()
    /** the page's lease on the cameras, point clouds and drive topics (core/lease.ts) */
    readonly lease = new LeaseKeeper(() => this.#leaseRejection())
    /** leased subscriptions wait for the first lease attempt (a page without the lease is refused there) */
    #leaseTried = false
    /** while taking control back, our old rejected subscriptions don't mean a new takeover */
    #takingBack = false
    /** topic key → the page's subscriptions on it (core/bandwidth.ts's overrides apply under each) */
    readonly consumers = new Store<Record<string, Consumer>>({})
    /** topic key → messages the gateway dropped for the link in the last second (queue full, too old, part-sent), and since subscribing */
    readonly drops = new Store<Record<string, { perSecond: number; total: number }>>({})

    /**
     * Makes the page's shared connection (the first getZenoh() call: its options win), with the heartbeat drive needs;
     * its deadline (misses / hz, e.g. 0.4 s) is also the lease's, which the gateway caps at 60 s.
     */
    constructor(deadmanMs = 400) {
        const heartbeatMisses = Math.max(2, Math.round((deadmanMs / 1000) * HEARTBEAT_HZ))
        this.#shared = getZenoh({ connect: connect as never, connectOptions: { heartbeatHz: HEARTBEAT_HZ, heartbeatMisses } })
        bandwidthOverrides.subscribe(() => this.#overridesChanged())
    }

    /** This viewer changed a stream's override (Network → Bandwidth Consumers): each subscription on its key takes it. */
    #overridesChanged() {
        const overrides = bandwidthOverrides.get()
        for (const subscription of this.#subscriptions) {
            subscription.setOverride(overrides[subscription.key])
        }
        this.#refreshConsumers()
    }

    #refreshConsumers() {
        const consumers: Record<string, Consumer> = {}
        for (const subscription of this.#subscriptions) {
            const consumer = consumers[subscription.key]
            if (consumer) {
                consumer.subscriptions++
                consumer.video ||= subscription.video
            } else {
                consumers[subscription.key] = { subscriptions: 1, base: subscription.base, video: subscription.video }
            }
        }
        if (JSON.stringify(consumers) !== JSON.stringify(this.consumers.get())) {
            this.consumers.set(consumers)
        }
    }

    /** The client a subscription on `key` may open on now: connected, and for a leased key once the lease was tried. */
    #openable(key: string): ZenohGateway | null {
        return this.client && (this.#leaseTried || !isLeasedKey(key)) ? this.client : null
    }

    async start() {
        const client = (await this.#shared.ready).client as ZenohGateway
        this.client = client
        this.status.update({ state: "connected", error: null })
        client.onState((state) => {
            this.status.update({ state })
            if (state === "connected") {
                this.lease.onConnected(client as unknown as LeaseClient)
            }
        })
        for (const subscription of this.#subscriptions) {
            if (!isLeasedKey(subscription.key)) {
                subscription.open(client)
            }
        }
        // the lease before the cameras and clouds: a newer viewer's lease would refuse them
        await this.lease.take(client as unknown as LeaseClient)
        this.#leaseTried = true
        for (const subscription of this.#subscriptions) {
            if (isLeasedKey(subscription.key)) {
                subscription.open(client)
            }
        }
        this.#refreshConsumers()
        let lastWire: { bytes: number; at: number } | null = null
        setInterval(async () => {
            const dropped = Object.values(client.stats).reduce((sum, stats) => sum + (stats.dropped || 0), 0)
            // the gateway counts payload before it is compressed and framed, so the wire is the true rate
            const counts = await peerCounts((client as unknown as { _peer?: RTCPeerConnection | null })._peer).catch(() => null)
            const bytes = counts?.wire ?? null
            const now = performance.now()
            const wire = bytes !== null && lastWire !== null && bytes >= lastWire.bytes ? ((bytes - lastWire.bytes) * 1000) / (now - lastWire.at) : null
            lastWire = bytes === null ? null : { bytes, at: now }
            this.status.update({ droppedPerSecond: dropped - this.#lastDropped, rttMs: client.rttMs ?? null, throughputBytesPerSec: wire ?? throughputOf(client.gatewayStats) })
            this.#lastDropped = dropped
            this.#sampleDrops(client)
            this.network.sample(now, counts, this.latencyMs(now))
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
            this.status.update({ state: "connecting", rttMs: null, throughputBytesPerSec: null })
            // the old peer's close events come after _open bumps the client's generation, so they're ignored
            client._peer?.close()
            try {
                await client._open()
                this.lease.sessionReplaced(client as unknown as LeaseClient)
            } finally {
                this.#lastRtt = { value: client.rttMs ?? null, at: performance.now() }
                this.status.update({ state: client.state, rttMs: client.rttMs ?? null })
                this.#reconnecting = null
            }
        })()
        return this.#reconnecting
    }

    /**
     * Subscribes now or once connected (not while this viewer paused the key in Network); the returned function
     * unsubscribes, its `update` changes the options in place. This viewer's override for the key (core/bandwidth.ts)
     * applies on top of `options`, now and whenever it changes.
     */
    subscribe(key: string, options: SubscribeOptions, onMessage: (message: Message) => void): LiveHandle {
        const tier = options.bandwidthPriority === undefined ? defaultBandwidthPriority(parseKey(key)?.type ?? "") : undefined
        if (tier !== undefined) {
            options = { ...options, bandwidthPriority: tier }
        }
        const subscription: LiveSubscription = new LiveSubscription(key, options, onMessage, (reason) => this.#rejected(subscription, reason), () => this.#openable(key), bandwidthOverrides.get()[key])
        this.#subscriptions.add(subscription)
        const client = this.#openable(key)
        if (client) {
            subscription.open(client)
        }
        this.#refreshConsumers()
        const unsubscribe = () => {
            this.#subscriptions.delete(subscription)
            subscription.close()
            this.#refreshConsumers()
        }
        // the app's own option changes show in Bandwidth Consumers as its defaults
        const update = (changes: SubscriptionUpdate) => subscription.update(changes).finally(() => this.#refreshConsumers())
        return Object.assign(unsubscribe, { update })
    }

    /** Each stream's link drops from the gateway's own counts: not its maxHz thinning, which is asked for. */
    #sampleDrops(client: ZenohGateway) {
        const previous = this.drops.get()
        const next: Record<string, { perSecond: number; total: number }> = {}
        for (const [key, stats] of Object.entries(client.stats as Record<string, { gateway?: { stats?: Record<string, unknown> } | null }>)) {
            const counts = stats.gateway?.stats
            if (!counts) {
                continue
            }
            const total = ["droppedQueue", "droppedAge", "abandonedPartial"].reduce((sum, name) => sum + Number(counts[name] ?? 0), 0)
            next[key] = { total, perSecond: Math.max(0, total - (previous[key]?.total ?? total)) }
        }
        if (JSON.stringify(next) !== JSON.stringify(previous)) {
            this.drops.set(next)
        }
    }

    /** A subscription the gateway ended or refused: another viewer's lease means that viewer took over. */
    #rejected(subscription: LiveSubscription, reason: string) {
        if (!this.#takingBack && isLeasedKey(subscription.key) && isLeaseRejection(reason)) {
            this.lease.subscriptionRejected(reason)
        }
    }

    /** Why one of our leased subscriptions was ended or refused for another viewer's lease, else null. */
    #leaseRejection(): string | null {
        for (const subscription of this.#subscriptions) {
            const reason = subscription.rejection
            if (reason !== null && isLeasedKey(subscription.key) && isLeaseRejection(reason)) {
                return reason
            }
        }
        return null
    }

    /**
     * "Take control back": takes the lease over from the newer viewer, then subscribes again where it had ended ours
     * (the client doesn't re-open a rejected subscription). Resolves whether the lease is ours again.
     */
    async takeBack(): Promise<boolean> {
        const client = this.client
        if (!client) {
            return false
        }
        this.#takingBack = true
        try {
            if (!(await this.lease.takeBack(client as unknown as LeaseClient))) {
                return false
            }
            for (const subscription of this.#subscriptions) {
                if (subscription.rejection !== null) {
                    subscription.close()
                    subscription.open(client)
                }
            }
            return true
        } finally {
            this.#takingBack = false
        }
    }

    /** Gateway clock now (ms), the clock message timestamps are in. */
    bridgeNow(): number {
        const client = this.client
        return client ? client.now() + (client.clockOffsetMs ?? 0) : performance.timeOrigin + performance.now()
    }
}

/**
 * One subscription the app holds: its own options (`base`) with this viewer's override on top (core/bandwidth.ts).
 * Paused, it has no gateway subscription; unpaused it opens again. An override or app change goes in place where the
 * gateway can (Subscription.update), else as a new subscription (closed, then opened: delivery can't change in place).
 */
export class LiveSubscription {
    #handle: Subscription | null = null
    /** the options the open gateway subscription runs with */
    #running: SubscribeOptions = {}
    #override: StreamOverride | undefined
    /**
     * `openable()`: the client to open on now, or null (not connected, or the lease not tried yet: Connection opens it
     * then); `override`: this viewer's for the key.
     */
    constructor(
        readonly key: string,
        public base: SubscribeOptions,
        readonly onMessage: (message: Message) => void,
        readonly onRejected: (reason: string) => void,
        readonly openable: () => ZenohGateway | null,
        override?: StreamOverride,
    ) {
        this.#override = override
    }
    get paused(): boolean {
        return !!this.#override?.paused
    }
    get video(): boolean {
        return isVideoOptions(this.base, this.#handle?.channelName)
    }
    /** what it runs with (or will when opened): the app's options, the override on top */
    get options(): SubscribeOptions {
        return applyOverride(this.base, this.#override, this.video)
    }
    get isOpen(): boolean {
        return this.#handle !== null
    }
    open(client: ZenohGateway) {
        if (this.paused || this.#handle) {
            return
        }
        this.#running = this.options
        const handle = client.subscribe(this.key, this.#running, this.onMessage)
        this.#handle = handle
        // refused when it opens (another viewer holds the lease); one ended later comes with the lease's onLost("takenOver")
        handle.ready().catch(() => handle === this.#handle && handle.rejectionReason !== null && this.onRejected(handle.rejectionReason))
    }
    /** why the gateway refused or ended it, else null */
    get rejection(): string | null {
        return this.#handle?.state === "rejected" ? this.#handle.rejectionReason : null
    }
    /** The app's change (zenoh-gateway >= 0.5.1: in place); a refused update throws, so the caller can resubscribe. */
    async update(changes: SubscriptionUpdate) {
        this.base = withChanges(this.base, changes)
        await this.#apply()
    }
    /** This viewer's override changed: pause, resume, or run with the new options (a refused update resubscribes). */
    setOverride(override: StreamOverride | undefined) {
        if (JSON.stringify(override) === JSON.stringify(this.#override)) {
            return
        }
        this.#override = override
        this.#apply().catch((error) => {
            console.warn(`[bandwidth] ${this.key}: the gateway refused the change (${error?.message ?? error}); resubscribing`)
            this.#reopen()
        })
    }
    async #apply() {
        if (this.paused) {
            this.close()
            return
        }
        const handle = this.#handle
        if (!handle) {
            const client = this.openable()
            if (client) {
                this.open(client)
            }
            return
        }
        const next = this.options
        const { update, resubscribe } = optionDiff(this.#running, next)
        if (resubscribe) {
            return this.#reopen()
        }
        if (!Object.keys(update).length) {
            return
        }
        this.#running = next
        await handle.update(update)
    }
    #reopen() {
        const client = this.openable()
        this.close()
        if (client) {
            this.open(client)
        }
    }
    close() {
        this.#handle?.close()
        this.#handle = null
    }
}
