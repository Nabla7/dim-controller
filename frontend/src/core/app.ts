// Wires the core together (no React): bridge connection, TF, the 3D view, layers, camera streams, drive.
// The UI reads the stores; window.__lv exposes this for tests.
import * as THREE from "three"
import { Connection } from "./transport.ts"
import { TfTree } from "./tf.ts"
import { feedTf } from "./tfFeed.ts"
import { checkTf, confirmed, type TfIssue } from "./tfCheck.ts"
import { feedBattery } from "./batteryFeed.ts"
import { Viewer } from "./render/viewer.ts"
import { FrameHighlight } from "./render/frameHighlight.ts"
import { LayerManager } from "./layers/manager.ts"
import { VideoSources } from "./video.ts"
import { Drive } from "./drive.ts"
import { ArmControl } from "./arm.ts"
import { AgentLink } from "./agent.ts"
import { LocationLabels } from "./labels.ts"
import { robotPose } from "./robot.ts"
import { disposeModel, robotModel } from "./render/robotModel.ts"
import { RunWatch } from "./runs.ts"
import { persistentStore, Store } from "./store.ts"
import { profileFor } from "../profile/index.ts"
import type { RobotProfile, RobotType } from "../profile/types.ts"
import { checkLink, DEFAULT_MAX_LATENCY_MS, LINK_CHECK_MS, maxLatencyOf } from "./linkWatch.ts"
import { chosenType, type ResolvedType, resolveType, type RobotsAnswer } from "./robotType.ts"

export interface ViewSettings {
    /** the robot type picked in Settings (a RobotType), "" = auto (core/robotType.ts) */
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
    /** every camera drawn in the 3D view (its picture and frustum at its CameraInfo frame; layers/camera3d.tsx) */
    camerasIn3d: boolean
}

export class ViewerApp {
    readonly connection: Connection
    readonly tf = new TfTree()
    readonly viewer: Viewer
    /** the TF frame picked out in the view (the TF panel's hovered row) */
    readonly highlight: FrameHighlight
    readonly video: VideoSources
    readonly layers: LayerManager
    readonly settings = persistentStore<ViewSettings>("lv.view", { profile: "", fixedFrame: "", follow: true, followFrame: "", showStats: false, robotModel: true, maxLatencyMs: DEFAULT_MAX_LATENCY_MS, camerasIn3d: false })
    #profile: RobotProfile
    /** the robot type in use, whether it was picked or auto, and why */
    readonly robot: Store<{ type: RobotType; auto: boolean; reason: string }>
    readonly drive: Drive
    /** the arm panel's commands (used when the robot type is arm; core/arm.ts) */
    readonly arm: ArmControl
    /** live annotations and the agent's captures (server/src/annotations.rs) */
    readonly agent: AgentLink
    /** right-click location labels (server/src/labels.rs) */
    readonly labels: LocationLabels
    /** what's running (Desktop's /dimos/runs, live on its zenoh events): the first-run messages and the drive topic */
    readonly runs = new RunWatch()
    /** the fixed frame in use and where the robot is (for the UI) */
    readonly frameInfo = new Store<{ fixedFrame: string; robotFound: boolean; followFound: boolean }>({ fixedFrame: "", robotFound: false, followFound: false })
    /** what's wrong with the TF tree (core/tfCheck.ts), checked every 2 s; a problem shows once two checks in a row see it */
    readonly tfIssues = new Store<{ issues: TfIssue[] }>({ issues: [] })
    #tfSeen: TfIssue[] = []
    /** the robot's pose in the fixed frame, or null (updated every frame) */
    robotMatrix: THREE.Matrix4 | null = null
    #framed = false
    /** where the robot is now (followed or not), for recentering */
    #robotPosition: THREE.Vector3 | null = null
    /** where the followed frame is now (followed or not) */
    #followPosition: THREE.Vector3 | null = null
    /** Desktop's robots (robots.json types, its default robot); null until it answers, or without Desktop */
    #robots: RobotsAnswer | null = null
    /** the stand-in model drawn at the robot's pose, and the type it's for */
    #model: { type: RobotType; group: THREE.Group | null } | null = null

