// Wires the Controller's logic together (no React, no rendering): the gateway connection, the TF tree the 3D view and
// the map share, the layer list (dimos-react's LayerManager, its switches and styles kept in the backend's settings),
// drive, arm, the agent link, labels, what's running and the robot type. The 3D view itself is dimos-react's Scene3D
// (ui/ScenePanel.tsx); while it is mounted it hands its viewer and camera actions here (`attachScene`) for the agent's
// camera commands and captures. window.__lv exposes this for tests.
import * as THREE from "three"
import { CameraStreams } from "dimos-react"
import { LayerManager, rendering as libraryRendering, TfTree } from "dimos-react/three"
import { Connection } from "./connection.ts"
import { feedBattery } from "./batteryFeed.ts"
import { Drive } from "./drive.ts"
import { ArmControl } from "./arm.ts"
import { AgentLink } from "./agent.ts"
import { LocationLabels } from "./labels.ts"
import { RunWatch } from "./runs.ts"
import { persistentStore, Store } from "./settings.ts"
import { profileFor } from "../profile/index.ts"
import type { RobotProfile, RobotType } from "../profile/types.ts"
import { checkLink, DEFAULT_MAX_LATENCY_MS, LINK_CHECK_MS, maxLatencyOf } from "./linkWatch.ts"
import { chosenType, type ResolvedType, resolveType, type RobotsAnswer } from "./robotType.ts"

export interface ViewSettings {
    /** the robot type picked in Settings (a RobotType), "" = auto (logic/robotType.ts) */
    profile: string
    /** the type in use (auto's answer, or the pick), written by the page for the backend and the agent */
    robot?: string
    /** "" = the profile's, else picked from the tree */
    fixedFrame: string
    follow: boolean
    /** the TF frame the 3D camera follows: "" = the robot's (the profile's base frame, base_link for most) */
    followFrame: string
    showStats: boolean
    /** the robot type's stand-in model at the robot's pose */
    robotModel: boolean
    /** driving holds (Reconnect on the drive panel) once the control link's latency goes over this (ms) */
    maxLatencyMs: number
}

/** What the mounted Scene3D lends the logic (dimos-react's Viewer and its camera actions). */
export interface SceneHandle {
    // deno-lint-ignore no-explicit-any
    viewer: any
    actions: { recenter(): void; topDown(): void }
    /** the fixed frame in use */
    fixedFrame(): string
}

/** The backend's settings keys for the layer list (server/src/settings.rs): lv.layers.enabled, lv.layer.<type>.<topic key>. */
function persistLayerSetting<T extends object>(key: string, defaults: T): Store<T> {
    return persistentStore(key === "lv.layers.enabled" ? key : key.replace(/^lv\.layers\./, "lv.layer."), defaults)
}

/** The point style default (Settings → Rendering) lives in the backend; dimos-react's rendering store follows it both ways. */
function bindRendering() {
    const saved = persistentStore<{ pointStyle: string; cubeShade: string }>("lv.rendering.v2", { pointStyle: "voxel", cubeShade: "soft" })
    let applying = false
    const copy = (from: Store<{ pointStyle: string; cubeShade: string }>, to: Store<{ pointStyle: string; cubeShade: string }>) => {
        if (applying) {
            return
        }
        const { pointStyle, cubeShade } = from.get()
        const current = to.get()
        if (current.pointStyle !== pointStyle || current.cubeShade !== cubeShade) {
            applying = true
            to.update({ pointStyle, cubeShade })
            applying = false
        }
    }
    copy(saved, libraryRendering)
    saved.subscribe(() => copy(saved, libraryRendering))
    libraryRendering.subscribe(() => copy(libraryRendering, saved))
    return saved
}

