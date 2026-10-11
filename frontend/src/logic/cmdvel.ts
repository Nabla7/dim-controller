// Which topics the drive output goes to ("auto"), and whether the running blueprints take velocity commands at all.
//
// The rule (README, "Driving: which topics"):
// - A velocity input is a module input stream whose name contains `cmd_vel` (cmd_vel, tele_cmd_vel, cmd_vel_in, …)
//   and whose type is a Twist or TwistStamped.
// - With the running blueprints' metadata (Desktop's GET /dimos/blueprints/<name>): every module that has velocity
//   inputs gets ONE topic, its entry point:
//     - an input that a velocity-consuming module of the same blueprint outputs (a teleop mux like MovementManager
//       outputs cmd_vel to the robot) is internal: publishing there would bypass the mux, so it's skipped;
//     - of the rest, one per module (so two topics never feed the same module): tele_* first, then exactly cmd_vel,
//       then any other, nav_* (a planner's) last;
//     - each with its own message type (Twist or TwistStamped).
// - Without metadata (no Desktop, or it can't describe the blueprint): the standard set, /cmd_vel and /tele_cmd_vel
//   as Twist. `dimos/cmd_vel` is the same zenoh key as /cmd_vel (dimos/cmd_vel/geometry_msgs.Twist), so it's one topic.
// - Topics with the same zenoh key are published once.

export const TWIST = "geometry_msgs.Twist"
export const TWIST_STAMPED = "geometry_msgs.TwistStamped"
export type VelocityType = typeof TWIST | typeof TWIST_STAMPED

export interface Stream {
    name: string
    type?: string
    direction?: string
}
export interface Module {
    name?: string
    streams?: Stream[]
}
export interface DriveTopic {
    topic: string
    type: VelocityType
    /** the module it feeds, when known */
    module?: string
}

/** What auto publishes to without blueprint metadata. */
export const STANDARD_TOPICS: DriveTopic[] = [
    { topic: "/cmd_vel", type: TWIST },
    { topic: "/tele_cmd_vel", type: TWIST },
    { topic: "dimos/cmd_vel", type: TWIST },
]

export const isCmdVel = (name: string) => /cmd_vel/.test(name)

/** Twist / TwistStamped from a dimos stream type ("dimos.msgs.geometry_msgs.Twist.Twist"), else null. */
export function velocityType(type: string | undefined): VelocityType | null {
    if (/TwistStamped(\.TwistStamped)?$/.test(type ?? "")) {
        return TWIST_STAMPED
    }
    if (/(^|\.)Twist(\.Twist)?$/.test(type ?? "")) {
        return TWIST
    }
    return null
}

/** The zenoh key a topic and type publish on: "/cmd_vel" and "dimos/cmd_vel" are both dimos/cmd_vel/<type>. */
export function zenohKey(topic: string, type: string): string {
    const bare = topic.replace(/^\/+/, "")
    return `${bare.startsWith("dimos/") ? bare : `dimos/${bare}`}/${type}`
}

const isInput = (stream: Stream) => stream.direction !== "out"

/** The velocity inputs of a module (name contains cmd_vel, Twist-typed). */
export function velocityInputs(module: Module): Stream[] {
    return (module.streams ?? []).filter((stream) => isInput(stream) && isCmdVel(stream.name) && velocityType(stream.type))
}

const preference = (name: string) => (/tele/.test(name) ? 0 : name === "cmd_vel" ? 1 : /^nav_/.test(name) ? 3 : 2)

/** The entry points of one blueprint (see the rule above). */
export function entryPoints(modules: Module[]): DriveTopic[] {
    const internal = new Set<string>()
    for (const module of modules) {
        if (velocityInputs(module).length) {
            for (const stream of module.streams ?? []) {
                if (stream.direction === "out") {
                    internal.add(stream.name)
                }
            }
        }
    }
    const topics: DriveTopic[] = []
    for (const module of modules) {
        const [best] = velocityInputs(module)
            .filter((stream) => !internal.has(stream.name))
            .sort((a, b) => preference(a.name) - preference(b.name) || a.name.localeCompare(b.name))
        if (best) {
            topics.push({ topic: "/" + best.name.replace(/^\/+/, ""), type: velocityType(best.type)!, module: module.name })
        }
    }
    return topics
}

/** One per zenoh key, first wins. */
export function uniqueByKey(topics: DriveTopic[]): DriveTopic[] {
    const seen = new Set<string>()
    return topics.filter((topic) => {
        const key = zenohKey(topic.topic, topic.type)
        return seen.has(key) ? false : (seen.add(key), true)
    })
}

/**
 * What auto publishes to: the entry points of every running blueprint whose metadata is known (`null` = unknown);
 * the standard set when none is known.
 */
export function autoTopics(blueprints: Record<string, Module[] | null>): DriveTopic[] {
    const known = Object.values(blueprints).filter((modules): modules is Module[] => modules !== null)
    if (known.length === 0) {
        return uniqueByKey(STANDARD_TOPICS)
    }
    return uniqueByKey(known.flatMap(entryPoints))
}

/**
 * Whether the running blueprints take velocity commands: true / false from their metadata, null when it isn't known
 * for any of them (then nobody can say, so no warning). False only when every known one has no velocity input and
 * none is unknown.
 */
export function takesVelocity(blueprints: Record<string, Module[] | null>): boolean | null {
    const all = Object.values(blueprints)
    if (all.length === 0) {
        return null
    }
    if (all.some((modules) => modules !== null && modules.some((module) => velocityInputs(module).length > 0))) {
        return true
    }
    return all.some((modules) => modules === null) ? null : false
}

/** Topics the user typed: "/my_cmd_vel" or "/my_cmd_vel TwistStamped"; the type from metadata if it names it, else Twist. */
export function parseTopics(text: string[], blueprints: Record<string, Module[] | null>): DriveTopic[] {
    const known = new Map<string, VelocityType>()
    for (const modules of Object.values(blueprints)) {
        for (const module of modules ?? []) {
            for (const stream of module.streams ?? []) {
                const type = velocityType(stream.type)
                if (type) {
                    known.set(stream.name.replace(/^\/+/, ""), type)
                }
            }
        }
    }
    return uniqueByKey(text.map((line) => line.trim()).filter(Boolean).map((line) => {
        const [name, kind] = line.split(/\s+/)
        const topic = name.startsWith("/") || name.startsWith("dimos/") ? name : "/" + name
        const type = kind ? (/stamped/i.test(kind) ? TWIST_STAMPED : TWIST) : known.get(topic.replace(/^\/+/, "")) ?? TWIST
        return { topic, type }
    }))
}
