// The arm mode's 3D manipulation, like viser: the arm drawn from its URDF (RobotDescriptionModule) posed by the joint
// state, a translucent ghost at the target (a gizmo's pose solved by IK, the target's joints, or the plan being
// previewed), a gizmo on the tip to drag (move / rotate), the planned tip path, and the planner's obstacles. Only in
// the arm mode, with the planner option `interact` on; everything is placed in the view's fixed frame by TF.
import * as THREE from "three"
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js"
import type { FrameInfo, TfTree, Viewer } from "dimos-react/three"
import { decode, encode } from "./lcm/lcm.ts"
import { dimosKey, type Connection, type Publisher } from "./transport.ts"
import type { ArmControl } from "./arm.ts"
import { isGripperJoint } from "./armTopics.ts"
import { solveIk } from "./ik.ts"
import { Manipulation, type ManipulationTarget } from "./manipulation.ts"
import { basePose, Kinematics, meshGeometries, ROBOT_DESCRIPTION_FORMAT, type JointPositions, type RobotDescription, RobotModel, urdfPositions } from "./robotDescription.ts"
import { Store } from "./store.ts"

export const ROBOT_DESCRIPTION = dimosKey("/robot_description", "std_msgs.String")
export const ROBOT_DESCRIPTION_REQUEST = dimosKey("/robot_description_request", "std_msgs.String")
const ASK_EVERY_MS = 3000
const OBSTACLES_EVERY_MS = 2000
const GHOST_COLOR = "#7cc4ff"
const PATH_COLOR = "#ffd166"

interface Model {
    description: RobotDescription
    kinematics: Kinematics
    geometries: Map<string, THREE.BufferGeometry>
    real: RobotModel
    ghost: RobotModel
    /** the kinematics root (the URDF's root link) in the base frame: places base_link at the description's base pose */
    rootInBase: THREE.Matrix4
}

export class ArmManipView {
    /** placed at the world frame in the fixed frame, every frame */
    readonly root = new THREE.Group()
    /** the arm's root link in the world */
    readonly arm = new THREE.Group()
    readonly handle = new THREE.Object3D()
    readonly gizmo: TransformControls
    readonly path: THREE.Line
    readonly obstacles = new THREE.Group()
    readonly status = new Store<{ model: string | null; problem: string | null }>({ model: null, problem: null })
    #model: Model | null = null
    #requests: Publisher | null = null
    #asking: ReturnType<typeof setInterval>
    #obstacleTimer: ReturnType<typeof setInterval>
    #active = false
    /** the ghost's joints from the last IK solve (a cartesian target), so dragging starts from where it is */
    #solved: JointPositions | null = null
    #solvedFor = ""
    #pathFor = ""