export class ControllerApp {
    readonly connection: Connection
    readonly tf = new TfTree()
    /** every drawable topic and its switch and style (the Layers tab, the 3D view's cloud menu) */
    // deno-lint-ignore no-explicit-any
    readonly layers: any
    /** the camera subscriptions every panel, the 3D projection and the agent's captures share (presets: lv.video.quality) */
    // deno-lint-ignore no-explicit-any
    readonly cameras: any
    readonly rendering = bindRendering()
    readonly settings = persistentStore<ViewSettings>("lv.view", { profile: "", fixedFrame: "", follow: true, followFrame: "", showStats: false, robotModel: true, maxLatencyMs: DEFAULT_MAX_LATENCY_MS })
    #profile: RobotProfile
    /** the robot type in use, whether it was picked or auto, and why */
    readonly robot: Store<{ type: RobotType; auto: boolean; reason: string }>
    readonly drive: Drive
    /** the arm panel's commands (used when the robot type is arm; logic/arm.ts) */
    readonly arm: ArmControl
    /** live annotations and the agent's captures (server/src/annotations.rs) */
    readonly agent: AgentLink
    /** right-click location labels (server/src/labels.rs) */
    readonly labels: LocationLabels
    /** what's running (Desktop's /dimos/runs, live on its zenoh events): the first-run messages and the drive topic */
    readonly runs = new RunWatch()
    /** the mounted 3D view (null while it's off or not mounted yet) */
    scene: SceneHandle | null = null
    readonly sceneReady = new Store<{ ready: boolean }>({ ready: false })
    /** what's wrong with the TF tree (ui/sceneState.ts TfIssuesWatch checks it every 2 s) */
    // deno-lint-ignore no-explicit-any
    readonly tfIssues = new Store<{ issues: any[] }>({ issues: [] })
    /** the TF frame picked out in the view (the TF panel's hovered row), and whether it could be placed */
    readonly highlight = new Store<{ frame: string | null; placed: boolean }>({ frame: null, placed: true })
    /** Desktop's robots (robots.json types, its default robot); null until it answers, or without Desktop */
    #robots: RobotsAnswer | null = null

