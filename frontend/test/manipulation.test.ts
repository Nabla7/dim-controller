// The arm's 3D manipulation: forward kinematics from a dimos.robot_description.v1 (mimic joints, prefixed and gripper
// joint names), IK reaching a pose the arm can reach and saying when it can't, and a plan sampled for the preview.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import * as THREE from "three"
import { Kinematics, meshGeometries, type RobotDescription, RobotModel, urdfPositions } from "../src/core/robotDescription.ts"
import { solveIk } from "../src/core/ik.ts"
import { Manipulation, type ManipulationPlan } from "../src/core/manipulation.ts"

const I = { xyz: [0, 0, 0] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] }
const at = (x: number, y: number, z: number) => ({ xyz: [x, y, z] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] })
const b64 = (array: Float32Array | Uint32Array) => btoa(String.fromCharCode(...new Uint8Array(array.buffer)))

/** a 3-joint arm: a yaw base, then two pitch joints with 0.4 m links, a tip 0.1 m on, and a two-finger gripper */
const description: RobotDescription = {
    format: "dimos.robot_description.v1",
    name: "test_arm",
    base_link: "base",
    base_frame: "world",
    base_pose: at(0, 0, 0.12),
    joint_names: ["j1", "j2", "j3"],
    links: ["world", "base", "l1", "l2", "l3", "tip", "finger_a", "finger_b"].map((name) => ({
        name,
        visuals: name === "l1" ? [{ type: "mesh" as const, mesh: "tri", origin: I, scale: [1, 1, 1] as [number, number, number] }] : name === "l2" ? [{ type: "box" as const, size: [0.05, 0.05, 0.4] as [number, number, number], origin: at(0, 0, 0.2) }] : [],
        collisions: name === "l2" ? [{ type: "cylinder" as const, radius: 0.03, length: 0.4, origin: at(0, 0, 0.2) }] : [],
    })),
    joints: [
        { name: "fixed_base", type: "fixed", parent: "world", child: "base", origin: I, axis: [1, 0, 0] },
        { name: "j1", type: "revolute", parent: "base", child: "l1", origin: at(0, 0, 0.1), axis: [0, 0, 1], limit: [-3, 3] },
        { name: "j2", type: "revolute", parent: "l1", child: "l2", origin: I, axis: [0, 1, 0], limit: [-2, 2] },
        { name: "j3", type: "revolute", parent: "l2", child: "l3", origin: at(0, 0, 0.4), axis: [0, 1, 0], limit: [-2.5, 2.5] },
        { name: "tool", type: "fixed", parent: "l3", child: "tip", origin: at(0, 0, 0.4), axis: [1, 0, 0] },
        { name: "drive", type: "prismatic", parent: "tip", child: "finger_a", origin: I, axis: [0, 1, 0], limit: [0, 0.04] },
        { name: "follow", type: "prismatic", parent: "tip", child: "finger_b", origin: I, axis: [0, 1, 0], limit: [-0.04, 0], mimic: { joint: "drive", multiplier: -1, offset: 0 } },
    ],
    meshes: { tri: { vertices: b64(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0])), faces: b64(new Uint32Array([0, 1, 2])) } },
}

const tipOf = (kinematics: Kinematics, positions: Record<string, number>) => new THREE.Vector3().setFromMatrixPosition(kinematics.linkPoses(positions).get("tip")!)

Deno.test("forward kinematics: straight up at zero, then folded", () => {
    const kinematics = new Kinematics(description)
    assertEquals(kinematics.root, "world")
    const up = tipOf(kinematics, {})
    assertAlmostEquals(up.z, 0.9, 1e-9)
    // j2 = 90° tips the whole arm over +x (a +y rotation turns z toward x)
    const over = tipOf(kinematics, { j2: Math.PI / 2 })
    assertAlmostEquals(over.x, 0.8, 1e-9)
    assertAlmostEquals(over.z, 0.1, 1e-9)
    // and j1 = 90° swings that toward +y
    const swung = tipOf(kinematics, { j1: Math.PI / 2, j2: Math.PI / 2 })
    assertAlmostEquals(swung.y, 0.8, 1e-9)
    assertEquals(kinematics.chain("tip").map((joint) => joint.name), ["j1", "j2", "j3"])
})

