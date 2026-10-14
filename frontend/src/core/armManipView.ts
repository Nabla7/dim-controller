// The arm mode's 3D manipulation, as viser draws it: the arm from the planner's own model (the hook's
// api/manipulation/description) posed by the joint state; the target ghost (orange when the planner finds the target
// feasible, red when not); the preview ghost (blue) playing a plan; a gizmo (move / rotate) on each selected group's
// tip; the plan's tip paths; the planning scene's obstacles with their shapes; the ranked grasp proposals; and the
// ground grid. Only in the arm mode with the planner option `interact` on; placed in the view's fixed frame by TF.
import * as THREE from "three"
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js"
import { LabelPool, type FrameInfo, type TfTree, type Viewer } from "dimos-react/three"
import type { ArmControl } from "./arm.ts"
import { isGripperJoint } from "./armTopics.ts"
import { solveIk } from "./ik.ts"
import { Manipulation, type ManipulationTarget, type Pose } from "./manipulation.ts"
import { basePose, Kinematics, meshGeometries, ROBOT_DESCRIPTION_FORMAT, type JointPositions, type RobotDescription, RobotModel, urdfPositions } from "./robotDescription.ts"
import { Store } from "./store.ts"

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
    controls: TransformControls
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
    #pathFor = ""

    constructor(readonly viewer: Viewer, readonly tf: TfTree, readonly armControl: ArmControl, readonly manipulation: Manipulation, readonly isArm: () => boolean) {
        this.root.matrixAutoUpdate = false
        this.root.visible = false
        this.arm.matrixAutoUpdate = false
        this.root.add(this.arm, this.obstacles, this.grasps, this.#labels.group)
        this.arm.add(this.paths)
        viewer.scene.add(this.root)

        this.#descriptionTimer = setInterval(() => this.#loadDescription(), DESCRIPTION_EVERY_MS)
        this.#sceneTimer = setInterval(() => this.#loadScene(), SCENE_EVERY_MS)
        manipulation.options.subscribe(() => this.#applyOptions())
        // only a changed mode: setting it on a gizmo mid-drag (the store also carries `dragging`) re-enters its events
        manipulation.gizmo.subscribe(() => this.gizmos.forEach(({ controls }) => controls.mode !== manipulation.gizmo.get().mode && controls.setMode(manipulation.gizmo.get().mode)))
        manipulation.state.subscribe(() => viewer.requestRender())
        armControl.state.subscribe(() => this.#active && viewer.requestRender())
        viewer.onFrame((frame) => this.#frame(frame))
    }

    get model(): Model | null {
        return this.#model
    }

    async #loadDescription() {
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
            if (!this.#model) {
                this.#build(description)
            }
        } catch (error) {
            this.status.update({ problem: String(error) })
        }
    }

    #build(description: RobotDescription) {
        const kinematics = new Kinematics(description)
        const geometries = meshGeometries(description)
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
        this.#model = { description, kinematics, geometries, real, collisionFallback, target, preview, rootInBase }
        this.#applyOptions()
        this.status.update({ model: `${description.name}: ${description.links.length} links, ${description.joint_names.length} joints`, problem: null, collisionMissing })
        this.viewer.requestRender()
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
        return urdfPositions(this.#model!.kinematics, this.armControl.state.get().joints, isGripperJoint)
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
        if (target.source === "cartesian" && !hook && this.#solved) {
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
                gizmo.controls.detach()
                gizmo.controls.dispose()
                this.viewer.scene.remove(gizmo.controls.getHelper())
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
            const controls = new TransformControls(this.viewer.camera, this.viewer.canvas)
            controls.setSize(0.8)
            controls.setSpace("local")
            controls.setMode(this.manipulation.gizmo.get().mode)
            controls.attach(handle)
            this.viewer.scene.add(controls.getHelper())
            controls.addEventListener("dragging-changed", (event) => {
                const dragging = Boolean((event as unknown as { value: boolean }).value)
                this.viewer.controls.enabled = !dragging
                this.manipulation.gizmo.update({ dragging })
                if (!dragging) {
                    // the drag ended: the backend (and every page) gets the target
                    const target = this.manipulation.state.get().target
                    if (target) {
                        this.manipulation.setTarget(target, true)
                    }
                }
            })
            controls.addEventListener("objectChange", () => this.#dragged(group, handle))
            controls.addEventListener("change", () => this.viewer.requestRender())
            this.gizmos.set(group, { controls, handle })
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
        const pose: Pose = { position: position.toArray() as [number, number, number], orientation: [orientation.x, orientation.y, orientation.z, orientation.w], frame: model.description.base_frame }
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
            const result = solveIk(model.kinematics, tip, inRoot, this.#solved ?? this.#targetPositions() ?? this.#measured())
            this.#solved = result.positions
            this.manipulation.setReach({ reachable: result.reachable, positionError: result.positionError, angleError: result.angleError })
            const groupJoints = this.manipulation.groupById(group)?.joint_names ?? []
            next.joints = { ...next.joints, ...Object.fromEntries(groupJoints.filter((name) => name in result.positions).map((name) => [name, result.positions[name]])) }
        }
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
                const pose = model.kinematics.linkPoses({ ...measured, ...Object.fromEntries(plan.jointNames.map((name, index) => [name, row[index]])) }).get(tip)
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
            if (active) {
                this.#applyOptions()
                this.#loadDescription()
                this.#loadScene()
            }
        }
        const model = this.#model
        const placed = model ? this.tf.lookup(model.description.base_frame, frame.fixedFrame) : null
        const show = active && !!model && !!placed
        this.root.visible = show
        if (show) {
            this.#syncGizmos()
        }
        for (const { controls } of this.gizmos.values()) {
            controls.enabled = show
            controls.getHelper().visible = show
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
        // viser labels the three best grasps with their rank and score
        if (this.grasps.visible) {
            for (const [rank, grasp] of ((this.grasps.userData.leaders ?? []) as GraspProposal[]).entries()) {
                this.#labels.place(`#${rank} ${grasp.score.toFixed(3)}`, new THREE.Vector3(...grasp.pose.position))
            }
        }
        this.#labels.end()
    }

    dispose() {
        clearInterval(this.#descriptionTimer)
        clearInterval(this.#sceneTimer)
        for (const { controls } of this.gizmos.values()) {
            controls.detach()
            controls.dispose()
            this.viewer.scene.remove(controls.getHelper())
        }
        this.viewer.scene.remove(this.root)
        this.#labels.dispose()
        disposeChildren(this.obstacles)
        disposeChildren(this.grasps)
        if (this.#model) {
            for (const robot of [this.#model.real, this.#model.target, this.#model.preview, this.#model.collisionFallback]) {
                robot?.dispose()
            }
            this.#model.geometries.forEach((geometry) => geometry.dispose())
        }
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
