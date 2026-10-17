// The arm mode's 3D manipulation, as viser draws it: the arm from the robot's URDF (dimos's UrdfManager,
// core/urdfSource.ts) when one is published, else the planner's own model (the hook's api/manipulation/description),
// posed by the joint state; the target ghost (orange when the planner finds the target feasible, red when not); the
// preview ghost (blue) playing a plan; a gizmo (move arrows and rotate rings together) on each selected group's tip; the plan's tip paths;
// the planning scene's obstacles with their shapes; the ranked grasp proposals; and the ground grid. Only in the arm
// mode with the planner option `interact` on; placed in the view's fixed frame by TF.
import * as THREE from "three"
import { PoseGizmo } from "./poseGizmo.ts"
import { LabelPool, type FrameInfo, type TfTree, type Viewer } from "dimos-react/three"
import type { ArmControl } from "./arm.ts"
import { isGripperJoint } from "./armTopics.ts"
import { solveIk } from "./ik.ts"
import { Manipulation, type ManipulationTarget, type Pose } from "./manipulation.ts"
import { basePose, Kinematics, meshGeometries, ROBOT_DESCRIPTION_FORMAT, type JointPositions, type RobotDescription, RobotModel, urdfPositions } from "./robotDescription.ts"
import { Store } from "./store.ts"
import type { UrdfSource } from "./urdfSource.ts"

const DESCRIPTION_EVERY_MS = 3000
const SCENE_EVERY_MS = 1000
// viser's colors (dimos/manipulation/visualization/viser/scene.py)
const TARGET_FEASIBLE = { color: "#ff7a00", opacity: 0.7 }
const TARGET_INFEASIBLE = { color: "#ff1e1e", opacity: 0.75 }
const PREVIEW = { color: "#50b4ff", opacity: 0.55 }
const COLLISION = { color: "#d228dc", opacity: 0.35 }
const OBSTACLE_FALLBACK = { color: "#37bed2", opacity: 0.55 }
const OBSTACLE_PROXY = "#ff2d19"
const GRASP_BEST = new THREE.Color(60 / 255, 220 / 255, 60 / 255)
const GRASP_WORST = new THREE.Color(255 / 255, 160 / 255, 60 / 255)
const GRASP_DRAW_LIMIT = 20
const GRASP_EMPHASIS_COUNT = 3
const GRASP_APPROACH_LENGTH = 0.05
const GRASP_CLOSING_HALF_WIDTH = 0.02
const PATH_COLOR = "#ffd166"

interface Model {
    description: RobotDescription
    /** urdf: UrdfManager's (shared meshes, placed by TF); hook: the planner's (its own meshes, placed by its base pose) */
    source: "urdf" | "hook"
    /** the frame the view's root sits at, and planner poses are in */
    baseFrame: string
    kinematics: Kinematics
    geometries: Map<string, THREE.BufferGeometry>
    real: RobotModel
    /** viser's stand-in when the model has no collision geometry: the visual meshes in collision colors */
    collisionFallback: RobotModel | null
    target: RobotModel
    preview: RobotModel
    /** the kinematics root (the URDF's root link) in the base frame: places base_link at the description's base pose */
    rootInBase: THREE.Matrix4
}

interface Gizmo {
    /** arrows to move and arcs to rotate, both on the handle at once: no mode to switch */
    control: PoseGizmo
    handle: THREE.Object3D
}

export interface Obstacle {
    name: string
    type: "box" | "sphere" | "cylinder" | "mesh" | "octree" | "marker"
    pose: Pose
    dimensions?: number[]
    color?: number[] | null
    vertices?: number[]
    faces?: number[]
    points?: number[]
    resolution?: number | null
    error?: string
}

export interface GraspProposal {
    pose: Pose
    score: number
}