Deno.test("mimic joints follow, and the joint state's names map to the URDF's", () => {
    const kinematics = new Kinematics(description)
    assertEquals(kinematics.gripperJoint, "drive")
    const positions = urdfPositions(kinematics, [{ name: "arm/j1", position: 0.3 }, { name: "j2", position: 0.1 }, { name: "arm/gripper", position: 0.02 }, { name: "other", position: 9 }], (name) => /gripper/.test(name))
    assertEquals(positions, { j1: 0.3, j2: 0.1, drive: 0.02 })
    const poses = kinematics.linkPoses(positions)
    const a = new THREE.Vector3().setFromMatrixPosition(poses.get("finger_a")!).sub(new THREE.Vector3().setFromMatrixPosition(poses.get("tip")!))
    const b = new THREE.Vector3().setFromMatrixPosition(poses.get("finger_b")!).sub(new THREE.Vector3().setFromMatrixPosition(poses.get("tip")!))
    assertAlmostEquals(a.length(), 0.02, 1e-9)
    assertAlmostEquals(a.dot(b), -0.0004, 1e-9)
})

Deno.test("IK reaches a pose the arm can reach and says when one is out of reach", () => {
    const kinematics = new Kinematics(description)
    const wanted = { j1: 0.4, j2: 0.6, j3: 0.9 }
    const target = kinematics.linkPoses(wanted).get("tip")!
    const result = solveIk(kinematics, "tip", target, { j1: 0, j2: 0.1, j3: 0.1 })
    assert(result.reachable, `error ${result.positionError} m, ${result.angleError} rad`)
    const reached = tipOf(kinematics, result.positions)
    assert(reached.distanceTo(new THREE.Vector3().setFromMatrixPosition(target)) < 0.01)
    for (const [name, value] of Object.entries(result.positions)) {
        const limit = kinematics.joints.get(name)?.limit
        assert(!limit || (value >= limit[0] - 1e-9 && value <= limit[1] + 1e-9), `${name} ${value} outside ${limit}`)
    }
    const far = new THREE.Matrix4().makeTranslation(3, 0, 0.5)
    assertEquals(solveIk(kinematics, "tip", far, {}).reachable, false)
})

Deno.test("the model: a group per link, posed, with visual or collision shown", () => {
    const kinematics = new Kinematics(description)
    const model = new RobotModel(kinematics, meshGeometries(description))
    model.pose({ j2: Math.PI / 2 })
    const l3 = new THREE.Vector3().setFromMatrixPosition(model.links.get("l3")!.matrix)
    assertAlmostEquals(l3.x, 0.4, 1e-9)
    const kinds = (visible: boolean) => {
        const found: string[] = []
        model.root.traverse((object) => object.userData.kind && object.visible === visible && found.push(object.userData.kind))
        return found.sort()
    }
    assertEquals(kinds(true), ["visual", "visual"])
    model.setDisplay("collision")
    assertEquals(kinds(true), ["collision"])
    model.setDisplay("both")
    assertEquals(kinds(false), [])
    model.dispose()
})

Deno.test("a plan sampled for the preview: between points, clamped at both ends", () => {
    const plan: ManipulationPlan = {
        id: "p",
        group: "manipulator",
        duration: 2,
        jointNames: ["j1", "j2"],
        times: [0, 1, 2],
        positions: [[0, 0], [1, -1], [1, 1]],
        target: { mode: "joint", group: "manipulator" },
    }
    assertEquals(Manipulation.sample(plan, 0), { j1: 0, j2: 0 })
    assertEquals(Manipulation.sample(plan, 0.5), { j1: 0.5, j2: -0.5 })
    assertEquals(Manipulation.sample(plan, 1.5), { j1: 1, j2: 0 })
    assertEquals(Manipulation.sample(plan, 9), { j1: 1, j2: 1 })
})
