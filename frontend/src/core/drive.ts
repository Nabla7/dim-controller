// Driving: keys, sticks and buttons push axes; while something is held, a Twist goes out at
// publishHz straight through the bridge, on every output topic (auto: core/cmdvel.ts; each with its own deadman). Nothing is
// published while idle, not even a deadman (test/drive.test.ts "idle"): no publisher exists before the first drive input, a
// release sends a second of zeros so the stop is heard, then the deadman is cleared and the topic goes quiet. While moving the bridge holds a zero Twist as a deadman
// and publishes it if this page goes silent for deadmanMs or disconnects (port of web_ctrl's drive loop).
// There is no arming (since 2026-10-05): `armed` is always true. The backend's `drive` events carry the agent's commands
// (and dry runs) for the HUD.
import { encode } from "./lcm/lcm.ts"
import { loadedSetting, persistentStore, Store } from "./store.ts"
import { type Connection, dimosKey, Priority, type Publisher } from "./transport.ts"
import { autoTopics, type DriveTopic, type Module, parseTopics, TWIST, TWIST_STAMPED, zenohKey } from "./cmdvel.ts"
import { type Axes, type Axis, defaultTwist, type RobotProfile, type Twist } from "../profile/types.ts"

const zeroOf = (type: string) => encode(type, {})

export interface DriveSettings {
    linear: number
    angular: number
    vertical: number
    /** the output topics, one per line ("/my_cmd_vel", or "/my_cmd_vel TwistStamped"); [] = auto (core/cmdvel.ts) */
    topics: string[]
    /** before 2026-10-05: one topic ("" = auto); read once into `topics` */
    topic?: string
    /** the joint control's pick (core/baseJoint.ts; unset = a torso or lift joint, else the first) */
    joint?: string
    /** where its targets go ("" = the running coordinator's joint_command); the profile's `joint.commandTopic` by default */
    jointTopic: string
}

export interface DriveState {
    /** always true: driving needs no arming (kept for the arm control and older events) */
    armed: boolean
    axes: Axes
    boost: boolean
    /** what was last sent (or would be) */
    twist: Twist
    /** the topics actually published to (auto, or the settings') */
    topics: DriveTopic[]
    /** the same, for showing: "/cmd_vel, /tele_cmd_vel" */
    topic: string
    publishing: boolean
    sent: number
    error: string | null
    /** the last endpoint command (POST api/drive), shown until it ends */
    command: DriveCommand | null
    /** driving is disengaged (link too slow, or lost) until a reconnect; nothing but the stop goes out */
    halt: DriveHalt | null
    policyBlock: string | null
}

/** Why driving is disengaged: the link's latency went over Settings' max, or the link dropped. */
export interface DriveHalt {
    reason: "latency" | "lost"
    latencyMs: number | null
    maxMs: number
    reconnecting: boolean
}

/** What POST api/drive sent (or would have, for a dry run), as the backend describes it. */
export interface DriveCommand {
    key: string
    linear: [number, number, number]
    angular: [number, number, number]
    seconds: number
    dryRun: boolean
    source: string
}

/** The backend's `drive` event (server/src/api.rs). */
export interface DriveEvent {
    command: DriveCommand | null
}

/** The drive settings' key before robot types (2026-10-05), by the profile that replaced it. */
const LEGACY_DRIVE_KEYS: Partial<Record<RobotProfile["type"], string>> = { dog: "lv.drive.Unitree Go2", wheeled: "lv.drive.Galaxea R1 Pro", drone: "lv.drive.Drone" }

const zeroAxes = (): Axes => ({ forward: 0, strafe: 0, turn: 0, vertical: 0 })

export class Drive {
    readonly state = new Store<DriveState>({ armed: true, axes: zeroAxes(), boost: false, twist: { linear: [0, 0, 0], angular: [0, 0, 0] }, topics: [], topic: "", publishing: false, sent: 0, error: null, command: null, halt: null, policyBlock: null })
    settings: Store<DriveSettings>
    readonly controlValues = new Store<Record<string, number>>({})
    /** axis contributions by source (keys, stick, pad), summed and clamped */
    #sources = new Map<string, Partial<Axes>>()
    /** one publisher per output topic (zenoh key), each with its own deadman */
    #publishers = new Map<string, { publisher: Publisher; deadman: boolean }>()
    /** until when (ms) zeros keep going out after a release: a second by the clock, so a throttled background tab (timers at ~1 Hz) doesn't stretch it to 20 s */
    #stopFlushUntil = 0
    #timer: ReturnType<typeof setInterval>
    #commandTimer: ReturnType<typeof setTimeout> | undefined
    #controlPublishers = new Map<string, Publisher>()
    #unsubscribeSettings = () => {}
    /** called on every stop and halt (the joint jog stops with driving) */
    #stopListeners = new Set<() => void>()
    /** the running blueprints' modules (null = unknown), from Desktop's /dimos/ API */
    #blueprints: Record<string, Module[] | null> = {}
    /** Twist topics seen on the bridge (someone publishes them; maybe nobody reads them) */
    #onBridge: string[] = []

