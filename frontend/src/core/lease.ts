// The page's zenoh-gateway lease (gateway >= 0.5.16, Desktop >= 0.2.185): only the newest viewer pulls the cameras and
// point clouds and drives, so several open viewers don't saturate a weak robot uplink. A newer viewer takes it over;
// this page then says "another viewer took over" and offers to take control back. Other topics (tf, small ones) stay
// shared. A gateway without leases (older Desktop) leaves the page working as before.
import { Store } from "./store.ts"

/** one name for every dim-controller page, so two viewers conflict even before their keys do */
export const LEASE_GROUP = "dim-controller"
/** the heavy streams only the lease holder pulls */
export const LEASED_TYPES = ["sensor_msgs.Image", "sensor_msgs.CompressedImage", "sensor_msgs.PointCloud2"]
export const LEASED_SUBSCRIBE_KEYS = LEASED_TYPES.map((type) => `dimos/**/${type}`)
/** a lease request that timed out on a stalled link is asked again after this long */
const RETRY_MS = 2000
/**
 * How long the lease outlives a silent heartbeat (zenoh-gateway >= 0.5.17's per-lease `timeoutMs`; the server caps it at
 * 60 s): wifi stalls of a few seconds keep it, while driving's deadman keeps the connection's tight 0.4 s deadline.
 */
export const LEASE_TIMEOUT_MS = 5000

/** Said once when the gateway doesn't apply `timeoutMs` (before 0.5.17: the lease ends with the connection's deadline). */
export const NO_LEASE_TIMEOUT_NOTE = "lease follows the 0.4 s heartbeat on this gateway (zenoh-gateway < 0.5.17), so a wifi stall can lapse it"

/** Whether a subscription key is one the lease covers (a dimos key of a leased type). */
export function isLeasedKey(key: string): boolean {
    return key.startsWith("dimos/") && LEASED_TYPES.includes(key.slice(key.lastIndexOf("/") + 1))
}

/** The gateway's reason for ending or refusing a subscription because another client leased its key. */
export function isLeaseRejection(reason: string | null | undefined): boolean {
    return typeof reason === "string" && /is leased by another client/.test(reason)
}

/**
 * What a lost lease means: another viewer took it ("takenOver", force-expiry), the link dropped it (heartbeat,
 * disconnect, maxSeconds: take it again), or we replaced or released it ourselves (ignore).
 */
export function afterLost(reason: string): "takenOver" | "retake" | "ignore" {
    if (reason === "renewed" || reason === "released") {
        return "ignore"
    }
    if (reason === "takenOver" || reason.startsWith("force-expired")) {
        return "takenOver"
    }
    return "retake"
}

export type LeaseStatus = "off" | "taking" | "held" | "takenOver" | "unsupported"

export interface LeaseState {
    status: LeaseStatus
    /** why it was taken over, or why the gateway refused it */
    reason: string | null
    /** the heartbeat silence the gateway lets the lease outlive (ms; 0.5.17+ echoes it), null: the connection's deadline */
    timeoutMs?: number | null
}

/** The part of zenoh-gateway's Lease this uses. */
export interface LeaseHandle {
    onLost(listener: (reason: string) => void): unknown
    /** zenoh-gateway 0.5.17+: the timeoutMs it applies; absent or null on an older gateway */
    timeoutMs?: number | null
}

/** The part of the zenoh-gateway client this uses. */
export interface LeaseClient {
    state: string
    lease(options: { group: string; publish: string[]; subscribe: string[]; allowTakeover: boolean; timeoutMs?: number }): Promise<LeaseHandle>
}

/**
 * Keeps the page's lease: takes it (before the leased subscriptions open), takes it again when the link dropped it,
 * renews it when the drive topics change, and stops at "takenOver" until `takeBack()`.
 */
export class LeaseKeeper {
    readonly state = new Store<LeaseState>({ status: "off", reason: null })
    #client: LeaseClient | null = null
    #handle: LeaseHandle | null = null
    #publish: string[] = []
    #taking: Promise<boolean> | null = null
    /** a take asked for while one was in flight (new drive keys, a drop): runs once that one ends */
    #again = false
    #retry: ReturnType<typeof setTimeout> | undefined
    #notedNoTimeout = false

    /**
     * `rejection()`: why one of our leased subscriptions was ended or refused for another client's lease, else null.
     * Asked before taking a lapsed lease again (a viewer that leased in the gap isn't taken over by itself).
     */
    constructor(readonly rejection: () => string | null = () => null) {}

