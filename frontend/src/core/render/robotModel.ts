// A small stand-in model of the robot at its pose, one per robot type (the Launcher's five icons, in 3D): a dog on four
// legs, a humanoid, a wheeled base, a quad-rotor drone. Real-world sized, +x forward (REP-103), base_link at the body's
// center (ground robots stand on z = -height). An arm has no stand-in: its own TF frames are the arm (layers/armLinks).
import * as THREE from "three"
import type { RobotType } from "../../profile/types.ts"

const BODY = 0x5fb4e6
const DARK = 0x26323f

function material(color: number, opacity = 0.85) {
    return new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 })
}

function box(x: number, y: number, z: number, at: [number, number, number], color = BODY) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), material(color))
    mesh.position.set(...at)
    return mesh
}

function cylinder(radius: number, length: number, at: [number, number, number], axis: "x" | "y" | "z", color = DARK) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 20), material(color))
    mesh.position.set(...at)
    // CylinderGeometry runs along y
    if (axis === "x") {
        mesh.rotation.z = Math.PI / 2
    } else if (axis === "z") {
        mesh.rotation.x = Math.PI / 2
    }
    return mesh
}

/** A nose cone so you can tell which way it faces. */
function heading(at: [number, number, number], size: number) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(size * 0.5, size, 16), material(0xf5b14c, 0.95))
    cone.rotation.z = -Math.PI / 2
    cone.position.set(...at)
    return cone
}

function dog(): THREE.Group {
    const group = new THREE.Group()
    group.add(box(0.6, 0.26, 0.14, [0, 0, 0]))
    group.add(box(0.14, 0.18, 0.12, [0.33, 0, 0.04], DARK))
    for (const x of [0.22, -0.22]) {
        for (const y of [0.13, -0.13]) {
            group.add(cylinder(0.025, 0.3, [x, y, -0.2], "z"))
        }
    }
    group.add(heading([0.45, 0, 0.04], 0.08))
    return group
}

function humanoid(): THREE.Group {
    const group = new THREE.Group()
    group.add(box(0.18, 0.34, 0.4, [0, 0, 0.25]))
    group.add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), material(DARK)))
    group.children.at(-1)!.position.set(0, 0, 0.56)
    for (const y of [0.1, -0.1]) {
        group.add(cylinder(0.04, 0.6, [0, y, -0.28], "z"))
    }
    for (const y of [0.22, -0.22]) {
        group.add(cylinder(0.03, 0.42, [0, y, 0.22], "z"))
    }
    group.add(heading([0.16, 0, 0.56], 0.07))
    return group
}

function wheeled(): THREE.Group {
    const group = new THREE.Group()
    group.add(box(0.55, 0.45, 0.18, [0, 0, 0]))
    for (const x of [0.17, -0.17]) {
        for (const y of [0.25, -0.25]) {
            group.add(cylinder(0.09, 0.06, [x, y, -0.06], "y"))
        }
    }
    group.add(heading([0.33, 0, 0.02], 0.09))
    return group
}

function drone(): THREE.Group {
    const group = new THREE.Group()
    group.add(box(0.16, 0.16, 0.07, [0, 0, 0]))
    for (const angle of [45, 135, 225, 315]) {
        const radians = (angle * Math.PI) / 180
        const arm = box(0.26, 0.025, 0.02, [Math.cos(radians) * 0.13, Math.sin(radians) * 0.13, 0], DARK)
        arm.rotation.z = radians
        group.add(arm)
        const rotor = cylinder(0.08, 0.008, [Math.cos(radians) * 0.24, Math.sin(radians) * 0.24, 0.03], "z", BODY)
        ;(rotor.material as THREE.MeshLambertMaterial).opacity = 0.45
        group.add(rotor)
    }
    group.add(heading([0.13, 0, 0], 0.06))
    return group
}

const MAKERS: Partial<Record<RobotType, () => THREE.Group>> = { dog, humanoid, wheeled, drone }

/** The stand-in for a type (null for an arm: TF draws it). */
export function robotModel(type: RobotType): THREE.Group | null {
    const group = MAKERS[type]?.() ?? null
    if (group) {
        group.name = `robot-model-${type}`
        group.matrixAutoUpdate = false
        group.renderOrder = 1
    }
    return group
}

export function disposeModel(group: THREE.Group) {
    group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
            object.geometry.dispose()
            ;(object.material as THREE.Material).dispose()
        }
    })
}
