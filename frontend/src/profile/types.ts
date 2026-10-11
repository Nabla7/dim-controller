// What a robot profile can say. A fork for a new robot copies one of the profiles next to this file and edits it;
// nothing under src/core needs to change. See README "Fork this for your robot".
import type { LcmValue } from "../lcm.ts"

/** The drive axes keys, sticks and buttons push; each is -1..1. */
export type Axis = "forward" | "strafe" | "turn" | "vertical"
export type Axes = Record<Axis, number>

export interface Speeds {
    /** m/s at full stick */
    linear: number
    /** rad/s at full stick */
    angular: number
    /** m/s for the vertical axis (drones, lifts) */
    vertical: number
}

export interface Twist {
    linear: [number, number, number]
    angular: [number, number, number]
}

/** What a key does: hold to push an axis, or step / press one of the profile's controls. */
export type KeyAction =
    | { axis: Axis; value: number }
    | { control: string; step?: number }

/** An extra control in the drive panel. It only publishes while drive is armed. */
export type Control =
    | {
        kind: "slider"
        id: string
        label: string
        /** dimos topic and message type it publishes, e.g. "/torso_height", "std_msgs.Float32" */
        topic: string
        type: string
        min: number
        max: number
        step: number
        initial: number
        unit?: string
        /** the message for a value (fields as in the LCM schema; missing fields are zero) */
        message: (value: number) => LcmValue
    }
    | {
        kind: "button"
        id: string
        label: string
        topic: string
        type: string
        message: () => LcmValue
    }

/** The five kinds of robot (Desktop's Launcher draws the same five icons; robots.json's `type`). */
export const ROBOT_TYPES = ["dog", "humanoid", "wheeled", "arm", "drone"] as const
export type RobotType = typeof ROBOT_TYPES[number]

/** The end effector's jog axes: linear x/y/z and roll/pitch/yaw, in the arm's base frame. */
export const EE_AXES = ["x", "y", "z", "roll", "pitch", "yaw"] as const
export type EeAxis = typeof EE_AXES[number]

/** What a key does on an arm: hold to move the end effector along an axis, or set the gripper (0 closed … 1 open). */
export type ArmKeyAction = { ee: EeAxis; value: number } | { gripper: number }

export interface ArmProfile {
    /** end-effector jog speed: m/s for x/y/z, rad/s for roll/pitch/yaw */
    linear: number
    angular: number
    /** joint jog speed, rad/s (the coordinator's own velocity limit still applies) */
    jointSpeed: number
    /** KeyboardEvent.code → action */
    keys: Record<string, ArmKeyAction>
    /** slider range for joints without a limit here, rad (dimos publishes no joint limits) */
    defaultLimit: [number, number]
    /** per-joint slider ranges by joint name, rad */
    limits: Record<string, [number, number]>
}

export interface RobotProfile {
    /** which kind of robot: the key the Robot picker and settings use (lv.view.profile, lv.drive.<type>) */
    type: RobotType
    /** shown in the Robot picker */
    name: string
    /** the robot's TF frame: the camera follows it */
    baseFrame: string
    /** the fixed frame to view in; "" picks one from the TF tree (world, map, odom, ...) */
    fixedFrame: string
    drive: {
        /** candidates in preference order; the first one on the bridge wins, else the first */
        cmdVelTopics: string[]
        speeds: Speeds
        /** Shift multiplies linear speed by `linear` and angular by `angular` */
        boost: { linear: number; angular: number }
        /** commands per second while a control is held */
        publishHz: number
        /** the bridge publishes a zero twist after this long without hearing from the page */
        deadmanMs: number
        /** KeyboardEvent.code → action */
        keys: Record<string, KeyAction>
        /** axes → Twist; the default maps forward/strafe/vertical/turn onto linear x/y/z and angular z */
        twist?: (axes: Axes, speeds: Speeds) => Twist
    }
    controls: Control[]
    /** an arm's jog speeds and keys (the arm panel replaces the drive controls) */
    arm?: ArmProfile
    /** how far the camera starts from the robot, m */
    viewDistance?: number
    cameras: {
        /** image topics to show first, in preference order (the first on the bridge wins) */
        preferred: string[]
        /** image topic → its CameraInfo topic, when the names don't make it obvious */
        cameraInfo: Record<string, string>
    }
}

export function defaultTwist(axes: Axes, speeds: Speeds): Twist {
    return {
        linear: [axes.forward * speeds.linear, axes.strafe * speeds.linear, axes.vertical * speeds.vertical],
        angular: [0, 0, axes.turn * speeds.angular],
    }
}