    /** The drive's publish keys; a held lease is renewed with them. */
    setPublish(keys: string[]) {
        const sorted = [...new Set(keys)].sort()
        if (sorted.join("\n") === this.#publish.join("\n")) {
            return
        }
        this.#publish = sorted
        if (this.#client && ["held", "taking"].includes(this.state.get().status)) {
            void this.take(this.#client)
        }
    }

    get publish(): string[] {
        return this.#publish
    }

    /** Takes (or renews) the lease; resolves whether it's held. Never throws: a gateway that refuses it is "unsupported". */
    take(client: LeaseClient): Promise<boolean> {
        this.#client = client
        if (this.#taking) {
            this.#again = true
            return this.#taking
        }
        this.state.update({ status: "taking" })
        this.#taking = (async () => {
            try {
                for (;;) {
                    this.#again = false
                    const held = await this.#takeOnce(client)
                    if (!this.#again || this.state.get().status === "takenOver") {
                        return held
                    }
                }
            } finally {
                this.#taking = null
            }
        })()
        return this.#taking
    }

    async #takeOnce(client: LeaseClient): Promise<boolean> {
        try {
            // an older client or gateway ignores timeoutMs; 0.5.17 echoes it on the lease when it applies it
            const handle = await client.lease({ group: LEASE_GROUP, publish: this.#publish, subscribe: LEASED_SUBSCRIBE_KEYS, allowTakeover: true, timeoutMs: LEASE_TIMEOUT_MS })
            this.#handle = handle
            handle.onLost((reason) => this.#lost(handle, reason))
            const timeoutMs = typeof handle.timeoutMs === "number" ? handle.timeoutMs : null
            if (timeoutMs === null && !this.#notedNoTimeout) {
                this.#notedNoTimeout = true
                console.info(`[lease] ${NO_LEASE_TIMEOUT_NOTE}`)
            }
            this.state.set({ status: "held", reason: null, timeoutMs })
            return true
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (client.state === "lost" || /connection lost|not connected|timed out/i.test(message)) {
                // the link dropped or stalled mid-request: tried again once it's back (onConnected), or in a moment
                this.state.update({ status: "taking" })
                clearTimeout(this.#retry)
                this.#retry = setTimeout(() => client.state !== "lost" && this.state.get().status === "taking" && void this.#retake(client), RETRY_MS)
            } else {
                console.warn("[lease] the gateway refused the lease; every viewer pulls the streams", message)
                this.state.set({ status: "unsupported", reason: message })
            }
            return false
        }
    }

    #lost(handle: LeaseHandle, reason: string) {
        if (handle !== this.#handle) {
            return
        }
        const action = afterLost(reason)
        if (action === "ignore") {
            return
        }
        this.#handle = null
        if (action === "takenOver") {
            this.state.set({ status: "takenOver", reason })
        } else if (this.#client && this.#client.state !== "lost") {
            void this.#retake(this.#client)
        } else {
            this.state.update({ status: "taking" })
        }
    }

    /** Takes a lapsed lease again, unless a viewer that leased meanwhile has already ended our subscriptions. */
    #retake(client: LeaseClient): Promise<boolean> {
        const rejected = this.rejection()
        if (rejected !== null) {
            this.subscriptionRejected(rejected)
            return Promise.resolve(false)
        }
        return this.take(client)
    }

    /** One of our leased subscriptions was ended or refused for another client's lease: that viewer has them now. */
    subscriptionRejected(reason: string) {
        if (this.state.get().status !== "takenOver") {
            this.#handle = null
            this.state.set({ status: "takenOver", reason })
        }
    }

    /** The gateway session is back (or new): a lease it dropped is taken again, unless another viewer has it. */
    onConnected(client: LeaseClient) {
        this.#client = client
        if (this.state.get().status === "taking" && !this.#taking) {
            void this.#retake(client)
        }
    }

    /** A new gateway session (Reconnect): the old one's lease went with it. */
    sessionReplaced(client: LeaseClient) {
        this.#handle = null
        if (["held", "taking"].includes(this.state.get().status)) {
            void this.take(client)
        }
    }

    /** "Take control back": takes the lease over from the newer viewer. */
    takeBack(client: LeaseClient): Promise<boolean> {
        return this.take(client)
    }
}