    constructor(readonly connection: Connection, public profile: RobotProfile) {
        this.settings = this.#settingsFor(profile)
        this.#timer = setInterval(() => this.#tick(), 1000 / profile.drive.publishHz)
        this.#useProfile(profile)
    }

    /** lv.drive.<type> (an install from before robot types starts from its profile's, e.g. lv.drive.Unitree Go2). */
    #settingsFor(profile: RobotProfile): Store<DriveSettings> {
        const key = `lv.drive.${profile.type}`
        const legacy = LEGACY_DRIVE_KEYS[profile.type]
        const { speeds } = profile.drive
        const defaults: DriveSettings = { linear: speeds.linear, angular: speeds.angular, vertical: speeds.vertical, topics: [], jointTopic: profile.joint?.commandTopic ?? "" }
        const earlier = !loadedSetting(key) && legacy ? loadedSetting(legacy) : undefined
        const settings = persistentStore<DriveSettings>(key, { ...defaults, ...(earlier ?? {}) })
        const old = settings.get().topic
        if (old && !settings.get().topics?.length) {
            settings.update({ topics: [old], topic: "" })
        }
        return settings
    }

    #useProfile(profile: RobotProfile) {
        this.controlValues.set(Object.fromEntries(profile.controls.filter((control) => control.kind === "slider").map((control) => [control.id, control.kind === "slider" ? control.initial : 0])))
        this.#unsubscribeSettings()
        this.#unsubscribeSettings = this.settings.subscribe(() => this.#refreshTopics())
        this.#refreshTopics()
    }

    /** Another kind of robot (Settings → Robot, or auto changed its mind): stopped first, then its keys, speeds and topics. */
    setProfile(profile: RobotProfile) {
        if (profile === this.profile) {
            return
        }
        this.#sources.clear()
        this.#recompute()
        this.#closeAll()
        this.#controlPublishers.forEach((publisher) => publisher.close())
        this.#controlPublishers.clear()
        this.profile = profile
        this.settings = this.#settingsFor(profile)
        this.#useProfile(profile)
        this.#recompute()
    }

    /** What's running (Desktop's metadata) and the Twist topics on the bridge; auto follows them. */
    setRunning(blueprints: Record<string, Module[] | null>, onBridge: string[] = []) {
        this.#blueprints = blueprints
        this.#onBridge = onBridge
        this.#refreshTopics()
    }

    /** What auto resolves to now. */
    autoTopics(): DriveTopic[] {
        return autoTopics(this.#blueprints)
    }

    /** Topics worth suggesting: auto's, the bridge's Twist topics, the profile's. */
    candidates(): string[] {
        return [...new Set([...this.autoTopics().map((topic) => topic.topic), ...this.#onBridge, ...this.profile.drive.cmdVelTopics])]
    }

    #refreshTopics() {
        const chosen = this.settings.get().topics ?? []
        const topics = chosen.length ? parseTopics(chosen, this.#blueprints) : this.autoTopics()
        const topic = topics.map((each) => each.topic + (each.type === TWIST_STAMPED ? " (stamped)" : "")).join(", ")
        if (topic !== this.state.get().topic) {
            this.state.update({ topics, topic })
        }
    }

    /** The backend's `drive` event: the endpoint's commands (POST api/drive), shown until they end. */
    applyEvent(event: DriveEvent) {
        if (event.command) {
            clearTimeout(this.#commandTimer)
            this.state.update({ command: event.command })
            this.#commandTimer = setTimeout(() => this.state.update({ command: null }), Math.max(1500, event.command.seconds * 1000))
        }
    }

    /** A source (e.g. "keys", "stick") sets its share of the axes; the sum (clamped to ±1) drives. Ignored while halted. */
    setAxes(source: string, axes: Partial<Axes>) {
        if (this.state.get().halt || this.state.get().policyBlock) {
            return
        }
        this.#sources.set(source, axes)
        this.#recompute()
    }

    /** Holds driving (latency over the max, or the link lost): stopped now (the usual zeros if it was moving), input ignored until resume(). */
    halt(halt: Omit<DriveHalt, "reconnecting">) {
        const current = this.state.get().halt
        if (current?.reason === halt.reason) {
            return
        }
        this.state.update({ halt: { ...halt, reconnecting: current?.reconnecting ?? false } })
        this.#sources.clear()
        this.#recompute()
        this.#stopListeners.forEach((listener) => listener())
    }

    /** The reconnect is under way (the HUD says so). */
    setReconnecting(reconnecting: boolean) {
        const halt = this.state.get().halt
        if (halt) {
            this.state.update({ halt: { ...halt, reconnecting } })
        }
    }

    /** Reconnected: driving is allowed again, from the next input (nothing held over), on fresh publishers. */
    resume() {
        if (!this.state.get().halt) {
            return
        }
        this.#sources.clear()
        this.#recompute()
        this.#closeAll()
        this.state.update({ halt: null })
    }

    setBoost(boost: boolean) {
        if (boost !== this.state.get().boost) {
            this.state.update({ boost })
            this.#recompute()
        }
    }

    /** Stop: every source released at once (space, the STOP button), and the agent's command too. */
    stop() {
        this.clearInput()
        this.#stopListeners.forEach((listener) => listener())
        const command = this.state.get().command
        if (command && !command.dryRun && typeof location !== "undefined") {
            this.state.update({ command: null })
            fetch(new URL("api/drive/stop", location.href), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {})
        }
    }

    clearInput() {
        this.#sources.clear()
        this.#recompute()
    }

    setPolicyBlock(reason: string | null) {
        if (reason === this.state.get().policyBlock) return
        this.clearInput()
        this.state.update({ policyBlock: reason })
    }

    /** `listener` runs on every stop() and halt(); returns the unsubscribe. */
    onStop(listener: () => void): () => void {
        this.#stopListeners.add(listener)
        return () => this.#stopListeners.delete(listener)
    }

    #recompute() {
        const axes = zeroAxes()
        for (const share of this.#sources.values()) {
            for (const axis of Object.keys(axes) as Axis[]) {
                axes[axis] += share[axis] ?? 0
            }
        }
        for (const axis of Object.keys(axes) as Axis[]) {
            axes[axis] = Math.max(-1, Math.min(1, axes[axis]))
        }
        const settings = this.settings.get()
        const { boost } = this.profile.drive
        const boosted = this.state.get().boost
        const speeds = {
            linear: settings.linear * (boosted ? boost.linear : 1),
            angular: settings.angular * (boosted ? boost.angular : 1),
            vertical: settings.vertical * (boosted ? boost.linear : 1),
        }
        const raw = (this.profile.drive.twist ?? defaultTwist)(axes, speeds)
        const finite = (values: number[]) => values.map((value) => (Number.isFinite(value) ? value : 0)) as [number, number, number]
        const twist = { linear: finite(raw.linear), angular: finite(raw.angular) }
        if (boosted && speeds.linear > 0 && speeds.angular > 0) {
            // fast: turning eases off a little as the robot speeds up, and turns quicker than normal standing still
            const going = Math.min(1, Math.hypot(twist.linear[0], twist.linear[1]) / speeds.linear)
            const scale = (settings.angular * fastTurnScale(going)) / speeds.angular
            twist.angular = twist.angular.map((value) => value * scale) as [number, number, number]
        }
        const wasMoving = isMoving(this.state.get().twist)
        this.state.update({ axes, twist })
        // a release (or stop) is heard now, not at the next tick: the zero goes out at once, then the usual flush
        if (wasMoving && !isMoving(twist)) {
            this.#tick()
        }
    }

    #closeAll() {
        for (const [key, { publisher, deadman }] of this.#publishers) {
            // mid-drive (deadman armed): the stop goes out first, since closing clears the deadman without firing it
            if (deadman && !["tripped", "closed", "rejected"].includes(publisher.state)) {
                publisher.put(zeroOf(key.endsWith(TWIST_STAMPED) ? TWIST_STAMPED : TWIST))
            }
            publisher.close()
        }
        this.#publishers.clear()
    }

    /** The publishers for the current topics; a topic that went away gets its stop first, then closes. */
    #publishersFor(topics: DriveTopic[]): { topic: DriveTopic; key: string; entry: { publisher: Publisher; deadman: boolean } }[] | null {
        const client = this.connection.client
        if (!client || client.state === "lost") {
            return null
        }
        const wanted = new Map(topics.map((topic) => [zenohKey(topic.topic, topic.type), topic]))
        for (const [key, entry] of this.#publishers) {
            const usable = !["tripped", "closed", "rejected"].includes(entry.publisher.state)
            if (!wanted.has(key) || !usable) {
                if (usable && entry.deadman) {
                    entry.publisher.put(zeroOf(wanted.get(key)?.type ?? (key.endsWith(TWIST_STAMPED) ? TWIST_STAMPED : TWIST)))
                }
                entry.publisher.close()
                this.#publishers.delete(key)
            }
        }
        return [...wanted].map(([key, topic]) => {
            let entry = this.#publishers.get(key)
            if (!entry) {
                entry = { publisher: client.publisher(key, { priority: Priority.REAL_TIME, latencyLimit: this.profile.drive.deadmanMs }), deadman: false }
                this.#publishers.set(key, entry)
            }
            return { topic, key, entry }
        })
    }

    #tick() {
        const state = this.state.get()
        const { twist } = state
        const moving = isMoving(twist)
        if (moving) {
            this.#stopFlushUntil = Date.now() + 1000
        } else if (Date.now() >= this.#stopFlushUntil) {
            // idle, the stop flush (zeros until the deadline) over: the deadman is cleared and nothing goes out
            for (const entry of this.#publishers.values()) {
                if (entry.deadman) {
                    entry.deadman = false
                    entry.publisher.clearDeadman().catch(() => {})
                }
            }
            if (state.publishing) {
                this.state.update({ publishing: false })
            }
            return
        }
        const targets = this.#publishersFor(state.topics)
        if (!targets) {
            this.state.update({ error: "not connected to the gateway" })
            return
        }
        const plain = { linear: xyz(twist.linear), angular: xyz(twist.angular) }
        let error: string | null = null
        for (const { topic, key, entry } of targets) {
            this.connection.command(key)
            try {
                if (moving && !entry.deadman) {
                    entry.deadman = true
                    entry.publisher.setDeadman(zeroOf(topic.type)).catch((caught) => {
                        entry.deadman = false
                        this.state.update({ error: `deadman: ${caught}` })
                    })
                }
                entry.publisher.put(encode(topic.type, topic.type === TWIST_STAMPED ? { header: { stamp: stampNow(), frame_id: "base_link" }, twist: plain } : plain))
            } catch (caught) {
                // tripped since the last tick; the next one makes a fresh publisher
                entry.deadman = false
                error = String(caught)
            }
        }
        this.state.update({ publishing: true, sent: state.sent + 1, error })
    }

    /** Sets a profile slider (or steps it) and publishes its message. */
    setControl(id: string, value: number) {
        const control = this.profile.controls.find((other) => other.id === id)
        if (!control || control.kind !== "slider") {
            return
        }
        const clamped = Math.max(control.min, Math.min(control.max, Math.round(value / control.step) * control.step))
        this.controlValues.update({ [id]: clamped })
        this.#publishControl(control.id, control.topic, control.type, control.message(clamped))
    }

    stepControl(id: string, step: number) {
        this.setControl(id, (this.controlValues.get()[id] ?? 0) + step)
    }

    pressButton(id: string) {
        const control = this.profile.controls.find((other) => other.id === id)
        if (control?.kind === "button") {
            this.#publishControl(control.id, control.topic, control.type, control.message())
        }
    }

    // deno-lint-ignore no-explicit-any
    #publishControl(id: string, topic: string, type: string, message: any) {
        const client = this.connection.client
        if (!client) {
            return
        }
        let publisher = this.#controlPublishers.get(id)
        if (!publisher || ["tripped", "closed", "rejected"].includes(publisher.state)) {
            publisher = client.publisher(dimosKey(topic, type), { priority: Priority.INTERACTIVE_HIGH, delivery: "reliable" })
            this.#controlPublishers.set(id, publisher)
        }
        this.connection.command(dimosKey(topic, type))
        publisher.put(encode(type, message))
    }

    dispose() {
        clearInterval(this.#timer)
        clearTimeout(this.#commandTimer)
        this.#unsubscribeSettings()
        this.#closeAll()
        this.#controlPublishers.forEach((publisher) => publisher.close())
    }
}

// a NaN (e.g. a speed setting that's missing) is not a drive: it would publish while nobody touches anything
/** In fast mode, the turn rate against the normal one at `going` (0 stopped … 1 full linear speed): 1.5× standing
 * still, easing (quadratically, so barely at low speed) to 1.1× at full speed, so a fast drive still turns sharply. */
export function fastTurnScale(going: number): number {
    const clamped = Math.max(0, Math.min(1, going))
    return 1.5 - 0.4 * clamped * clamped
}

const isMoving = (twist: Twist) => [...twist.linear, ...twist.angular].some((value) => Number.isFinite(value) && value !== 0)

const xyz = ([x, y, z]: [number, number, number]) => ({ x, y, z })

const stampNow = () => {
    const now = Date.now()
    return { sec: Math.floor(now / 1000), nsec: (now % 1000) * 1_000_000 }
}
