// An arm's URDF as dimos's RobotDescriptionModule publishes it (dimos.robot_description.v1 on /robot_description, asked
// for on /robot_description_request): links with their visual and collision geometry (meshes as base64 float32
// vertices and uint32 faces), joints (origin, axis, limits, mimic), the base link and the base's pose in the world.
// Kinematics does the forward kinematics from joint positions; buildRobot makes the three.js model it poses.
import * as THREE from "three"

type V3 = [number, number, number]
type Q = [number, number, number, number]

export const ROBOT_DESCRIPTION_FORMAT = "dimos.robot_description.v1"

export interface Origin {
    xyz: V3
    quat: Q
}

export interface DescriptionGeometry {
    type: "mesh" | "box" | "cylinder" | "sphere"
    origin: Origin
    mesh?: string
    scale?: V3
    size?: V3
    radius?: number
    length?: number
    color?: [number, number, number, number]
}

export interface DescriptionLink {
    name: string
    visuals: DescriptionGeometry[]
    collisions: DescriptionGeometry[]
}

export interface DescriptionJoint {
    name: string
    type: "revolute" | "continuous" | "prismatic" | "fixed" | "floating" | "planar"
    parent: string
    child: string
    origin: Origin
    axis: V3
    limit?: [number, number]
    mimic?: { joint: string; multiplier: number; offset: number }
}

export interface RobotDescription {
    format: string
    name: string
    base_link: string
    base_frame: string
    base_pose: Origin
    joint_names: string[]
    links: DescriptionLink[]
    joints: DescriptionJoint[]
    meshes: Record<string, { vertices: string; faces: string }>
}

const originMatrix = (origin: Origin) =>
    new THREE.Matrix4().compose(new THREE.Vector3(...origin.xyz), new THREE.Quaternion(...origin.quat), new THREE.Vector3(1, 1, 1))

/** Joint positions by name: a URDF joint's own name, or the name after a prefix (`arm/joint1` → `joint1`). */
export type JointPositions = Record<string, number>

export class Kinematics {
    /** joints by child link, and the tree order (parents before children) */
    readonly #byChild = new Map<string, DescriptionJoint>()
    readonly #order: DescriptionJoint[] = []
    readonly #origins = new Map<string, THREE.Matrix4>()
    readonly root: string
    readonly joints: Map<string, DescriptionJoint>
    /** the joint other joints mimic (an xArm's gripper drive_joint): what a gripper position drives */
    readonly gripperJoint: string | null

    constructor(readonly description: RobotDescription) {
        this.joints = new Map(description.joints.map((joint) => [joint.name, joint]))
        for (const joint of description.joints) {
            this.#byChild.set(joint.child, joint)
            this.#origins.set(joint.name, originMatrix(joint.origin))
        }
        const children = new Set(description.joints.map((joint) => joint.child))
        this.root = description.links.find((link) => !children.has(link.name))?.name ?? description.base_link
        const visit = (link: string) => {
            for (const joint of description.joints) {
                if (joint.parent === link) {
                    this.#order.push(joint)
                    visit(joint.child)
                }
            }
        }
        visit(this.root)
        const mimicked = description.joints.map((joint) => joint.mimic?.joint).filter((name): name is string => !!name)
        this.gripperJoint = mimicked[0] ?? null
    }

    /** A joint's position from what's given: its own name, a prefixed name, or its mimic source. */
    position(joint: DescriptionJoint, positions: JointPositions): number {
        if (joint.mimic) {
            const source = this.joints.get(joint.mimic.joint)
            return source ? this.position(source, positions) * joint.mimic.multiplier + joint.mimic.offset : 0
        }
        return positions[joint.name] ?? 0
    }

