// Wires the core together (no React): bridge connection, TF, the 3D view, layers, camera streams, drive.
// The UI reads the stores; window.__lv exposes this for tests.
import * as THREE from "three"
import { Connection, dimosKey } from "./transport.ts"
import { zenohKey } from "./cmdvel.ts"
import { TfTree } from "dimos-react/three"
import { feedTf } from "./tfFeed.ts"
import { TfHistory } from "./tfHistory.ts"
import { checkTf, confirmed, fixedFrameInUse, missingFixedFrameIssue, type TfIssue } from "./tfCheck.ts"
import { feedBattery } from "./batteryFeed.ts"
import { Viewer } from "dimos-react/three"
import { watchSplatBudget } from "./render/rendering.ts"
import { FrameHighlight } from "./render/frameHighlight.ts"
import { LayerManager } from "./layers/manager.ts"
import { VideoSources } from "./video.ts"
import { Drive } from "./drive.ts"
import { driveBlock, PolicyControl } from "./policyControl.ts"
import { JOY_TOPIC, JOY_TYPE, JoyPublisher } from "./joy.ts"
import { ArmControl } from "./arm.ts"
import { ArmManipView } from "./armManipView.ts"
import { urdfSource } from "./urdfSource.ts"
import { Manipulation } from "./manipulation.ts"
import { AgentLink } from "./agent.ts"
import { LocationLabels } from "./labels.ts"
import { robotPose } from "./robot.ts"
import { behind, ChaseHeading, headingOf, ridesOn, turnAbout } from "./followHeading.ts"
import { disposeTree } from "dimos-react/three"
import { plannerRunning, RunWatch } from "./runs.ts"
import { persistentStore, Store } from "./store.ts"
import { profileFor } from "../profile/index.ts"
import type { RobotProfile, RobotType } from "../profile/types.ts"
import { checkLink, DEFAULT_MAX_LATENCY_MS, LINK_CHECK_MS, maxLatencyOf } from "./linkWatch.ts"
import { chosenType, type ResolvedType, resolveType, type RobotsAnswer, robotsAnswer } from "./robotType.ts"

export interface ViewSettings {
    /** the robot type picked in Settings (a RobotType), "" = auto (core/robotType.ts) */
    profile: string
    /** the type in use (auto's answer, or the pick), written by the page for the backend and the agent */
    robot?: string
    /** "" = the profile's, else picked from the tree */
    fixedFrame: string
    follow: boolean
    /** the TF frame the 3D camera follows: "" = base_link when it's in TF, else the profile's base frame */
    followFrame: string
    /** following, the camera turns with the followed frame's heading (yaw only: the world stays level) */
    followTurns: boolean
    showStats: boolean
    /** the robot type's stand-in model at the robot's pose */
    robotModel: boolean
    /** driving holds (Reconnect on the drive panel) once the control link's latency goes over this (ms) */
    maxLatencyMs: number
    /** every camera drawn in the 3D view (its picture and frustum at its CameraInfo frame; layers/camera3d.tsx) */
    camerasIn3d: boolean
    /** the CAD view cube in the 3D view's top-right corner (click a face to look from there) */
    viewCube: boolean
}

export class ViewerApp {
    readonly connection: Connection
    readonly tf = new TfTree()
    /** a few seconds of tf, so clouds are placed as of when they were seen */
    readonly tfHistory = new TfHistory(this.tf)
    readonly viewer: Viewer
    /** the TF frame picked out in the view (the TF panel's hovered row) */
    readonly highlight: FrameHighlight
    readonly video: VideoSources
    readonly layers: LayerManager
    readonly settings = persistentStore<ViewSettings>("lv.view", { profile: "", fixedFrame: "", follow: true, followFrame: "", followTurns: true, showStats: false, robotModel: true, maxLatencyMs: DEFAULT_MAX_LATENCY_MS, camerasIn3d: false, viewCube: false })
    #profile: RobotProfile
    /** the robot type in use, whether it was picked or auto, and why */
    readonly robot: Store<{ type: RobotType; auto: boolean; reason: string }>
    readonly drive: Drive
    readonly policy: PolicyControl
    /** the raw input as Joy on /joystick (core/joy.ts) */
    readonly joy: JoyPublisher
    /** the arm panel's commands (used when the robot type is arm; core/arm.ts) */
    readonly arm: ArmControl
    /** viser's planning workflow in the arm mode (core/manipulation.ts) and its 3D arm, ghost and gizmo */
    readonly manipulation = new Manipulation()
    readonly manipView: ArmManipView
    /** live annotations and the agent's captures (server/src/annotations.rs) */
    readonly agent: AgentLink
    /** right-click location labels (server/src/labels.rs) */
    readonly labels: LocationLabels
    /** what's running (Desktop's /gateways/dimos/active, live on its zenoh events): the first-run messages and the drive topic */
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
    /** the followed frame's heading, low-passed, that the camera turns with (core/followHeading.ts) */
    #chase = new ChaseHeading()
    /** the picked fixed frame while TF doesn't have it (the view draws in the default meanwhile) */
    #missingFixedFrame: string | null = null
    #lastFrameAt = 0
    /** Desktop's robots (robots.json types, its default robot); null until it answers, or without Desktop */
    #robots: RobotsAnswer | null = null
    /** the stand-in model drawn at the robot's pose, and the type it's for */
    #model: { type: RobotType; group: THREE.Group | null } | null = null

