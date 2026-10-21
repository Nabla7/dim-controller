// The three.js model of a robot description (dimos-react's RobotDescription: a URDF from dimos's RobotDescriptionModule
// or parseUrdf), posed by its Kinematics, with its links' groups, meshes and Gaussian splats shown or hidden. The
// description itself, its forward kinematics and IK are dimos-react's (dimos-react/three).
import * as THREE from "three"
import type { DescriptionGeometry, JointPositions, Origin, RobotDescription } from "dimos-react/three"
import { Kinematics } from "dimos-react/three"
import type { SplatAsset, SplatObject } from "./splats.ts"

export { basePose, Kinematics, meshGeometries, ROBOT_DESCRIPTION_FORMAT, urdfPositions } from "dimos-react/three"
export type { DescriptionGeometry, DescriptionJoint, DescriptionLink, JointPositions, Origin, RobotDescription } from "dimos-react/three"

const originMatrix = (origin: Origin) =>
    new THREE.Matrix4().compose(new THREE.Vector3(...origin.xyz), new THREE.Quaternion(...origin.quat), new THREE.Vector3(1, 1, 1))

export type DisplayMode = "visual" | "collision" | "both"
/** What the model draws, each shown or not: the links in no group (the robot's own), each group's links (by name;
 * unset: shown), and across those, mesh files and Gaussian splat files. */
export interface ModelParts {
    robot: boolean
    groups: Record<string, boolean>
    meshes: boolean
    splats: boolean
}

/** Settings saved before groups: `people` (dim-go2-sim's people), `meshes` (then the scene's alone) and `splatView`
 * ("splats", "meshes" or "both", before the splats / meshes toggles). */
interface OldParts {
    people?: boolean
    splatView?: string
}

/** The parts a layer's saved settings show. One saved before groups carries its People toggle over to the "people"
 * group; its Meshes toggle (then the scene's meshes alone, now every mesh) is dropped. */
export function modelPartsOf(saved: Partial<ModelParts> & OldParts): ModelParts {
    const splats = saved.splats ?? saved.splatView !== "meshes"
    if (!saved.groups) {
        return { robot: saved.robot ?? true, groups: saved.people === undefined ? {} : { people: saved.people }, meshes: true, splats }
    }
    return { robot: saved.robot ?? true, groups: saved.groups, meshes: saved.meshes ?? true, splats }
}

/** Each link's group: its own `<group>`, else that of the link it's fixed to (the parent of a fixed joint), else none. */
export function linkGroups(description: RobotDescription): Map<string, string> {
    const groups = new Map(description.links.filter((link) => link.group).map((link) => [link.name, link.group!]))
    const fixed = description.joints.filter((joint) => joint.type === "fixed")
    for (let grew = true; grew;) {
        grew = false
        for (const joint of fixed) {
            const inherited = groups.get(joint.parent)
            if (inherited && !groups.has(joint.child)) {
                groups.set(joint.child, inherited)
                grew = true
            }
        }
    }
    return groups
}

/** The groups the description's links name, first seen first. */
export function groupNames(description: RobotDescription): string[] {
    return [...new Set(description.links.map((link) => link.group).filter((group): group is string => !!group))]
}

/** The three.js arm: a group per link (named by it) placed by `pose`, holding its visual and collision meshes. */
export class RobotModel {
    readonly root = new THREE.Group()
    readonly links = new Map<string, THREE.Group>()
    readonly materials: THREE.MeshStandardMaterial[] = []