    /** Every link's pose relative to the root link. */
    linkPoses(positions: JointPositions): Map<string, THREE.Matrix4> {
        const poses = new Map<string, THREE.Matrix4>([[this.root, new THREE.Matrix4()]])
        const motion = new THREE.Matrix4()
        const axis = new THREE.Vector3()
        for (const joint of this.#order) {
            const parent = poses.get(joint.parent) ?? new THREE.Matrix4()
            const pose = parent.clone().multiply(this.#origins.get(joint.name)!)
            const value = this.position(joint, positions)
            axis.set(...joint.axis).normalize()
            if (joint.type === "revolute" || joint.type === "continuous") {
                pose.multiply(motion.makeRotationAxis(axis, value))
            } else if (joint.type === "prismatic") {
                pose.multiply(motion.makeTranslation(axis.multiplyScalar(value)))
            }
            poses.set(joint.child, pose)
        }
        return poses
    }

    /** The chain of movable joints from `from` down to the link `to`, base first. */
    chain(to: string): DescriptionJoint[] {
        const chain: DescriptionJoint[] = []
        let link = to
        while (this.#byChild.has(link)) {
            const joint = this.#byChild.get(link)!
            if (joint.type !== "fixed" && !joint.mimic) {
                chain.unshift(joint)
            }
            link = joint.parent
        }
        return chain
    }

    /** Each movable joint's position read back from its child link's pose in its parent's (`relative(child, parent)`, e.g. TF). */
    positionsFrom(relative: (child: string, parent: string) => THREE.Matrix4 | null): JointPositions {
        const positions: JointPositions = {}
        const motion = new THREE.Matrix4()
        const rotation = new THREE.Quaternion()
        const translation = new THREE.Vector3()
        for (const joint of this.joints.values()) {
            if (joint.type !== "revolute" && joint.type !== "continuous" && joint.type !== "prismatic") {
                continue
            }
            const pose = relative(joint.child, joint.parent)
            if (!pose) {
                continue
            }
            motion.copy(this.#origins.get(joint.name)!).invert().multiply(pose)
            const axis = new THREE.Vector3(...joint.axis).normalize()
            if (joint.type === "prismatic") {
                positions[joint.name] = translation.setFromMatrixPosition(motion).dot(axis)
            } else {
                rotation.setFromRotationMatrix(motion)
                positions[joint.name] = 2 * Math.atan2(new THREE.Vector3(rotation.x, rotation.y, rotation.z).dot(axis), rotation.w)
            }
        }
        return positions
    }
}

/** URDF names for the joint state's names: `arm/joint1` → `joint1`, a gripper joint → the joint others mimic. */
export function urdfPositions(kinematics: Kinematics, joints: { name: string; position: number }[], isGripper: (name: string) => boolean): JointPositions {
    const positions: JointPositions = {}
    for (const { name, position } of joints) {
        if (kinematics.joints.has(name)) {
            positions[name] = position
        } else if (isGripper(name) && kinematics.gripperJoint) {
            positions[kinematics.gripperJoint] = position
        } else {
            const short = name.replace(/^.*\//, "")
            if (kinematics.joints.has(short)) {
                positions[short] = position
            }
        }
    }
    return positions
}

function decodeArray<T extends Float32Array | Uint32Array>(base64: string, Kind: { new (buffer: ArrayBuffer): T }): T {
    const text = atob(base64)
    const bytes = new Uint8Array(text.length)
    for (let index = 0; index < text.length; index++) {
        bytes[index] = text.charCodeAt(index)
    }
    return new Kind(bytes.buffer)
}

export type DisplayMode = "visual" | "collision" | "both"

/** The three.js arm: a group per link (named by it) placed by `pose`, holding its visual and collision meshes. */
export class RobotModel {
    readonly root = new THREE.Group()
    readonly links = new Map<string, THREE.Group>()
    readonly materials: THREE.MeshStandardMaterial[] = []

    constructor(readonly kinematics: Kinematics, geometries: Map<string, THREE.BufferGeometry>, look: { color?: string; opacity?: number; collisionColor?: string } = {}) {
        const material = (color: THREE.ColorRepresentation, alpha: number) => {
            const made = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, transparent: alpha < 1, opacity: alpha, depthWrite: alpha >= 1 })
            this.materials.push(made)
            return made
        }
        const shapeOf = (geometry: DescriptionGeometry, geometries: Map<string, THREE.BufferGeometry>): THREE.BufferGeometry | null => {
            switch (geometry.type) {
                case "mesh":
                    return geometry.mesh ? geometries.get(geometry.mesh) ?? null : null
                case "box":
                    return new THREE.BoxGeometry(...(geometry.size ?? [0.1, 0.1, 0.1]))
                case "sphere":
                    return new THREE.SphereGeometry(geometry.radius ?? 0.05, 24, 16)
                case "cylinder": {
                    // URDF cylinders run along z; three's along y
                    const cylinder = new THREE.CylinderGeometry(geometry.radius ?? 0.05, geometry.radius ?? 0.05, geometry.length ?? 0.1, 24)
                    cylinder.rotateX(Math.PI / 2)
                    return cylinder
                }
            }
        }
        this.#shapeOf = shapeOf
        this.#material = material
        this.#look = look
        for (const link of kinematics.description.links) {
            const group = new THREE.Group()
            group.name = link.name
            group.matrixAutoUpdate = false
            for (const [kind, items] of [["visual", link.visuals], ["collision", link.collisions]] as const) {
                for (const item of items) {
                    this.#pending.push({ group, kind, item })
                }
            }
            this.links.set(link.name, group)
            this.root.add(group)
        }
        this.fill(geometries)
    }

    readonly #pending: { group: THREE.Group; kind: "visual" | "collision"; item: DescriptionGeometry }[] = []
    readonly #shapeOf: (geometry: DescriptionGeometry, geometries: Map<string, THREE.BufferGeometry>) => THREE.BufferGeometry | null
    readonly #material: (color: THREE.ColorRepresentation, alpha: number) => THREE.MeshStandardMaterial
    readonly #look: { color?: string; opacity?: number; collisionColor?: string }
    #display: DisplayMode = "visual"
    #tint: { color: THREE.ColorRepresentation; opacity: number } | null = null

    /** Adds the meshes that have arrived since (a URDF's meshes load one by one); true if any was added. */
    fill(geometries: Map<string, THREE.BufferGeometry>): boolean {
        const opacity = this.#look.opacity ?? 1
        let added = false
        for (let index = this.#pending.length - 1; index >= 0; index--) {
            const { group, kind, item } = this.#pending[index]
            const shape = this.#shapeOf(item, geometries)
            if (!shape) {
                continue
            }
            this.#pending.splice(index, 1)
            const color = kind === "collision"
                ? this.#look.collisionColor ?? "#ff8a3d"
                : this.#look.color ?? (item.color ? new THREE.Color(item.color[0], item.color[1], item.color[2]) : "#d9dde3")
            const mesh = new THREE.Mesh(shape, this.#material(color, kind === "collision" ? Math.min(opacity, 0.45) : opacity * (item.color?.[3] ?? 1)))
            mesh.userData.kind = kind
            mesh.matrixAutoUpdate = false
            mesh.matrix.copy(originMatrix(item.origin))
            if (item.scale) {
                mesh.matrix.scale(new THREE.Vector3(...item.scale))
            }
            mesh.visible = this.#display === "both" || this.#display === kind
            group.add(mesh)
            added = true
        }
        if (added && this.#tint) {
            this.tint(this.#tint.color, this.#tint.opacity)
        }
        return added
    }

    /** Places every link for these joint positions. */
    pose(positions: JointPositions) {
        for (const [name, pose] of this.kinematics.linkPoses(positions)) {
            const group = this.links.get(name)
            if (group) {
                group.matrix.copy(pose)
                group.matrixWorldNeedsUpdate = true
            }
        }
    }

    /** Hides each link that sits where `other`'s does (within ~3 mm and ~1°): a ghost shows only what would move, and
     * never z-fights the real robot where they coincide. */
    showOnlyMoved(other: RobotModel) {
        for (const [name, group] of this.links) {
            const there = other.links.get(name)?.matrix.elements
            const here = group.matrix.elements
            group.visible = !there || here.some((value, index) => Math.abs(value - there[index]) > (index >= 12 ? 0.003 : 0.02))
        }
    }

    /** One color for every visual mesh (viser's target and preview ghosts). */
    tint(color: THREE.ColorRepresentation, opacity: number) {
        this.#tint = { color, opacity }
        this.root.traverse((object) => {
            const mesh = object as THREE.Mesh
            if (mesh.isMesh && mesh.userData.kind === "visual") {
                const material = mesh.material as THREE.MeshStandardMaterial
                material.color.set(color)
                material.opacity = opacity
                material.transparent = opacity < 1
                material.depthWrite = opacity >= 1
            }
        })
    }

    setDisplay(mode: DisplayMode) {
        this.#display = mode
        this.root.traverse((object) => {
            const kind = object.userData.kind as string | undefined
            if (kind) {
                object.visible = mode === "both" || mode === kind
            }
        })
    }

    dispose() {
        this.root.traverse((object) => {
            const mesh = object as THREE.Mesh
            // mesh geometries are shared between the real arm and the ghost: the owner disposes those
            if (mesh.isMesh && !mesh.geometry.userData.shared) {
                mesh.geometry.dispose()
            }
        })
        this.materials.forEach((material) => material.dispose())
    }
}

/** Every mesh in the description as a BufferGeometry, shared by every RobotModel built from it. */
export function meshGeometries(description: RobotDescription): Map<string, THREE.BufferGeometry> {
    const geometries = new Map<string, THREE.BufferGeometry>()
    for (const [name, mesh] of Object.entries(description.meshes)) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute("position", new THREE.BufferAttribute(decodeArray(mesh.vertices, Float32Array), 3))
        geometry.setIndex(new THREE.BufferAttribute(decodeArray(mesh.faces, Uint32Array), 1))
        geometry.computeVertexNormals()
        geometry.userData.shared = true
        geometries.set(name, geometry)
    }
    return geometries
}

/** The base link's pose in the base frame (the world, usually). */
export function basePose(description: RobotDescription): THREE.Matrix4 {
    return originMatrix(description.base_pose)
}