    constructor(readonly viewer: Viewer, readonly tf: TfTree, readonly connection: Connection, readonly armControl: ArmControl, readonly manipulation: Manipulation, readonly isArm: () => boolean) {
        this.root.matrixAutoUpdate = false
        this.root.visible = false
        this.arm.matrixAutoUpdate = false
        this.root.add(this.arm, this.handle, this.obstacles)
        this.path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: PATH_COLOR, depthTest: false, transparent: true }))
        this.path.renderOrder = 10
        this.path.frustumCulled = false
        this.arm.add(this.path)
        viewer.scene.add(this.root)

        this.gizmo = new TransformControls(viewer.camera, viewer.canvas)
        this.gizmo.setSize(0.8)
        this.gizmo.setSpace("local")
        this.gizmo.attach(this.handle)
        const helper = this.gizmo.getHelper()
        viewer.scene.add(helper)
        this.gizmo.addEventListener("dragging-changed", (event) => {
            const dragging = Boolean((event as unknown as { value: boolean }).value)
            viewer.controls.enabled = !dragging
            manipulation.gizmo.update({ dragging })
            if (!dragging) {
                // the drag ended: the backend (and every page) gets the target
                const target = manipulation.state.get().target
                if (target) {
                    manipulation.setTarget(target, true)
                }
            }
        })
        this.gizmo.addEventListener("objectChange", () => this.#dragged())
        this.gizmo.addEventListener("change", () => viewer.requestRender())
        manipulation.gizmo.subscribe(() => this.gizmo.setMode(manipulation.gizmo.get().mode))

        connection.subscribe(ROBOT_DESCRIPTION, { delivery: "reliable" }, (message) => {
            if (this.#model) {
                return
            }
            try {
                const description = JSON.parse(String(decode("std_msgs.String", message.bytes).data)) as RobotDescription
                if (description.format === ROBOT_DESCRIPTION_FORMAT) {
                    this.#build(description)
                }
            } catch (error) {
                this.status.update({ problem: `not a ${ROBOT_DESCRIPTION_FORMAT} message: ${error}` })
            }
        })
        this.#asking = setInterval(() => this.#ask(), ASK_EVERY_MS)
        this.#obstacleTimer = setInterval(() => this.#loadObstacles(), OBSTACLES_EVERY_MS)
        manipulation.options.subscribe(() => this.#applyOptions())
        manipulation.state.subscribe(() => viewer.requestRender())
        armControl.state.subscribe(() => this.#active && viewer.requestRender())
        viewer.onFrame((frame) => this.#frame(frame))
    }

    get model(): Model | null {
        return this.#model
    }

    #ask() {
        if (this.#model || !this.#active) {
            return
        }
        const client = this.connection.client
        if (!client) {
            return
        }
        this.#requests ??= client.publisher(ROBOT_DESCRIPTION_REQUEST, { delivery: "reliable" })
        try {
            this.#requests.put(encode("std_msgs.String", { data: "dim-controller" }))
        } catch {
            // not open yet: the next tick asks again
        }
    }

    #build(description: RobotDescription) {
        const kinematics = new Kinematics(description)
        const geometries = meshGeometries(description)
        const real = new RobotModel(kinematics, geometries)
        const ghost = new RobotModel(kinematics, geometries, { color: GHOST_COLOR, opacity: 0.35 })
        ghost.root.visible = false
        ghost.root.renderOrder = 5
        // the base link sits at the description's base pose: the root link's pose follows from base_link's
        const baseInRoot = kinematics.linkPoses({}).get(description.base_link) ?? new THREE.Matrix4()
        const rootInBase = basePose(description).multiply(baseInRoot.clone().invert())
        this.arm.matrix.copy(rootInBase)
        this.arm.matrixWorldNeedsUpdate = true
        this.arm.add(real.root, ghost.root)
        this.#model = { description, kinematics, geometries, real, ghost, rootInBase }
        this.#applyOptions()
        this.status.update({ model: `${description.name}: ${description.links.length} links, ${description.joint_names.length} joints`, problem: null })
        this.viewer.requestRender()
    }

    #applyOptions() {
        const model = this.#model
        if (!model) {
            return
        }
        const { display, obstacles } = this.manipulation.options.get()
        model.real.setDisplay(display)
        model.ghost.setDisplay(display === "collision" ? "collision" : "visual")
        this.obstacles.visible = obstacles
        this.viewer.requestRender()
    }

    /** The tip link the gizmo holds: the planning group's tip, else the last link of the joint chain. */
    #tip(): string {
        const group = this.manipulation.state.get().groups[0]
        const model = this.#model!
        if (group?.tip_frame && model.kinematics.joints.size && model.description.links.some((link) => link.name === group.tip_frame)) {
            return group.tip_frame
        }
        const last = model.kinematics.joints.get(model.description.joint_names.at(-1) ?? "")
        return last?.child ?? model.description.base_link
    }

    #measured(): JointPositions {
        const model = this.#model!
        return urdfPositions(model.kinematics, this.armControl.state.get().joints, isGripperJoint)
    }

    /** The ghost's joints now: the preview's, the target's joints, or the IK solve of the target's pose. */
    #ghostPositions(now: number): JointPositions | null {
        const { target, plan, preview } = this.manipulation.state.get()
        const measured = this.#measured()
        if (preview && plan && preview.id === plan.id) {
            const seconds = (now - preview.startedAt) / 1000
            if (seconds <= plan.duration + 0.6) {
                this.viewer.requestRender()
                return { ...measured, ...Manipulation.sample(plan, Math.min(seconds, plan.duration)) }
            }
            this.manipulation.state.update({ preview: null })
        }
        if (!target) {
            return null
        }
        if (target.mode === "joint" && target.joints) {
            return { ...measured, ...urdfPositions(this.#model!.kinematics, Object.entries(target.joints).map(([name, position]) => ({ name, position })), isGripperJoint) }
        }
        if (target.mode === "cartesian" && target.pose) {
            const key = JSON.stringify(target.pose)
            if (this.#solvedFor !== key || !this.#solved) {
                this.#solve(this.#poseMatrix(target), this.#solved ?? measured)
                this.#solvedFor = key
            }
            return this.#solved
        }
        return null
    }

    #poseMatrix(target: ManipulationTarget): THREE.Matrix4 {
        const pose = target.pose!
        return new THREE.Matrix4().compose(new THREE.Vector3(...pose.position), new THREE.Quaternion(...pose.orientation), new THREE.Vector3(1, 1, 1))
    }

    /** IK for a world pose of the tip; the ghost and the reach indicator follow. */
    #solve(world: THREE.Matrix4, seed: JointPositions) {
        const model = this.#model!
        const inRoot = model.rootInBase.clone().invert().multiply(world)
        const result = solveIk(model.kinematics, this.#tip(), inRoot, seed)
        this.#solved = result.positions
        this.manipulation.setReach({ reachable: result.reachable, positionError: result.positionError, angleError: result.angleError })
    }

    /** The gizmo moved: a cartesian target at the handle's pose (world), the ghost solved for it. */
    #dragged() {
        const model = this.#model
        if (!model) {
            return
        }
        this.handle.updateMatrix()
        const world = this.handle.matrix.clone()
        const position = new THREE.Vector3()
        const orientation = new THREE.Quaternion()
        world.decompose(position, orientation, new THREE.Vector3())
        this.#solve(world, this.#solved ?? this.#ghostPositions(performance.now()) ?? this.#measured())
        const target: ManipulationTarget = {
            mode: "cartesian",
            group: this.manipulation.group,
            pose: { position: position.toArray() as [number, number, number], orientation: [orientation.x, orientation.y, orientation.z, orientation.w], frame: model.description.base_frame },
        }
        this.#solvedFor = JSON.stringify(target.pose)
        if (this.manipulation.options.get().mode !== "cartesian") {
            this.manipulation.options.update({ mode: "cartesian" })
        }
        this.manipulation.setTarget(target, false)
    }

    /** The plan's tip path, in the arm's root frame. */
    #updatePath() {
        const model = this.#model!
        const { plan } = this.manipulation.state.get()
        const key = plan?.id ?? ""
        if (key === this.#pathFor) {
            return
        }
        this.#pathFor = key
        const points: THREE.Vector3[] = []
        if (plan) {
            const measured = this.#measured()
            const tip = this.#tip()
            for (const row of plan.positions) {
                const positions = { ...measured, ...Object.fromEntries(plan.jointNames.map((name, index) => [name, row[index]])) }
                const pose = model.kinematics.linkPoses(positions).get(tip)
                if (pose) {
                    points.push(new THREE.Vector3().setFromMatrixPosition(pose))
                }
            }
        }
        this.path.geometry.dispose()
        this.path.geometry = new THREE.BufferGeometry().setFromPoints(points)
        this.path.visible = points.length > 1
    }

    async #loadObstacles() {
        if (!this.#active || !this.manipulation.options.get().obstacles || !this.manipulation.state.get().available) {
            return
        }
        try {
            const response = await fetch(new URL("api/manipulation/obstacles", location.href).href)
            const obstacles = (await response.json()) as Record<string, { position?: { x: number; y: number; z: number }; orientation?: { x: number; y: number; z: number; w: number } }>
            this.obstacles.clear()
            for (const [name, pose] of Object.entries(obstacles)) {
                if (!pose?.position) {
                    continue
                }
                const marker = new THREE.AxesHelper(0.08)
                marker.name = name
                marker.position.set(pose.position.x, pose.position.y, pose.position.z)
                if (pose.orientation) {
                    marker.quaternion.set(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w)
                }
                this.obstacles.add(marker)
            }
            this.viewer.requestRender()
        } catch {
            // the planner went away: the next poll tries again
        }
    }

    #frame(frame: FrameInfo) {
        const active = this.isArm() && this.manipulation.options.get().interact
        if (active !== this.#active) {
            this.#active = active
            this.manipulation.setActive(active)
            if (active) {
                this.#ask()
            }
        }
        const model = this.#model
        const placed = model ? this.tf.lookup(model.description.base_frame, frame.fixedFrame) : null
        const show = active && !!model && !!placed
        this.root.visible = show
        this.gizmo.enabled = show
        this.gizmo.getHelper().visible = show
        if (!show || !model || !placed) {
            return
        }
        if (!this.root.matrix.equals(placed)) {
            this.root.matrix.copy(placed)
            this.root.matrixWorldNeedsUpdate = true
        }
        const measured = this.#measured()
        model.real.pose(measured)
        const ghost = this.#ghostPositions(frame.now)
        model.ghost.root.visible = !!ghost
        if (ghost) {
            model.ghost.pose(ghost)
        }
        this.#updatePath()
        // the gizmo sits on the ghost's tip (or the arm's) unless it is being dragged
        if (!this.manipulation.gizmo.get().dragging) {
            const tip = model.kinematics.linkPoses(ghost ?? measured).get(this.#tip())
            if (tip) {
                const world = model.rootInBase.clone().multiply(tip)
                const target = this.manipulation.state.get().target
                // a cartesian target's own pose wins over the IK's (they differ when the pose can't be reached)
                const shown = target?.mode === "cartesian" && target.pose && !this.manipulation.state.get().preview ? this.#poseMatrix(target) : world
                shown.decompose(this.handle.position, this.handle.quaternion, this.handle.scale)
                this.handle.updateMatrixWorld()
            }
        }
    }

    dispose() {
        clearInterval(this.#asking)
        clearInterval(this.#obstacleTimer)
        this.gizmo.detach()
        this.gizmo.dispose()
        this.viewer.scene.remove(this.root, this.gizmo.getHelper())
        if (this.#model) {
            this.#model.real.dispose()
            this.#model.ghost.dispose()
            this.#model.geometries.forEach((geometry) => geometry.dispose())
        }
    }
}