    constructor(host: HTMLElement) {
        const first = this.#resolve()
        this.#profile = profileFor(first.type)
        this.robot = new Store({ type: first.type, auto: !chosenType(this.settings.get().profile), reason: first.reason })
        this.connection = new Connection(this.profile.drive.deadmanMs)
        this.viewer = new Viewer(host, { clock: () => this.connection.bridgeNow() })
        // a drag pans (Shift+drag orbits: OrbitControls turns a modified pan into an orbit); a right-drag orbits
        this.viewer.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
        watchSplatBudget(this.viewer)
        this.highlight = new FrameHighlight(this.viewer, this.tf)
        this.video = new VideoSources(this.connection)
        this.layers = new LayerManager(this.viewer, this.tf, this.tfHistory, this.connection, this.video, this.profile)
        this.drive = new Drive(this.connection, this.profile)
        this.policy = new PolicyControl(() => this.drive.clearInput())
        this.policy.state.subscribe(() => this.drive.setPolicyBlock(driveBlock(this.policy.state.get())))
        this.drive.onStop((kind) => { void this.policy.act(kind === "emergency" ? "damping-stop" : "stop-motion") })
        this.policy.start()
        this.joy = new JoyPublisher(this.connection)
        // the lease also keeps the drive topics (and the gamepad's) to this viewer
        const leasePublish = () => this.connection.lease.setPublish([...this.drive.state.get().topics.map((topic) => zenohKey(topic.topic, topic.type)), dimosKey(JOY_TOPIC, JOY_TYPE)])
        leasePublish()
        this.drive.state.subscribe(leasePublish)
        this.arm = new ArmControl(this.connection, this.drive, profileFor("arm").arm!)
        this.manipView = new ArmManipView(this.viewer, this.tf, this.arm, this.manipulation, urdfSource(this.connection), () => this.robot.get().type === "arm" || plannerRunning(this.runs.state.get()) || this.manipulation.state.get().available === true)
        this.manipulation.watch()
        feedTf(this.connection, this.tf, this.viewer, this.tfHistory)
        feedBattery(this.connection, () => this.profile.name)
        this.connection.status.subscribe(() => this.#updateDriveCandidates())
        this.viewer.onFrame((frame) => this.#eachFrame(frame.now))
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

    /** robots.json's types (the dimos gateway's catalog/robots) and Desktop's default robot (its settings), again whenever what runs changes. */
    #loadRobots() {
        const json = (path: string) => fetch(new URL(`../../${path}`, location.href)).then((response) => (response.ok ? response.json() : null)).catch(() => null)
        Promise.all([json("gateways/dimos/catalog/robots"), json("gateways/desktop/settings")])
            .then(([catalog, settings]) => robotsAnswer(catalog, settings))
            .then((answer: RobotsAnswer | null) => {
                if (answer && JSON.stringify(answer) !== JSON.stringify(this.#robots)) {
                    this.#robots = answer
                    this.#updateRobot()
                }
            })
            .catch(() => {})
    }

    #eachFrame(now: number) {
        const dt = this.#lastFrameAt ? (now - this.#lastFrameAt) / 1000 : 0
        this.#lastFrameAt = now
        const picked = this.settings.get().fixedFrame
        if (picked && this.tf.has(picked) && this.tf.parentOf(this.robotFrame) !== null && ridesOn(picked, this.robotFrame, (frame) => this.tf.parentOf(frame))) {
            // a frame on the robot as the fixed frame tilts and turns the whole world with it: follow it instead
            this.settings.update({ fixedFrame: "", followFrame: picked, follow: true })
        }
        const { frame: fixedFrame, missing } = fixedFrameInUse(this.settings.get().fixedFrame, this.profile.fixedFrame, (frame) => this.tf.has(frame), () => this.tf.defaultFixedFrame())
        this.#missingFixedFrame = missing
        if (fixedFrame !== this.viewer.fixedFrame) {
            this.viewer.fixedFrame = fixedFrame
            this.viewer.requestRender()
        }
        const base = this.tf.lookup(this.profile.baseFrame, fixedFrame)
        const robot = base ?? robotPose.matrix
        this.robotMatrix = robot
        const position = robot ? new THREE.Vector3().setFromMatrixPosition(robot) : null
        this.#robotPosition = position
        const followFrame = this.followFrame
        const followPose = followFrame === this.profile.baseFrame ? robot : this.tf.lookup(followFrame, fixedFrame)
        const followed = followPose ? new THREE.Vector3().setFromMatrixPosition(followPose) : null
        const heading = followPose ? headingOf(followPose, followFrame) : null
        if (position && !this.#framed) {
            this.#framed = true
            this.viewer.followTarget = followed ?? position
            this.#frameBehind(followed ?? position, heading)
        }
        this.#followPosition = followed
        this.viewer.followTarget = this.settings.get().follow ? followed : null
        this.#turnWithHeading(heading, dt)
        this.#placeModel(robot)
        const info = this.frameInfo.get()
        if (info.fixedFrame !== fixedFrame || info.robotFound !== !!position || info.followFound !== !!followed) {
            this.frameInfo.set({ fixedFrame, robotFound: !!position, followFound: !!followed })
        }
    }

    /** the TF frame the 3D camera follows (Settings → Follow frame; by default the robot's) */
    get followFrame(): string {
        return this.settings.get().followFrame || this.robotFrame
    }

    /** the robot's frame: base_link when it's in TF, else the profile's base frame */
    get robotFrame(): string {
        return this.tf.has("base_link") ? "base_link" : this.profile.baseFrame
    }

    /** Following with Follow turns on: turns the camera about the followed point with the frame's (smoothed) heading. */
    #turnWithHeading(heading: number | null, dt: number) {
        if (!this.following || this.settings.get().followTurns === false || !this.#followPosition) {
            this.#chase.reset()
            return
        }
        const turn = this.#chase.step(heading, dt)
        if (Math.abs(turn) > 1e-6) {
            turnAbout(this.viewer.camera, this.viewer.controls.target, turn)
            this.viewer.requestRender()
        }
    }

    /** Frames `target` (the profile's distance away), from behind `heading` with Follow turns on, else from the view's angle. */
    #frameBehind(target: THREE.Vector3, heading: number | null) {
        const distance = this.#profile.viewDistance ?? 7
        if (heading !== null && this.settings.get().followTurns !== false) {
            // viewer.frame() keeps the camera's direction from its target: point that direction behind the frame first
            this.viewer.camera.position.copy(this.viewer.controls.target).add(behind(target, heading, distance).sub(target))
        }
        this.viewer.frame(target.clone(), distance)
        this.#chase.reset()
    }