export class ArmManipView {
    /** placed at the world frame in the fixed frame, every frame */
    readonly root = new THREE.Group()
    /** the arm's root link in the world */
    readonly arm = new THREE.Group()
    readonly paths = new THREE.Group()
    readonly obstacles = new THREE.Group()
    readonly grasps = new THREE.Group()
    readonly gizmos = new Map<string, Gizmo>()
    readonly status = new Store<{ model: string | null; problem: string | null; collisionMissing: boolean; obstacleCount: number; graspCount: number; obstacleProblems: string[] }>({
        model: null,
        problem: null,
        collisionMissing: false,
        obstacleCount: 0,
        graspCount: 0,
        obstacleProblems: [],
    })
    #model: Model | null = null
    #labels = new LabelPool()
    #descriptionTimer: ReturnType<typeof setInterval>
    #sceneTimer: ReturnType<typeof setInterval>
    #sceneVersions: Record<string, number> = {}
    #fetching = false
    #active = false
    /** without the hook: the ghost's joints from the page's own IK of the dragged pose */
    #solved: JointPositions | null = null
    /** the target #solved was solved for: any other (an undo, a preset, a slider) shows its own joints */
    #solvedFor: ManipulationTarget | null = null
    #pathFor = ""
    #releaseUrdf: (() => void) | null = null
    #fixedFrame = ""

    constructor(readonly viewer: Viewer, readonly tf: TfTree, readonly armControl: ArmControl, readonly manipulation: Manipulation, readonly urdf: UrdfSource, readonly isArm: () => boolean) {
        this.root.matrixAutoUpdate = false
        this.root.visible = false
        this.arm.matrixAutoUpdate = false
        this.root.add(this.arm, this.obstacles, this.grasps, this.#labels.group)
        this.arm.add(this.paths)
        viewer.scene.add(this.root)

        this.#descriptionTimer = setInterval(() => this.#loadDescription(), DESCRIPTION_EVERY_MS)
        this.#sceneTimer = setInterval(() => this.#loadScene(), SCENE_EVERY_MS)
        manipulation.options.subscribe(() => this.#applyOptions())
        manipulation.state.subscribe(() => viewer.requestRender())
        armControl.state.subscribe(() => this.#active && viewer.requestRender())
        viewer.onFrame((frame) => this.#frame(frame))
        urdf.state.subscribe(() => this.#onUrdf())
    }

    /** The URDF is the robot model when there is one: it replaces the hook's, and its meshes fill in as they arrive. */
    #onUrdf() {
        if (!this.#active) {
            return
        }
        const { description } = this.urdf.state.get()
        const model = this.#model
        if (description && model?.description !== description) {
            this.#teardown()
            this.#build(description, "urdf")
        } else if (model?.source === "urdf") {
            if ([model.real, model.target, model.preview, model.collisionFallback].map((robot) => robot?.fill(this.urdf.geometries)).some(Boolean)) {
                this.viewer.requestRender()
            }
            this.#modelStatus()
        }
    }

    get model(): Model | null {
        return this.#model
    }

    async #loadDescription() {
        if (this.urdf.state.get().description) {
            this.#onUrdf()
            return
        }
        if (this.#model || !this.#active || !this.manipulation.state.get().hook) {
            if (this.#active && !this.#model && this.manipulation.state.get().available && !this.manipulation.state.get().hook) {
                this.status.update({ problem: "no dim-controller hook in the blueprint's process: install it (Install hook, in the panel's status) and restart the blueprint" })
            }
            return
        }
        try {
            const response = await fetch(new URL("api/manipulation/description", location.href).href)
            const description = (await response.json()) as RobotDescription & { error?: string }
            if (!response.ok || description.format !== ROBOT_DESCRIPTION_FORMAT) {
                this.status.update({ problem: description.error ?? `not a ${ROBOT_DESCRIPTION_FORMAT}` })
                return
            }
            // the URDF may have come meanwhile
            if (!this.#model && !this.urdf.state.get().description) {
                this.#build(description, "hook")
            }
        } catch (error) {
            this.status.update({ problem: String(error) })
        }
    }

    #build(description: RobotDescription, source: Model["source"]) {
        const kinematics = new Kinematics(description)
        const geometries = source === "urdf" ? this.urdf.geometries : meshGeometries(description)
        const collisionMissing = !description.links.some((link) => link.collisions.length)
        const real = new RobotModel(kinematics, geometries, { collisionColor: COLLISION.color })
        const collisionFallback = collisionMissing ? new RobotModel(kinematics, geometries, COLLISION) : null
        const target = new RobotModel(kinematics, geometries, TARGET_FEASIBLE)
        const preview = new RobotModel(kinematics, geometries, PREVIEW)
        for (const ghost of [target, preview]) {
            ghost.root.visible = false
            ghost.root.renderOrder = 5
        }
        // the base link sits at the description's base pose: the root link's pose follows from base_link's
        const baseInRoot = kinematics.linkPoses({}).get(description.base_link) ?? new THREE.Matrix4()
        const rootInBase = basePose(description).multiply(baseInRoot.clone().invert())
        this.arm.matrix.copy(rootInBase)
        this.arm.matrixWorldNeedsUpdate = true
        this.arm.add(real.root, target.root, preview.root, ...(collisionFallback ? [collisionFallback.root] : []))
        this.#model = { description, source, baseFrame: description.base_frame, kinematics, geometries, real, collisionFallback, target, preview, rootInBase }
        this.#applyOptions()
        this.status.update({ problem: null, collisionMissing })
        this.#modelStatus()
        this.viewer.requestRender()
    }

    #modelStatus() {
        const model = this.#model
        if (!model) {
            return
        }
        const { description } = model
        const { meshesLoaded, meshesWanted } = this.urdf.state.get()
        const from = model.source === "urdf" ? ` (URDF${meshesWanted && meshesLoaded < meshesWanted ? `, meshes ${meshesLoaded}/${meshesWanted}` : ""})` : ""
        this.status.update({ model: `${description.name}: ${description.links.length} links, ${description.joint_names.length} joints${from}` })
    }

    #teardown() {
        const model = this.#model
        if (!model) {
            return
        }
        for (const robot of [model.real, model.target, model.preview, model.collisionFallback]) {
            if (robot) {
                this.arm.remove(robot.root)
                robot.dispose()
            }
        }
        // the URDF's meshes are the source's, kept for the next model
        if (model.source === "hook") {
            model.geometries.forEach((geometry) => geometry.dispose())
        }
        this.#model = null
        this.#solved = null
        this.#pathFor = "-"
    }