    constructor(host: HTMLElement) {
        const first = this.#resolve()
        this.#profile = profileFor(first.type)
        this.robot = new Store({ type: first.type, auto: !chosenType(this.settings.get().profile), reason: first.reason })
        this.connection = new Connection(this.profile.drive.deadmanMs)
        this.viewer = new Viewer(host, () => this.connection.bridgeNow())
        this.highlight = new FrameHighlight(this.viewer, this.tf)
        this.video = new VideoSources(this.connection)
        this.layers = new LayerManager(this.viewer, this.tf, this.connection, this.video, this.profile)
        this.drive = new Drive(this.connection, this.profile)
        this.arm = new ArmControl(this.connection, this.drive, profileFor("arm").arm!)
        feedTf(this.connection, this.tf, this.viewer)
        feedBattery(this.connection, () => this.profile.name)
        this.connection.status.subscribe(() => this.#updateDriveCandidates())
        this.viewer.onFrame(() => this.#eachFrame())
        this.connection.start()
        this.labels = new LocationLabels(this)
        this.agent = new AgentLink(this)
        this.runs.state.subscribe(() => {
            this.#updateDriveCandidates()
            this.#updateRobot()
            this.#loadRobots()
        })
        this.runs.start()
        setInterval(() => this.#checkTf(), 2000)
        setInterval(() => this.#checkLink(), LINK_CHECK_MS)
        this.connection.status.subscribe(() => this.#updateRobot())
        // Settings → Robot here, in another viewer or by the agent
        this.settings.subscribe(() => this.#updateRobot())
        // Cameras in 3D: one setting for every camera topic's 3D layer (the 3D panel's menu and Settings → 3D view)
        let camerasIn3d: boolean | null = null
        const applyCameras = () => {
            const wanted = this.settings.get().camerasIn3d === true
            if (wanted !== camerasIn3d) {
                camerasIn3d = wanted
                this.layers.setTypeEnabled("camera3d", wanted)
            }
        }
        applyCameras()
        this.settings.subscribe(applyCameras)
        this.#updateRobot()
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
            // the link watch resumes once the client's own retry connects
            this.drive.halt({ reason: "lost", latencyMs: null, maxMs: maxLatencyOf(this.settings.get().maxLatencyMs) })
        } finally {
            this.drive.setReconnecting(false)
        }
    }

    /** the robot profile in use (it changes with Settings → Robot, or when auto changes its mind) */
    get profile(): RobotProfile {
        return this.#profile
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
            this.layers.profile = this.#profile
            this.drive.setProfile(this.#profile)
            this.#framed = false
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

    #eachFrame() {
        const chosen = this.settings.get().fixedFrame || this.profile.fixedFrame
        const fixedFrame = chosen || this.tf.defaultFixedFrame()
        if (fixedFrame !== this.viewer.fixedFrame) {
            this.viewer.fixedFrame = fixedFrame
            this.viewer.requestRender()
        }
        const base = this.tf.lookup(this.profile.baseFrame, fixedFrame)
        const robot = base ?? robotPose.matrix
        this.robotMatrix = robot
        const position = robot ? new THREE.Vector3().setFromMatrixPosition(robot) : null
        this.#robotPosition = position
        if (position && !this.#framed) {
            this.#framed = true
            this.viewer.followTarget = position
            this.viewer.frame(position, this.#profile.viewDistance ?? 7)
        }
        const followFrame = this.followFrame
        const followed = followFrame === this.profile.baseFrame ? position : this.#framePosition(followFrame, fixedFrame)
        this.#followPosition = followed
        this.viewer.followTarget = this.settings.get().follow ? followed : null
        this.#placeModel(robot)
        const info = this.frameInfo.get()
        if (info.fixedFrame !== fixedFrame || info.robotFound !== !!position || info.followFound !== !!followed) {
            this.frameInfo.set({ fixedFrame, robotFound: !!position, followFound: !!followed })
        }
    }

    /** the TF frame the 3D camera follows (Settings → Follow frame; the robot's by default) */
    get followFrame(): string {
        return this.settings.get().followFrame || this.profile.baseFrame
    }

    #framePosition(frame: string, fixedFrame: string): THREE.Vector3 | null {
        const matrix = this.tf.lookup(frame, fixedFrame)
        return matrix ? new THREE.Vector3().setFromMatrixPosition(matrix) : null
    }

    #checkTf() {
        const fixedFrame = this.viewer.fixedFrame
        const next = checkTf({
            snapshot: this.tf.snapshot(fixedFrame),
            fixedFrame,
            layers: this.layers.entries.get().list.filter((entry) => entry.enabled && entry.status.frame).map((entry) => ({ name: entry.topic.name, frame: entry.status.frame! })),
            placed: (frame) => this.tf.lookup(frame, fixedFrame) !== null,
        })
        const issues = confirmed(this.#tfSeen, next)
        this.#tfSeen = next
        if (JSON.stringify(issues) !== JSON.stringify(this.tfIssues.get().issues)) {
            this.tfIssues.set({ issues })
        }
    }

    #placeModel(robot: THREE.Matrix4 | null) {
        if (this.#model?.type !== this.#profile.type) {
            if (this.#model?.group) {
                this.viewer.scene.remove(this.#model.group)
                disposeModel(this.#model.group)
            }
            this.#model = { type: this.#profile.type, group: robotModel(this.#profile.type) }
            if (this.#model.group) {
                this.viewer.scene.add(this.#model.group)
            }
            this.viewer.requestRender()
        }
        const group = this.#model.group
        if (!group) {
            return
        }
        const visible = !!robot && this.settings.get().robotModel !== false
        if (visible && !group.matrix.equals(robot)) {
            group.matrix.copy(robot)
            group.matrixWorldNeedsUpdate = true
            this.viewer.requestRender()
        }
        if (group.visible !== visible) {
            group.visible = visible
            this.viewer.requestRender()
        }
    }

    /** The backend asked every viewer to move the camera (POST api/camera, the agent's way; the page's own buttons call recenter / topDown directly). */
    applyCamera(event: { action: string; target?: number[] | null; distance?: number | null }) {
        if (event.action === "recenter") {
            this.recenter()
        } else if (event.action === "topDown") {
            this.topDown()
        } else if (event.action === "lookAt" && event.target?.length === 3) {
            this.viewer.pauseFollow()
            this.viewer.frame(new THREE.Vector3(event.target[0], event.target[1], event.target[2]), event.distance ?? 7)
        }
    }

    /** whether the 3D camera is following its frame now (on in Settings, not paused by a pan) */
    get following(): boolean {
        return this.settings.get().follow && !this.viewer.followPaused.get().paused
    }

    /**
     * Not following (paused by a pan, or off in Settings): follows again, gliding the followed frame back to the middle
     * with the angle and zoom kept. Already following: frames it afresh (7 m away). Without it in TF, frames the data
     * that's drawn, or else the origin (and follows once it shows up).
     */
    recenter() {
        const wasFollowing = this.following
        if (!this.settings.get().follow) {
            this.settings.update({ follow: true })
        }
        this.viewer.resumeFollow()
        if (wasFollowing && this.#followPosition) {
            this.viewer.frame(this.#followPosition.clone(), this.#profile.viewDistance ?? 7)
            return
        }
        if (this.#followPosition) {
            return
        }
        const bounds = this.viewer.dataBounds()
        if (bounds) {
            const size = bounds.getSize(new THREE.Vector3())
            this.viewer.frame(bounds.getCenter(new THREE.Vector3()), THREE.MathUtils.clamp(Math.max(size.x, size.y, size.z) * 1.2, 4, 300))
            return
        }
        this.viewer.frame(new THREE.Vector3(), 7)
    }

    /**
     * Straight down on the area around the robot (the data within 15 m of it, at least 12 m and at most 30 m across),
     * or without one on all the data that's drawn.
     */
    topDown() {
        const bounds = this.viewer.dataBounds()
        const robot = this.#robotPosition?.clone() ?? null
        if (robot) {
            let extent = 20
            if (bounds) {
                const near = bounds.clone().intersect(new THREE.Box3().setFromCenterAndSize(robot, new THREE.Vector3(30, 30, 1e6)))
                if (!near.isEmpty()) {
                    const size = near.getSize(new THREE.Vector3())
                    extent = THREE.MathUtils.clamp(Math.max(size.x, size.y), 12, 30)
                }
            }
            this.viewer.topDown(robot, extent)
        } else if (bounds) {
            const size = bounds.getSize(new THREE.Vector3())
            const center = bounds.getCenter(new THREE.Vector3())
            this.viewer.topDown(center.setZ(bounds.min.z), THREE.MathUtils.clamp(Math.max(size.x, size.y), 6, 400))
        } else {
            this.viewer.topDown(new THREE.Vector3(), 20)
        }
    }

    #updateDriveCandidates() {
        const topics = this.connection.status.get().topics
        const onBridge = topics.filter((topic) => topic.type === "geometry_msgs.Twist").map((topic) => topic.name)
        this.drive.setRunning(this.runs.state.get().blueprints, onBridge)
        this.arm.setRunning(this.runs.state.get().blueprints, topics.filter((topic) => topic.type === "sensor_msgs.JointState").map((topic) => topic.name))
    }
}