    /** `splats`: splat files by URI (core/urdfSource.ts), drawn where a visual names one; none for ghosts */
    constructor(readonly kinematics: Kinematics, geometries: Map<string, THREE.BufferGeometry>, look: { color?: string; opacity?: number; collisionColor?: string } = {}, readonly splats?: Map<string, SplatAsset>) {
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
        this.#groups = linkGroups(kinematics.description)
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
    #parts: ModelParts = { robot: true, groups: {}, meshes: true, splats: true }
    readonly #groups: Map<string, string>
    #textures = true
    #cutAbove: number | null = null
    #tint: { color: THREE.ColorRepresentation; opacity: number } | null = null

    /** Adds the meshes that have arrived since (a URDF's meshes load one by one); true if any was added. */
    fill(geometries: Map<string, THREE.BufferGeometry>): boolean {
        const opacity = this.#look.opacity ?? 1
        let added = false
        for (let index = this.#pending.length - 1; index >= 0; index--) {
            const { group, kind, item } = this.#pending[index]
            const splats = item.mesh ? this.splats?.get(item.mesh) : undefined
            if (splats) {
                this.#pending.splice(index, 1)
                const splatMesh = splats.mesh()
                splatMesh.opacity = opacity
                splatMesh.setCutAbove(this.#cutAbove)
                splatMesh.userData.kind = kind
                splatMesh.userData.splat = true
                splatMesh.matrixAutoUpdate = false
                splatMesh.matrix.copy(originMatrix(item.origin))
                if (item.scale) {
                    splatMesh.matrix.scale(new THREE.Vector3(...item.scale))
                }
                group.userData.hasSplats = true
                group.add(splatMesh)
                added = true
                continue
            }
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
            mesh.userData.meshFile = item.type === "mesh"
            mesh.userData.textured = mesh.material
            mesh.matrixAutoUpdate = false
            mesh.matrix.copy(originMatrix(item.origin))
            if (item.scale) {
                mesh.matrix.scale(new THREE.Vector3(...item.scale))
            }
            group.add(mesh)
            added = true
        }
        if (added) {
            this.#applyVisibility()
            this.#applyTextures()
            if (this.#tint) {
                this.tint(this.#tint.color, this.#tint.opacity)
            }
        }
        return added
    }

    /** true once any link draws splats */
    get hasSplats(): boolean {
        return [...this.links.values()].some((group) => group.userData.hasSplats)
    }

    /** Each object shown by the display mode (visual / collision), its link's group (or, in none, the robot's) toggle,
     * and its file's: splats or meshes. */
    #applyVisibility() {
        for (const [name, link] of this.links) {
            const group = this.#groups.get(name)
            const linkShown = group === undefined ? this.#parts.robot : this.#parts.groups[group] ?? true
            for (const object of link.children) {
                const kind = object.userData.kind as string | undefined
                if (!kind) {
                    continue
                }
                const fileShown = object.userData.splat ? this.#parts.splats : object.userData.meshFile ? this.#parts.meshes : true
                object.visible = (this.#display === "both" || this.#display === kind) && linkShown && fileShown
            }
        }
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
                for (const material of [mesh.userData.textured, mesh.userData.plain] as (THREE.MeshStandardMaterial | undefined)[]) {
                    if (material) {
                        material.color.set(color)
                        material.opacity = opacity
                        material.transparent = opacity < 1
                        material.depthWrite = opacity >= 1
                    }
                }
            }
        })
    }

    /** Each visual mesh in its own material (URDF colours), or with textures off a flat-shaded grey at the same opacity. */
    #applyTextures() {
        this.root.traverse((object) => {
            const mesh = object as THREE.Mesh
            if (!mesh.isMesh || mesh.userData.kind !== "visual" || !mesh.userData.textured) {
                return
            }
            const textured = mesh.userData.textured as THREE.MeshStandardMaterial
            if (!this.#textures && !mesh.userData.plain) {
                const plain = this.#material(this.#tint?.color ?? "#9aa0a6", textured.opacity)
                plain.flatShading = true
                mesh.userData.plain = plain
            }
            mesh.material = this.#textures ? textured : mesh.userData.plain
        })
    }

    setDisplay(mode: DisplayMode) {
        this.#display = mode
        this.#applyVisibility()
    }

    /** Which parts show: the robot, each group, mesh files, splat files, each on or off. */
    setParts(parts: ModelParts) {
        this.#parts = { ...parts, groups: { ...parts.groups } }
        this.#applyVisibility()
    }

    /** Visual meshes in their materials (on) or plain flat grey, to see the geometry (off). */
    setTextures(on: boolean) {
        this.#textures = on
        this.#applyTextures()
    }

    /** Hides splats above this height (m) in their file's frame (a scene's is the world); null shows them all. */
    setSplatCutAbove(height: number | null) {
        this.#cutAbove = height
        this.root.traverse((object) => object.userData.splat && (object as SplatObject).setCutAbove(height))
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