    /** `frame` in `parent` by TF, through the view's fixed frame (one fixed frame keeps the tree's lookup cache) */
    #relative(frame: string, parent: string): THREE.Matrix4 | null {
        const framePose = this.tf.lookup(frame, this.#fixedFrame), parentPose = this.tf.lookup(parent, this.#fixedFrame)
        return framePose && parentPose ? parentPose.clone().invert().multiply(framePose) : null
    }

    /** A URDF model sits at its root link's TF frame, or in the planner's world when the planner (the hook) is there to take poses. */
    #placeUrdf(model: Model) {
        const root = model.kinematics.root
        const inWorld = this.manipulation.state.get().hook ? this.#relative(root, "world") : null
        model.baseFrame = inWorld ? "world" : root
        const rootInBase = inWorld ?? new THREE.Matrix4()
        if (!model.rootInBase.equals(rootInBase)) {
            model.rootInBase.copy(rootInBase)
            this.arm.matrix.copy(rootInBase)
            this.arm.matrixWorldNeedsUpdate = true
        }
    }

    #applyOptions() {
        const { display, obstacles, grasps, grid } = this.manipulation.options.get()
        this.obstacles.visible = obstacles
        this.grasps.visible = grasps
        if (this.#active) {
            this.viewer.setGrid(grid)
        }
        const model = this.#model
        if (model) {
            // viser: a model without collision geometry shows its visual meshes in collision colors instead
            model.real.setDisplay(model.collisionFallback && display !== "visual" ? "visual" : display)
            model.real.root.visible = !(model.collisionFallback && display === "collision")
            if (model.collisionFallback) {
                model.collisionFallback.setDisplay("visual")
                model.collisionFallback.root.visible = display !== "visual"
            }
        }
        this.viewer.requestRender()
    }

    /** A group's tip link: its planning group's tip, else the last link of the joint chain. */
    #tip(groupId: string): string | null {
        const model = this.#model!
        const tip = this.manipulation.groupById(groupId)?.tip_frame
        return tip && model.description.links.some((link) => link.name === tip) ? tip : null
    }

    #measured(): JointPositions {
        const model = this.#model!
        const fromJointState = urdfPositions(model.kinematics, this.armControl.state.get().joints, isGripperJoint)
        if (model.source === "hook") {
            return fromJointState
        }
        // a URDF's joints are all on TF (UrdfManager): what no joint state names (a torso, a head) comes from there
        return { ...model.kinematics.positionsFrom((child, parent) => this.#relative(child, parent)), ...fromJointState }
    }

    #withJoints(base: JointPositions, joints: Record<string, number>): JointPositions {
        return { ...base, ...urdfPositions(this.#model!.kinematics, Object.entries(joints).map(([name, position]) => ({ name, position })), isGripperJoint) }
    }

    /** The target ghost's joints: the target's (a pose target's from the planner's IK, or without the hook the page's). */
    #targetPositions(): JointPositions | null {
        const { target, hook } = this.manipulation.state.get()
        if (!target) {
            return null
        }
        if (target.source === "cartesian" && !hook && this.#solved && this.#solvedFor === target) {
            return this.#solved
        }
        return this.#withJoints(this.#measured(), target.joints)
    }

    #previewPositions(now: number): JointPositions | null {
        const { plan, preview } = this.manipulation.state.get()
        if (!preview || !plan || preview.id !== plan.id) {
            return null
        }
        const seconds = (now - preview.startedAt) / 1000
        if (seconds > plan.duration + 0.6) {
            this.manipulation.state.update({ preview: null })
            return null
        }
        this.viewer.requestRender()
        return this.#withJoints(this.#measured(), Manipulation.sample(plan, Math.min(seconds, plan.duration)))
    }

    static poseMatrix(pose: Pose): THREE.Matrix4 {
        return new THREE.Matrix4().compose(new THREE.Vector3(...pose.position), new THREE.Quaternion(...pose.orientation), new THREE.Vector3(1, 1, 1))
    }

    /** One gizmo per selected group with a tip (viser's ee_control per group). */
    #syncGizmos() {
        const wanted = this.manipulation.state.get().selected.filter((group) => this.#tip(group))
        for (const [group, gizmo] of this.gizmos) {
            if (!wanted.includes(group)) {
                gizmo.control.dispose()
                this.root.remove(gizmo.handle)
                this.gizmos.delete(group)
            }
        }
        for (const group of wanted) {
            if (this.gizmos.has(group)) {
                continue
            }
            const handle = new THREE.Object3D()
            this.root.add(handle)
            const control = new PoseGizmo(this.viewer.camera, this.viewer.canvas, handle, {
                change: () => this.#dragged(group, handle),
                render: () => this.viewer.requestRender(),
                dragging: (dragging) => {
                    this.viewer.controls.enabled = !dragging
                    // one grab moves one gizmo
                    for (const other of this.gizmos.values()) {
                        if (other.control !== control) {
                            other.control.enabled = !dragging
                        }
                    }
                    this.manipulation.gizmo.update({ dragging })
                    if (!dragging) {
                        // the drag ended: the backend (and every page) gets the target
                        const target = this.manipulation.state.get().target
                        if (target) {
                            this.manipulation.setTarget(target, true)
                        }
                    }
                },
            })
            this.viewer.scene.add(control.object)
            this.gizmos.set(group, { control, handle })
        }
    }

    /** A gizmo moved: its group's pose target at the handle (world); the planner's IK sets the joints. */
    #dragged(group: string, handle: THREE.Object3D) {
        const model = this.#model
        if (!model) {
            return
        }
        handle.updateMatrix()
        const position = new THREE.Vector3()
        const orientation = new THREE.Quaternion()
        handle.matrix.decompose(position, orientation, new THREE.Vector3())
        const { target, selected, hook } = this.manipulation.state.get()
        const pose: Pose = { position: position.toArray() as [number, number, number], orientation: [orientation.x, orientation.y, orientation.z, orientation.w], frame: model.baseFrame }
        const next: ManipulationTarget = {
            groups: selected,
            joints: target?.joints ?? this.manipulation.currentJoints(),
            poses: { ...(target?.poses ?? {}), [group]: pose },
            source: "cartesian",
        }
        if (!hook) {
            // no planner to ask: the page's own IK (no collision check) places the ghost and says whether it reaches
            const tip = this.#tip(group)!
            const inRoot = model.rootInBase.clone().invert().multiply(handle.matrix)
            // only the group's joints move (the torso stays where it is: the planner gets just these), by their URDF
            // names (a planner's may be prefixed: "r1pro/left_arm_joint1")
            const urdfNames = new Map<string, string>()
            for (const name of this.manipulation.groupById(group)?.joint_names ?? []) {
                const short = Object.keys(urdfPositions(model.kinematics, [{ name, position: 0 }], isGripperJoint))[0]
                if (short) {
                    urdfNames.set(short, name)
                }
            }
            const previous = this.#targetPositions() ?? {}
            const seed = { ...this.#measured(), ...Object.fromEntries([...urdfNames.keys()].filter((short) => short in previous).map((short) => [short, previous[short]])) }
            const positionOnly = this.gizmos.get(group)?.control.positionOnly ?? false
            const result = solveIk(model.kinematics, tip, inRoot, seed, new Set(urdfNames.keys()), positionOnly)
            if (positionOnly) {
                // the gizmo (and the pose target) take the orientation the IK found
                const reached = model.kinematics.linkPoses(result.positions).get(tip)
                if (reached) {
                    const turned = new THREE.Quaternion().setFromRotationMatrix(model.rootInBase.clone().multiply(reached))
                    handle.quaternion.copy(turned)
                    handle.updateMatrix()
                    next.poses[group] = { ...pose, orientation: [turned.x, turned.y, turned.z, turned.w] }
                }
            }
            this.#solved = result.positions
            this.manipulation.setReach({ reachable: result.reachable, positionError: result.positionError, angleError: result.angleError })
            next.joints = { ...next.joints, ...Object.fromEntries([...urdfNames].map(([short, name]) => [name, result.positions[short]])) }
        }
        this.#solvedFor = next
        this.manipulation.setTarget(next, false)
    }

    /** The plan's tip path per group, in the arm's root frame. */
    #updatePaths() {
        const model = this.#model!
        const { plan } = this.manipulation.state.get()
        const key = plan?.id ?? ""
        if (key === this.#pathFor) {
            return
        }
        this.#pathFor = key
        this.paths.children.forEach((line) => (line as THREE.Line).geometry.dispose())
        this.paths.clear()
        if (!plan) {
            return
        }
        const measured = this.#measured()
        for (const group of plan.groups) {
            const tip = this.#tip(group)
            if (!tip) {
                continue
            }
            const points: THREE.Vector3[] = []
            for (const row of plan.positions) {
                // through #withJoints, as the preview ghost: a planner's names ("r1pro/left_arm_joint1") are the URDF's short ones
                const pose = model.kinematics.linkPoses(this.#withJoints(measured, Object.fromEntries(plan.jointNames.map((name, index) => [name, row[index]])))).get(tip)
                if (pose) {
                    points.push(new THREE.Vector3().setFromMatrixPosition(pose))
                }
            }
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: PATH_COLOR, depthTest: false, transparent: true }))
            line.renderOrder = 10
            line.frustumCulled = false
            this.paths.add(line)
        }
    }

    /** The planning scene: obstacles and grasp proposals, each fetched again only when its version moved. */
    async #loadScene() {
        if (this.#fetching || !this.#active || !this.manipulation.state.get().available) {
            return
        }
        this.#fetching = true
        try {
            const query = new URLSearchParams(Object.entries(this.#sceneVersions).map(([key, value]) => [key, String(value)]))
            const response = await fetch(new URL(`api/manipulation/scene?${query}`, location.href).href)
            const answer = (await response.json()) as { hook: boolean; scene: { versions: Record<string, number>; obstacles?: Obstacle[]; grasps?: GraspProposal[] } }
            if (!response.ok) {
                return
            }
            const { scene } = answer
            if (scene.obstacles) {
                this.#drawObstacles(scene.obstacles)
            }
            if (scene.grasps) {
                this.#drawGrasps(scene.grasps)
            }
            // without the hook there are no versions: poses are fetched every time
            this.#sceneVersions = answer.hook ? scene.versions : {}
            this.viewer.requestRender()
        } catch {
            // the planner went away: the next tick tries again
        } finally {
            this.#fetching = false
        }
    }

    #drawObstacles(obstacles: Obstacle[]) {
        disposeChildren(this.obstacles)
        const problems: string[] = []
        for (const obstacle of obstacles) {
            const object = obstacleObject(obstacle)
            if (obstacle.error) {
                problems.push(`${obstacle.name}: ${obstacle.error}`)
            }
            object.name = obstacle.name
            this.obstacles.add(object)
        }
        this.status.update({ obstacleCount: obstacles.length, obstacleProblems: problems })
    }

    /** viser's glyphs: per proposal the approach axis and the closing axis across it, best green through worst orange. */
    #drawGrasps(grasps: GraspProposal[]) {
        disposeChildren(this.grasps)
        const drawn = grasps.slice(0, GRASP_DRAW_LIMIT)
        const local = [new THREE.Vector3(0, 0, -GRASP_APPROACH_LENGTH), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -GRASP_CLOSING_HALF_WIDTH, 0), new THREE.Vector3(0, GRASP_CLOSING_HALF_WIDTH, 0)]
        const positions: number[] = []
        const colors: number[] = []
        drawn.forEach((grasp, rank) => {
            const matrix = ArmManipView.poseMatrix(grasp.pose)
            const color = GRASP_BEST.clone().lerp(GRASP_WORST, drawn.length <= 1 ? 0 : rank / (drawn.length - 1))
            for (const point of local) {
                positions.push(...point.clone().applyMatrix4(matrix).toArray())
                colors.push(color.r, color.g, color.b)
            }
            if (rank < GRASP_EMPHASIS_COUNT) {
                // viser draws the leaders thicker; WebGL lines are one pixel, so the leaders get a dot at the grasp point
                const dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }))
                dot.position.set(...grasp.pose.position)
                dot.renderOrder = 11
                this.grasps.add(dot)
            }
        })
        if (positions.length) {
            const geometry = new THREE.BufferGeometry()
            geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
            geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
            const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }))
            lines.renderOrder = 11
            this.grasps.add(lines)
        }
        this.grasps.userData.leaders = drawn.slice(0, GRASP_EMPHASIS_COUNT)
        this.status.update({ graspCount: grasps.length })
    }

    #frame(frame: FrameInfo) {
        const active = this.isArm() && this.manipulation.options.get().interact
        if (active !== this.#active) {
            this.#active = active
            this.manipulation.setActive(active)
            this.#releaseUrdf?.()
            this.#releaseUrdf = active ? this.urdf.acquire() : null
            if (active) {
                this.#applyOptions()
                this.#loadDescription()
                this.#loadScene()
            }
        }
        this.#fixedFrame = frame.fixedFrame
        const model = this.#model
        if (model?.source === "urdf") {
            this.#placeUrdf(model)
        }
        const placed = model ? this.tf.lookup(model.baseFrame, frame.fixedFrame) : null
        const show = active && !!model && !!placed
        this.root.visible = show
        if (this.urdf.state.get().armDraws !== show) {
            this.urdf.state.update({ armDraws: show })
        }
        if (show) {
            this.#syncGizmos()
        }
        for (const gizmo of this.gizmos.values()) {
            gizmo.control.enabled = show && !this.#otherDragging(gizmo)
            gizmo.control.update()
        }
        this.#labels.begin()
        if (!show || !model || !placed) {
            this.#labels.end()
            return
        }
        if (!this.root.matrix.equals(placed)) {
            this.root.matrix.copy(placed)
            this.root.matrixWorldNeedsUpdate = true
        }
        const measured = this.#measured()
        model.real.pose(measured)
        model.collisionFallback?.pose(measured)

        const { target, feasibility, hook } = this.manipulation.state.get()
        const targetPositions = this.#targetPositions()
        model.target.root.visible = !!targetPositions
        if (targetPositions) {
            model.target.pose(targetPositions)
            const infeasible = hook ? feasibility.status !== "feasible" && feasibility.status !== "checking" : this.manipulation.state.get().reach?.reachable === false
            const look = infeasible ? TARGET_INFEASIBLE : TARGET_FEASIBLE
            model.target.tint(look.color, look.opacity)
        }
        const previewPositions = this.#previewPositions(frame.now)
        model.preview.root.visible = !!previewPositions
        if (previewPositions) {
            model.preview.pose(previewPositions)
        }
        this.#updatePaths()

        // each gizmo sits on its group's pose target, else the target ghost's (or the arm's) tip, unless dragged
        if (!this.manipulation.gizmo.get().dragging) {
            for (const [group, { handle }] of this.gizmos) {
                const pose = target?.poses[group]
                const tip = this.#tip(group)
                const linkPose = tip ? model.kinematics.linkPoses(targetPositions ?? measured).get(tip) : undefined
                const world = pose ? ArmManipView.poseMatrix(pose) : linkPose ? model.rootInBase.clone().multiply(linkPose) : null
                if (world) {
                    world.decompose(handle.position, handle.quaternion, handle.scale)
                    handle.updateMatrixWorld()
                }
            }
        }
        const scalesWithView = this.manipulation.options.get().gizmoScalesWithView
        for (const gizmo of this.gizmos.values()) {
            gizmo.control.scalesWithView = scalesWithView
            gizmo.control.update()
        }
        // viser labels the three best grasps with their rank and score
        if (this.grasps.visible) {
            for (const [rank, grasp] of ((this.grasps.userData.leaders ?? []) as GraspProposal[]).entries()) {
                this.#labels.place(`#${rank} ${grasp.score.toFixed(3)}`, new THREE.Vector3(...grasp.pose.position))
            }
        }
        this.#labels.end()
    }

    /** another group's gizmo is mid-drag: this one stays out of the way */
    #otherDragging(gizmo: Gizmo): boolean {
        return [...this.gizmos.values()].some((other) => other !== gizmo && other.control.dragging)
    }

    dispose() {
        clearInterval(this.#descriptionTimer)
        clearInterval(this.#sceneTimer)
        for (const gizmo of this.gizmos.values()) {
            gizmo.control.dispose()
        }
        this.viewer.scene.remove(this.root)
        this.#labels.dispose()
        disposeChildren(this.obstacles)
        disposeChildren(this.grasps)
        this.#teardown()
        this.#releaseUrdf?.()
    }
}

/** An obstacle as viser draws it: its shape in its color (or viser's fallback), the occupied cells of an octree as
 * square points, a red box with a label when its shape couldn't be read, and axes for a pose without a shape. */
export function obstacleObject(obstacle: Obstacle): THREE.Object3D {
    const color = obstacle.color ? new THREE.Color(obstacle.color[0], obstacle.color[1], obstacle.color[2]) : new THREE.Color(OBSTACLE_FALLBACK.color)
    const opacity = obstacle.color?.[3] ?? OBSTACLE_FALLBACK.opacity
    const material = () => new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, roughness: 0.7 })
    const dimensions = obstacle.dimensions ?? []
    let object: THREE.Object3D
    if (obstacle.error) {
        object = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), new THREE.MeshStandardMaterial({ color: OBSTACLE_PROXY, transparent: true, opacity: 0.9 }))
    } else if (obstacle.type === "box") {
        object = new THREE.Mesh(new THREE.BoxGeometry(dimensions[0] ?? 0.1, dimensions[1] ?? 0.1, dimensions[2] ?? 0.1), material())
    } else if (obstacle.type === "sphere") {
        object = new THREE.Mesh(new THREE.IcosahedronGeometry(dimensions[0] ?? 0.05, 3), material())
    } else if (obstacle.type === "cylinder") {
        // dimos cylinders (radius, height) run along z, three's along y
        const cylinder = new THREE.CylinderGeometry(dimensions[0] ?? 0.05, dimensions[0] ?? 0.05, dimensions[1] ?? 0.1, 32)
        cylinder.rotateX(Math.PI / 2)
        object = new THREE.Mesh(cylinder, material())
    } else if (obstacle.type === "mesh" && obstacle.vertices && obstacle.faces) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(obstacle.vertices, 3))
        geometry.setIndex(obstacle.faces)
        geometry.computeVertexNormals()
        object = new THREE.Mesh(geometry, material())
    } else if (obstacle.type === "octree" && obstacle.points) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(obstacle.points, 3))
        object = new THREE.Points(geometry, new THREE.PointsMaterial({ color, size: obstacle.resolution ?? 0.05, sizeAttenuation: true }))
    } else {
        object = new THREE.AxesHelper(0.08)
    }
    object.position.set(...obstacle.pose.position)
    object.quaternion.set(...obstacle.pose.orientation)
    object.userData.obstacle = obstacle.type
    return object
}

function disposeChildren(group: THREE.Group) {
    group.traverse((object) => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose()
        const material = mesh.material as THREE.Material | undefined
        material?.dispose?.()
    })
    group.clear()
}
