// Inverse kinematics for the ghost arm while the gizmo is dragged: damped least squares on the planning group's chain
// (a numeric Jacobian of the forward kinematics), within the joint limits. It only shows where the arm could go and
// whether the pose looks reachable; the plan itself is the ManipulationModule's (collision-checked).
import * as THREE from "three"
import type { JointPositions, Kinematics } from "./description.ts"

export interface IkResult {
    positions: JointPositions
    /** meters and radians left between the tip and the target */
    positionError: number
    angleError: number
    reachable: boolean
}

const STEP = 1e-4
const DAMPING = 0.05
const POSITION_TOLERANCE = 0.005
const ANGLE_TOLERANCE = 0.03
/** how much an angle error weighs against a meter of position error */
const ANGLE_WEIGHT = 0.3

/** The 6-vector from the tip's pose to the target: position (m) and rotation vector (rad, weighted). */
function errorVector(tip: THREE.Matrix4, target: THREE.Matrix4): number[] {
    const tipPosition = new THREE.Vector3().setFromMatrixPosition(tip)
    const targetPosition = new THREE.Vector3().setFromMatrixPosition(target)
    const tipRotation = new THREE.Quaternion().setFromRotationMatrix(tip)
    const targetRotation = new THREE.Quaternion().setFromRotationMatrix(target)
    const delta = targetRotation.multiply(tipRotation.invert())
    if (delta.w < 0) {
        delta.set(-delta.x, -delta.y, -delta.z, -delta.w)
    }
    const angle = 2 * Math.acos(Math.min(1, delta.w))
    const sine = Math.sqrt(Math.max(0, 1 - delta.w * delta.w))
    const axis = sine > 1e-9 ? new THREE.Vector3(delta.x / sine, delta.y / sine, delta.z / sine) : new THREE.Vector3()
    const position = targetPosition.sub(tipPosition)
    return [
        position.x,
        position.y,
        position.z,
        axis.x * angle * ANGLE_WEIGHT,
        axis.y * angle * ANGLE_WEIGHT,
        axis.z * angle * ANGLE_WEIGHT,
    ]
}

/** Solves (A + λ²I) x = b for a small symmetric A (Gaussian elimination). */
function solve(matrix: number[][], vector: number[]): number[] {
    const size = vector.length
    const rows = matrix.map((row, index) => [...row, vector[index]])
    for (let column = 0; column < size; column++) {
        let pivot = column
        for (let row = column + 1; row < size; row++) {
            if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) {
                pivot = row
            }
        }
        ;[rows[column], rows[pivot]] = [rows[pivot], rows[column]]
        const lead = rows[column][column] || 1e-12
        for (let row = 0; row < size; row++) {
            if (row !== column) {
                const factor = rows[row][column] / lead
                for (let index = column; index <= size; index++) {
                    rows[row][index] -= factor * rows[column][index]
                }
            }
        }
    }
    return rows.map((row, index) => row[size] / (row[index] || 1e-12))
}

/**
 * Moves the chain's joints so the link `tip` (pose relative to the kinematics' root) reaches `target`, starting from
 * `seed` (the joints not in the chain keep their seed value). `movable`: only these of the chain's joints move (an
 * arm's group, not the torso it hangs from). `positionOnly`: only the target's position counts; the tip turns however
 * reaches it. `weights`: how readily each joint moves (default 1); a small one (a torso's) moves only as much as the
 * others can't make up (weighted damped least squares).
 */
export function solveIk(
    kinematics: Kinematics,
    tip: string,
    target: THREE.Matrix4,
    seed: JointPositions,
    movable?: Set<string>,
    positionOnly = false,
    weights: Record<string, number> = {},
    iterations = 80,
): IkResult {
    const chain = kinematics.chain(tip).filter((joint) => !movable || movable.has(joint.name))
    const positions: JointPositions = { ...seed }
    const tipOf = (values: JointPositions) => kinematics.linkPoses(values).get(tip) ?? new THREE.Matrix4()
    const clamp = (name: string, value: number) => {
        const limit = kinematics.joints.get(name)?.limit
        return limit ? Math.min(limit[1], Math.max(limit[0], value)) : value
    }
    const errorOf = (pose: THREE.Matrix4) => {
        const error = errorVector(pose, target)
        return positionOnly ? [error[0], error[1], error[2], 0, 0, 0] : error
    }
    let error = errorOf(tipOf(positions))
    for (let iteration = 0; iteration < iterations; iteration++) {
        const norm = Math.hypot(error[0], error[1], error[2])
        const angle = Math.hypot(error[3], error[4], error[5]) / ANGLE_WEIGHT
        if (norm < POSITION_TOLERANCE && angle < ANGLE_TOLERANCE) {
            break
        }
        // the Jacobian, one column per joint, by finite differences
        // each column scaled by the joint's weight's root: dq = W^½ (J W^½)ᵀ (J W J ᵀ + λ² I)⁻¹ e
        const scales = chain.map((joint) => Math.sqrt(weights[joint.name] ?? 1))
        const jacobian = chain.map((joint, index) => {
            const moved = { ...positions, [joint.name]: (positions[joint.name] ?? 0) + STEP }
            const shifted = errorOf(tipOf(moved))
            return error.map((value, row) => scales[index] * (value - shifted[row]) / STEP)
        })
        // dq = Jᵀ (J Jᵀ + λ² I)⁻¹ e
        const product = Array.from(
            { length: 6 },
            (_, row) =>
                Array.from(
                    { length: 6 },
                    (_, column) =>
                        jacobian.reduce((sum, joint) => sum + joint[row] * joint[column], 0) +
                        (row === column ? DAMPING * DAMPING : 0),
                ),
        )
        const step = solve(product, error)
        chain.forEach((joint, index) => {
            const change = scales[index] * jacobian[index].reduce((sum, value, row) => sum + value * step[row], 0)
            positions[joint.name] = clamp(joint.name, (positions[joint.name] ?? 0) + change)
        })
        error = errorOf(tipOf(positions))
    }
    const positionError = Math.hypot(error[0], error[1], error[2])
    const angleError = Math.hypot(error[3], error[4], error[5]) / ANGLE_WEIGHT
    return {
        positions,
        positionError,
        angleError,
        reachable: positionError < POSITION_TOLERANCE * 2 && angleError < ANGLE_TOLERANCE * 2,
    }
}