    #checkTf() {
        const fixedFrame = this.viewer.fixedFrame
        const next = checkTf({
            snapshot: this.tf.snapshot(),
            fixedFrame,
            layers: this.layers.entries.get().list.filter((entry) => entry.enabled && entry.status.frame).map((entry) => ({ name: entry.topic.name, frame: entry.status.frame! })),
            placed: (frame) => this.tf.lookup(frame, fixedFrame) !== null,
        })
        if (this.#missingFixedFrame && this.tf.frames().length) {
            next.unshift(missingFixedFrameIssue(this.#missingFixedFrame, fixedFrame))
        }
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
                disposeTree(this.#model.group)
            }
            this.#model = { type: this.#profile.type, group: this.#profile.type === "arm" ? null : standInBox() }
            if (this.#model.group) {
                this.viewer.scene.add(this.#model.group)
            }
            this.viewer.requestRender()
        }
        const group = this.#model.group
        if (!group) {
            return
        }
        // a robot with its own URDF is drawn by that alone (layers/robotModel.tsx or the arm view), never with the box over it
        const urdf = urdfSource(this.connection).state.get()
        const visible = !!robot && this.settings.get().robotModel !== false && !urdf.description && !urdf.drawing && !urdf.armDraws
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
            const pose = this.tf.lookup(this.followFrame, this.viewer.fixedFrame)
            this.#frameBehind(this.#followPosition, pose ? headingOf(pose, this.followFrame) : null)
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

/** The stand-in when the robot has no URDF: a plain box at base_link (0.5 x 0.4 x 0.3 m, resting on the ground), not a stock car or dog that would read as the robot. */
function standInBox(): THREE.Group {
    const group = new THREE.Group()
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.3), new THREE.MeshStandardMaterial({ color: 0x8a94a6, transparent: true, opacity: 0.7 }))
    box.position.z = 0.15
    group.add(box)
    group.matrixAutoUpdate = false
    return group
}
