// The page's zenoh-gateway lease (gateway >= 0.5.16, Desktop >= 0.2.185) on DRIVING only: the keys this page sends
// commands on (drive twists, Joy, the profile's controls, the arm's joint / gripper / end-effector commands, a clicked
// point). Watching needs none, so every viewer gets the cameras, clouds and tf. It's taken on the first command (not at
// load), so opening another viewer doesn't take driving away; the newest viewer to drive wins, and the one it took over
// says "another viewer is driving" until it drives again. A gateway without leases leaves the page working as before.
import { Store } from "./store.ts"

/** one name for every dim-controller page, so two drivers conflict even before their keys do */
export const LEASE_GROUP = "dim-controller"
/**
 * How long the lease outlives a silent heartbeat (zenoh-gateway >= 0.5.17's per-lease `timeoutMs`; the server caps it at
 * 60 s): wifi stalls of a few seconds keep it, while driving's deadman keeps the connection's tight 0.4 s deadline.
 */
export const LEASE_TIMEOUT_MS = 5000
/**
 * Taken over, a command takes the lease back only after this long without one: a new press, not the hold (or the
 * release's second of zeros) that was going when the other viewer took it, so two drivers don't trade it every tick.
 */
export const RETAKE_AFTER_IDLE_MS = 1500

/** Said once when the gateway doesn't apply `timeoutMs` (before 0.5.17: the lease ends with the connection's deadline). */
export const NO_LEASE_TIMEOUT_NOTE = "lease follows the 0.4 s heartbeat on this gateway (zenoh-gateway < 0.5.17), so a wifi stall can lapse it"

/**
 * What a lost lease means: another viewer took it ("takenOver", force-expiry), the link dropped it (heartbeat,
 * disconnect, maxSeconds: the next command takes it again), or we replaced or released it ourselves (ignore).
 */
export function afterLost(reason: string): "takenOver" | "lapsed" | "ignore" {
    if (reason === "renewed" || reason === "released") {
        return "ignore"
    }
    if (reason === "takenOver" || reason.startsWith("force-expired")) {
        return "takenOver"
    }
    return "lapsed"
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
 * Keeps the page's drive lease: `command(key)` before each command takes it when it isn't held (and adds the key),
 * a held one is renewed when the keys change, and a lost one waits for the next command.
 */
export class LeaseKeeper {
    readonly state = new Store<LeaseState>({ status: "off", reason: null })
    #client: LeaseClient | null = null
    #handle: LeaseHandle | null = null
    /** the drive topics (setPublish), known before anything is sent */
    #declared: string[] = []
    /** every other key a command went out on */
    #used = new Set<string>()
    #publish: string[] = []
    #taking: Promise<boolean> | null = null
    /** a take asked for while one was in flight (new keys): runs once that one ends */
    #again = false
    #lastCommandAt = -Infinity
    #notedNoTimeout = false

    constructor(readonly now: () => number = () => performance.now()) {}

    /** The drive's topics; a held lease is renewed with them. */
    setPublish(keys: string[]) {
        this.#declared = keys
        this.#updateKeys()
    }

    get publish(): string[] {
        return this.#publish
    }

    #updateKeys() {
        const sorted = [...new Set([...this.#declared, ...this.#used])].sort()
        if (sorted.join("\n") === this.#publish.join("\n")) {
            return
        }
        this.#publish = sorted
        if (this.#client && ["held", "taking"].includes(this.state.get().status)) {
            void this.take(this.#client)
        }
    }

    /**
     * A command is going out on `key`: the key joins the lease, and a lease not held is taken (taken over: only after
     * RETAKE_AFTER_IDLE_MS without a command). The command itself goes now; the gateway drops it while another holds it.
     */
    command(client: LeaseClient | null, key: string) {
        const now = this.now()
        const idle = now - this.#lastCommandAt
        this.#lastCommandAt = now
        if (!client) {
            return
        }
        this.#client = client
        if (!this.#used.has(key) && !this.#declared.includes(key)) {
            this.#used.add(key)
            this.#updateKeys()
        }
        const status = this.state.get().status
        if (status === "off" || (status === "takenOver" && idle >= RETAKE_AFTER_IDLE_MS)) {
            void this.take(client)
        }
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
                    if (!this.#again || this.state.get().status !== "held") {
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
            const handle = await client.lease({ group: LEASE_GROUP, publish: this.#publish, subscribe: [], allowTakeover: true, timeoutMs: LEASE_TIMEOUT_MS })
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
                // the link dropped or stalled mid-request: the next command asks again
                this.state.set({ status: "off", reason: message })
            } else {
                console.warn("[lease] the gateway refused the lease; driving goes unleased", message)
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
        this.state.set(action === "takenOver" ? { status: "takenOver", reason } : { status: "off", reason })
    }

    /** A new gateway session (Reconnect): the old one's lease went with it; the next command takes it again. */
    sessionReplaced() {
        this.#handle = null
        if (["held", "taking"].includes(this.state.get().status)) {
            this.state.set({ status: "off", reason: "reconnected" })
        }
    }

    /** "Take control back": takes the lease over from the viewer driving now. */
    takeBack(client: LeaseClient): Promise<boolean> {
        return this.take(client)
    }
}
