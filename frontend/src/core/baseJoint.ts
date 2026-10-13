// The joint control next to driving (a profile's `joint`; the R1's torso, which sets how low it stands): one joint of
// the joint state, picked per robot type (lv.drive.<type>'s `joint`), held to jog. It goes through the arm's joint jog
// (core/arm.ts), so it stops the same way: a release, STOP, Space or Escape holds the joint where it is, a quiet page
// leaves it at most LEAD_S of motion past where it was, and while driving is disengaged nothing is sent.
import { isGripperJoint } from "./armTopics.ts"
import type { ArmControl } from "./arm.ts"
import type { Drive } from "./drive.ts"

/** A twist base's virtual joints (dimos make_twist_base_joints: base/vx … base/wz), driven by velocity, not targets. */
const TWIST_JOINT = /(^|\/)(vx|vy|vz|wx|wy|wz)$/
/** wheels and steering are the chassis' velocity task's, never position targets */
const CHASSIS_JOINT = /wheel|steer|caster/i

/** The joints a position target can move, in the joint state's order. */
export const movableJoints = (names: string[]): string[] => names.filter((name) => !isGripperJoint(name) && !TWIST_JOINT.test(name) && !CHASSIS_JOINT.test(name))

/** The joint to jog: the saved pick if the robot has it, else the first torso or lift joint, else the first. */
export function pickJoint(movable: string[], saved: string | undefined): string | null {
    if (saved && movable.includes(saved)) {
        return saved
    }
    return movable.find((name) => /torso|lift/i.test(name)) ?? movable[0] ?? null
}

/** The picked joint of what the robot reports now (null: no joint state). */
export const pickedJoint = (arm: ArmControl, drive: Drive): string | null => pickJoint(movableJoints(arm.state.get().joints.map((joint) => joint.name)), drive.settings.get().joint)

/** Hold to jog the picked joint (sign +1 / -1); `arm.releaseJoint()` stops it. */
export function jogPicked(arm: ArmControl, drive: Drive, sign: number) {
    const name = pickedJoint(arm, drive)
    if (!name) {
        arm.state.update({ error: `no joint state on ${arm.state.get().topics.jointState ?? "the bridge"}: nothing to move` })
        return
    }
    arm.jogJoint(name, sign)
}
