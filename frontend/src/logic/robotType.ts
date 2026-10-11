// Which kind of robot the Controller is for (dog, humanoid, wheeled, arm, drone), when Settings → Robot is "auto".
//
// The rule (README, "Robot type"), first match wins:
// 1. a running blueprint that robots.json lists under a typed robot (Desktop's GET /api/launcher/robots);
// 2. what's running looks like an arm: joint states / joint commands and no velocity input (cmd_vel) anywhere;
// 3. the robot set as the default in Desktop (its robots.json type);
// 4. a running blueprint's name (go2/spot → dog, g1 → humanoid, r1pro/alfred → wheeled, drone, xarm/piper/... → arm);
// 5. dog.
import type { RobotType } from "../profile/types.ts"
import { ROBOT_TYPES } from "../profile/types.ts"
import { type Module, takesVelocity } from "./cmdvel.ts"

/** Desktop's GET /api/launcher/robots: robots.json in the Launcher's words, `type` null when it doesn't say. */
export interface RobotsAnswer {
    defaultRobot?: string | null
    robots?: { id: string; type?: string | null; blueprints?: unknown }[]
}

export interface TypeEvidence {
    /** Desktop's robots (null: no Desktop, or it has no such endpoint) */
    robots: RobotsAnswer | null
    /** running blueprints → their modules (null = metadata unknown) */
    blueprints: Record<string, Module[] | null>
    /** topic names on the bridge, e.g. "/joint_states" */
    topics: string[]
}

export interface ResolvedType {
    type: RobotType
    /** why, in words, for the Settings hint */
    reason: string
}

/** A saved lv.view.profile → the chosen type, or null for auto. A profile name from before robot types (e.g. "Unitree
 * Go2") counts as auto: the page saved its default with every view setting, so it says nothing about a choice. */
export function chosenType(saved: string | undefined | null): RobotType | null {
    return saved && (ROBOT_TYPES as readonly string[]).includes(saved) ? saved as RobotType : null
}

const isType = (value: unknown): value is RobotType => typeof value === "string" && (ROBOT_TYPES as readonly string[]).includes(value)

/** The blueprint names a robots.json entry lists (an object keyed by name, or a list of names / {name}). */
function listed(blueprints: unknown): string[] {
    if (Array.isArray(blueprints)) {
        return blueprints.map((item) => (typeof item === "string" ? item : (item as { name?: string })?.name ?? "")).filter(Boolean)
    }
    return blueprints && typeof blueprints === "object" ? Object.keys(blueprints) : []
}

const JOINT_STREAM = /joint_(state|states|command|position|cmd)|^joint_|servo|gripper|ee_pose|cartesian/

/** A module's or topic's name that only an arm has. */
export const isArmStream = (name: string) => JOINT_STREAM.test(name.replace(/^\/+/, ""))

/** Arm-looking: some joint/gripper stream, and nothing takes a velocity command. */
export function looksLikeArm(blueprints: Record<string, Module[] | null>, topics: string[]): boolean {
    const streams = Object.values(blueprints).flatMap((modules) => (modules ?? []).flatMap((module) => (module.streams ?? []).map((stream) => stream.name)))
    const armish = [...streams, ...topics].some(isArmStream)
    const velocity = takesVelocity(blueprints) === true || topics.some((topic) => /cmd_vel/.test(topic))
    return armish && !velocity
}

const NAME_RULES: [RegExp, RobotType][] = [
    [/drone/, "drone"],
    [/\bg1\b|humanoid|unitree-g1/, "humanoid"],
    [/r1pro|alfred|wheel/, "wheeled"],
    [/xarm|piper|openyam|openarm|a1z|a750|lite6|manipulat|\barm\b|coordinator/, "arm"],
    [/go2|spot|m20|dog|quadruped/, "dog"],
]

/** A type from a blueprint's name, or null. */
export function typeFromName(name: string): RobotType | null {
    const words = name.toLowerCase().replace(/[_-]+/g, " ")
    return NAME_RULES.find(([pattern]) => pattern.test(words) || pattern.test(name.toLowerCase()))?.[1] ?? null
}

/** The auto type (the rule at the top of this file). */
export function resolveType(evidence: TypeEvidence): ResolvedType {
    const running = Object.keys(evidence.blueprints)
    const robots = evidence.robots?.robots ?? []
    for (const blueprint of running) {
        const robot = robots.find((each) => isType(each.type) && listed(each.blueprints).includes(blueprint))
        if (robot) {
            return { type: robot.type as RobotType, reason: `${blueprint} is a ${robot.id} blueprint (robots.json: ${robot.type})` }
        }
    }
    if (running.length && looksLikeArm(evidence.blueprints, evidence.topics)) {
        return { type: "arm", reason: `${running.join(", ")} has joint topics and no cmd_vel` }
    }
    const fallback = evidence.robots?.defaultRobot
    const remembered = fallback ? robots.find((each) => each.id === fallback) : undefined
    if (remembered && isType(remembered.type)) {
        return { type: remembered.type, reason: `Desktop's default robot is ${remembered.id} (${remembered.type})` }
    }
    for (const blueprint of running) {
        const type = typeFromName(blueprint)
        if (type) {
            return { type, reason: `from the blueprint's name (${blueprint})` }
        }
    }
    if (!running.length && looksLikeArm({}, evidence.topics)) {
        return { type: "arm", reason: "joint topics on the bridge and no cmd_vel" }
    }
    return { type: "dog", reason: "nothing says otherwise" }
}