    constructor() {
        const first = this.#resolve()
        this.#profile = profileFor(first.type)
        this.robot = new Store({ type: first.type, auto: !chosenType(this.settings.get().profile), reason: first.reason })
        this.connection = new Connection(this.profile.drive.deadmanMs)
        this.layers = new LayerManager({ source: this.connection.source, persist: persistLayerSetting, storagePrefix: "lv.layers" })
        this.connection.status.subscribe(() => this.layers.setTopics(this.connection.status.get().topics))
        this.cameras = new CameraStreams(this.connection.source, { storageKey: "lv.video.quality" })
        this.drive = new Drive(this.connection, this.profile)
        this.arm = new ArmControl(this.connection, this.drive, profileFor("arm").arm!)
        feedBattery(this.connection, () => this.profile.name)
        this.connection.status.subscribe(() => this.#updateDriveCandidates())
        this.connection.start()
        this.labels = new LocationLabels(this)
        this.agent = new AgentLink(this)
        this.runs.state.subscribe(() => {
            this.#updateDriveCandidates()
            this.#updateRobot()
            this.#loadRobots()
        })
        this.runs.start(this.connection.source.zenoh)
        setInterval(() => this.#checkLink(), LINK_CHECK_MS)
        this.connection.status.subscribe(() => this.#updateRobot())
        // Settings → Robot here, in another viewer or by the agent
        this.settings.subscribe(() => this.#updateRobot())
        this.#updateRobot()
    }

    /** The Scene3D mounted (or went away: null). */
    attachScene(scene: SceneHandle | null) {
        this.scene = scene
        this.sceneReady.set({ ready: !!scene })
    }

    /** the fixed frame in use: the 3D view's, else the picked one, else the TF tree's root */
    get fixedFrame(): string {
        return this.scene?.fixedFrame() || this.settings.get().fixedFrame || this.profile.fixedFrame || this.tf.defaultFixedFrame()
    }

    #checkLink() {
        const action = checkLink({
            state: this.connection.status.get().state,
            latencyMs: this.connection.latencyMs(),
            maxMs: maxLatencyOf(this.settings.get().maxLatencyMs),
            halt: this.drive.state.get().halt,
            hidden: typeof document !== "undefined" && document.hidden,
        })
        if (action && "halt" in action) {
            this.drive.halt(action.halt)
        } else if (action) {
            this.drive.resume()
        }
    }

    /** The drive panel's Reconnect: a new gateway session (video and control), then driving from the next input. */
    async reconnect() {
        this.drive.stop()
        this.drive.halt({ reason: this.drive.state.get().halt?.reason ?? "latency", latencyMs: null, maxMs: maxLatencyOf(this.settings.get().maxLatencyMs) })
        this.drive.setReconnecting(true)
        try {
            await this.connection.reconnect()
            this.drive.resume()
        } catch (error) {
            console.warn("reconnect failed; the client keeps retrying", error)
            this.drive.halt({ reason: "lost", latencyMs: null, maxMs: maxLatencyOf(this.settings.get().maxLatencyMs) })
        } finally {
            this.drive.setReconnecting(false)
        }
    }

    /** the robot profile in use (it changes with Settings → Robot, or when auto changes its mind) */
    get profile(): RobotProfile {
        return this.#profile
    }

    /** the TF frame the 3D camera follows (Settings → Follow frame; the robot's by default) */
    get followFrame(): string {
        return this.settings.get().followFrame || this.profile.baseFrame
    }

    #resolve(): ResolvedType {
        const chosen = chosenType(this.settings.get().profile)
        if (chosen) {
            return { type: chosen, reason: "picked in Settings" }
        }
        return resolveType({
            robots: this.#robots,
            blueprints: this.runs.state.get().blueprints,
            topics: this.connection?.status.get().topics.map((topic) => topic.name) ?? [],
        })
    }

    #updateRobot() {
        const resolved = this.#resolve()
        const auto = !chosenType(this.settings.get().profile)
        const current = this.robot.get()
        if (current.type !== resolved.type || current.reason !== resolved.reason || current.auto !== auto) {
            this.robot.set({ type: resolved.type, auto, reason: resolved.reason })
        }
        if (resolved.type !== this.#profile.type) {
            this.#profile = profileFor(resolved.type)
            this.drive.setProfile(this.#profile)
        }
        if (this.settings.get().robot !== resolved.type && typeof location !== "undefined") {
            this.settings.update({ robot: resolved.type })
        }
    }

    /** Desktop's robots.json types and default robot (GET /api/launcher/robots), again whenever what runs changes. */
    #loadRobots() {
        fetch(new URL("../../api/launcher/robots", location.href))
            .then((response) => (response.ok ? response.json() : null))
            .then((answer: RobotsAnswer | null) => {
                if (answer && JSON.stringify(answer) !== JSON.stringify(this.#robots)) {
                    this.#robots = answer
                    this.#updateRobot()
                }
            })
            .catch(() => {})
    }

    /** The backend asked every viewer to move the camera (POST api/camera, the agent's way; the page's own buttons call the scene's actions). */
    applyCamera(event: { action: string; target?: number[] | null; distance?: number | null }) {
        const scene = this.scene
        if (!scene) {
            return
        }
        if (event.action === "recenter") {
            scene.actions.recenter()
        } else if (event.action === "topDown") {
            scene.actions.topDown()
        } else if (event.action === "lookAt" && event.target?.length === 3) {
            scene.viewer.pauseFollow()
            scene.viewer.frame(new THREE.Vector3(event.target[0], event.target[1], event.target[2]), event.distance ?? 7)
        }
    }

    #updateDriveCandidates() {
        const topics = this.connection.status.get().topics
        const onBridge = topics.filter((topic) => topic.type === "geometry_msgs.Twist").map((topic) => topic.name)
        this.drive.setRunning(this.runs.state.get().blueprints, onBridge)
        this.arm.setRunning(this.runs.state.get().blueprints, topics.filter((topic) => topic.type === "sensor_msgs.JointState").map((topic) => topic.name))
    }
}
