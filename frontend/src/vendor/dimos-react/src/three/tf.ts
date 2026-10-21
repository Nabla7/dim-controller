// The transform tree from tf / tf_static (ported from dim-controller core/tf.ts). Everything drawn is placed by
// looking its header's frame_id up here, relative to the fixed frame the view is in; a frame with no path to it is
// reported, never drawn at the origin. Pure: no DOM, only three's math.
import { Matrix4, Quaternion, Vector3 } from "three"

/** A dynamic edge older than this is "stale" (tf_static is exempt: it publishes rarely). */
export const STALE_MS = 2000
/** Frames commonly used as the world, in preference order, when picking a default fixed frame. */
export const WORLD_NAMES = ["world", "map", "odom"]
/** How far back (ms) each dynamic edge keeps its stamped samples for lookupAt (ported from dim-controller core/tfHistory.ts). */
export const TF_HISTORY_MS = 5000

const scratchVector = new Vector3()
const scratchQuaternion = new Quaternion()
const unitScale = new Vector3(1, 1, 1)
const clock = () => globalThis.performance?.now() ?? Date.now()

export interface TfProblems {
    doubleParent: [string, string[]][]
    roots: string[]
    cycle: string[]
    stale: string[]
}

export interface TfSnapshotEdge {
    parent: string
    child: string
    isStatic: boolean
    ageMs: number
}

export interface TfSnapshot {
    frames: string[]
    edges: TfSnapshotEdge[]
    problems: TfProblems
}

interface TfSample {
    stamp: number
    translation: Vector3
    rotation: Quaternion
}

interface TfEdge {
    parent: string
    matrix: Matrix4
    isStatic: boolean
    receivedAt: number
    /** stamped samples, oldest first, within TF_HISTORY_MS of the newest (dynamic edges only) */
    samples: TfSample[]
}

export class TfTree {
    #edges: Map<string, TfEdge> = new Map()
    #parentsSeen: Map<string, Set<string>> = new Map()
    #cache: Map<string, Matrix4 | null> = new Map()
    #cacheFixed = ""
    #listeners: Set<(version: number) => void> = new Set()
    /** bumped on every change, so layers know when to re-place what they drew */
    version = 0
    now: () => number
    readonly historyMs: number
    /**
     * @param options `now`: the clock (ms) for staleness; tests pass a fake one. `historyMs`: how far back lookupAt
     *   can see (default TF_HISTORY_MS)
     */
    constructor({ now = clock, historyMs = TF_HISTORY_MS }: { now?: () => number; historyMs?: number } = {}) {
        this.now = now
        this.historyMs = historyMs
    }

    /**
     * Sets T_parent_child.
     * @param rotation quaternion x, y, z, w
     * @param stamp when it held (ms, the clock data timestamps are in): kept for lookupAt
     */
    set(
        parent: string,
        child: string,
        translation: [number, number, number],
        rotation: [number, number, number, number],
        isStatic: boolean = false,
        stamp?: number,
    ) {
        if (!parent || !child || parent === child) {
            return
        }
        let edge = this.#edges.get(child)
        if (!edge) {
            edge = { parent, matrix: new Matrix4(), isStatic, receivedAt: 0, samples: [] }
            this.#edges.set(child, edge)
        }
        if (edge.parent !== parent) {
            edge.samples = [] // the old parent's samples don't chain to the new one
        }
        edge.parent = parent
        edge.isStatic = isStatic || edge.isStatic
        edge.receivedAt = this.now()
        const quaternion = scratchQuaternion.set(...rotation)
        if (quaternion.lengthSq() < 1e-12) {
            quaternion.set(0, 0, 0, 1)
        }
        edge.matrix.compose(scratchVector.set(...translation), quaternion.normalize(), unitScale)
        if (stamp !== undefined && !edge.isStatic) {
            recordSample(edge.samples, stamp, scratchVector, quaternion, this.historyMs)
        }
        let parents = this.#parentsSeen.get(child)
        if (!parents) {
            parents = new Set()
            this.#parentsSeen.set(child, parents)
        }
        parents.add(parent)
        this.#changed()
    }

    /**
     * Feeds a decoded tf2_msgs.TFMessage (or an array of geometry_msgs.TransformStamped); `stamp` (ms) as in set().
     */
    // deno-lint-ignore no-explicit-any -- decoded TFMessage of any shape
    setMessage(message: any, isStatic: boolean = false, stamp?: number) {
        const transforms = Array.isArray(message) ? message : (message?.transforms ?? [])
        for (const stamped of transforms) {
            const { translation, rotation } = stamped?.transform ?? {}
            if (!translation || !rotation) {
                continue
            }
            this.set(
                stamped.header?.frame_id ?? "",
                stamped.child_frame_id ?? "",
                [translation.x ?? 0, translation.y ?? 0, translation.z ?? 0],
                [rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0, rotation.w ?? 1],
                isStatic,
                stamp,
            )
        }
    }

    /** Forgets every edge. */
    clear() {
        this.#edges.clear()
        this.#parentsSeen.clear()
        this.#changed()
    }

    #changed() {
        this.#cache.clear()
        this.version++
        for (const listener of [...this.#listeners]) {
            listener(this.version)
        }
    }

    /** `listener(version)` after every change. Returns unsubscribe. */
    onChange(listener: (version: number) => void): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    /** Whether the tree knows `frame` (as a child or a parent). */
    has(frame: string): boolean {
        return this.#edges.has(frame) || [...this.#edges.values()].some((edge) => edge.parent === frame)
    }

    /** The parent of `frame`, or null for a root / unknown frame. */
    parentOf(frame: string): string | null {
        return this.#edges.get(frame)?.parent ?? null
    }

    /** The root above `frame` and T_root_frame, or null on a cycle. */
    #toRoot(frame: string): { root: string; matrix: Matrix4 } | null {
        const matrix = new Matrix4()
        let current = frame
        for (let guard = 0; guard < 128; guard++) {
            const edge = this.#edges.get(current)
            if (!edge) {
                return { root: current, matrix }
            }
            matrix.premultiply(edge.matrix)
            current = edge.parent
        }
        return null
    }

    /**
     * T_fixed_frame: places data in `frame` into the fixed frame. An empty frame or the fixed frame itself is identity;
     * null when there is no path (different trees, unknown frame, a cycle). The result is cached: don't mutate it.
     */
    lookup(frame: string, fixed: string): Matrix4 | null {
        if (fixed !== this.#cacheFixed) {
            this.#cache.clear()
            this.#cacheFixed = fixed
        }
        const cached = this.#cache.get(frame)
        if (cached !== undefined) {
            return cached
        }
        let result: Matrix4 | null = null
        if (frame === fixed || frame === "") {
            result = new Matrix4()
        } else {
            const from = this.#toRoot(frame)
            const to = this.#toRoot(fixed)
            if (from && to && from.root === to.root) {
                result = to.matrix.clone().invert().multiply(from.matrix)
            } else if (
                from &&
                !this.has(fixed) &&
                from.root === frame &&
                WORLD_NAMES.includes(frame) &&
                WORLD_NAMES.includes(fixed)
            ) {
                // no tf for either world-ish name (a map in "world" while nothing publishes tf): the same frame
                result = new Matrix4()
            }
        }
        this.#cache.set(frame, result)
        return result
    }

    /**
     * T_fixed_frame as it was at `stamp` (ms): each edge interpolated between its stamped samples around it, else its
     * latest. Place data with its own timestamp, so a 50 Hz odom doesn't drag a 10 Hz scan along between scans. No
     * stamp, or no path through the history: lookup(). A new matrix each call: the caller may keep it.
     */
    lookupAt(frame: string, fixed: string, stamp: number | undefined): Matrix4 | null {
        if (stamp !== undefined && frame !== fixed && frame !== "") {
            const from = this.#toRootAt(frame, stamp)
            const to = this.#toRootAt(fixed, stamp)
            if (from && to && from.root === to.root) {
                return to.matrix.invert().multiply(from.matrix)
            }
        }
        return this.lookup(frame, fixed)?.clone() ?? null
    }

    #toRootAt(frame: string, stamp: number): { root: string; matrix: Matrix4 } | null {
        const matrix = new Matrix4()
        const step = new Matrix4()
        let current = frame
        for (let guard = 0; guard < 128; guard++) {
            const edge = this.#edges.get(current)
            if (!edge) {
                return { root: current, matrix }
            }
            matrix.premultiply(edge.samples.length ? sampleAt(edge.samples, stamp, step) : edge.matrix)
            current = edge.parent
        }
        return null
    }

    /** The fixed frame to default to: a world-ish root if there is one, else the root of the biggest tree. */
    defaultFixedFrame(): string {
        const roots = this.#roots()
        for (const name of WORLD_NAMES) {
            if (roots.includes(name)) {
                return name
            }
        }
        for (const name of WORLD_NAMES) {
            if (this.has(name)) {
                return name
            }
        }
        let best = roots[0] ?? "world"
        let bestSize = -1
        for (const root of roots) {
            const size = [...this.#edges.keys()].filter((child) => this.#toRoot(child)?.root === root).length
            if (size > bestSize) {
                best = root
                bestSize = size
            }
        }
        return best
    }

    #roots(): string[] {
        const roots: Set<string> = new Set()
        for (const edge of this.#edges.values()) {
            if (!this.#edges.has(edge.parent)) {
                roots.add(edge.parent)
            }
        }
        return [...roots].sort()
    }

    /** Every frame name, sorted. */
    frames(): string[] {
        const frames: Set<string> = new Set()
        for (const [child, edge] of this.#edges) {
            frames.add(child)
            frames.add(edge.parent)
        }
        return [...frames].sort()
    }

    snapshot(): TfSnapshot {
        const now = this.now()
        const edges: TfSnapshotEdge[] = []
        for (const [child, edge] of this.#edges) {
            edges.push({ parent: edge.parent, child, isStatic: edge.isStatic, ageMs: now - edge.receivedAt })
        }
        return {
            frames: this.frames(),
            edges,
            problems: {
                doubleParent: [...this.#parentsSeen]
                    .filter(([, parents]) => parents.size > 1)
                    .map(([child, parents]): [string, string[]] => [child, [...parents]]),
                roots: this.#roots(),
                cycle: [...this.#edges.keys()].filter((child) => this.#toRoot(child) === null),
                stale: edges.filter((edge) => !edge.isStatic && edge.ageMs > STALE_MS).map((edge) => edge.child),
            },
        }
    }
}

/** Inserts a sample in stamp order (out-of-order delivery from several publishers) and drops ones past the window. */
function recordSample(
    samples: TfSample[],
    stamp: number,
    translation: Vector3,
    rotation: Quaternion,
    windowMs: number,
) {
    let index = samples.length
    while (index > 0 && samples[index - 1].stamp > stamp) {
        index--
    }
    samples.splice(index, 0, { stamp, translation: translation.clone(), rotation: rotation.clone() })
    const cutoff = samples[samples.length - 1].stamp - windowMs
    let drop = 0
    while (drop < samples.length - 1 && samples[drop].stamp < cutoff) {
        drop++
    }
    if (drop) {
        samples.splice(0, drop)
    }
}

/** One edge at `stamp`: lerp + slerp between the samples around it, else the nearest end. */
function sampleAt(samples: TfSample[], stamp: number, out: Matrix4): Matrix4 {
    const newest = samples[samples.length - 1]
    if (samples.length < 2 || stamp >= newest.stamp) {
        return out.compose(newest.translation, newest.rotation, unitScale)
    }
    if (stamp <= samples[0].stamp) {
        return out.compose(samples[0].translation, samples[0].rotation, unitScale)
    }
    let low = 0
    let high = samples.length - 1 // samples[low].stamp <= stamp < samples[high].stamp
    while (high - low > 1) {
        const middle = (low + high) >> 1
        if (samples[middle].stamp <= stamp) {
            low = middle
        } else {
            high = middle
        }
    }
    const before = samples[low]
    const after = samples[high]
    const fraction = (stamp - before.stamp) / (after.stamp - before.stamp)
    return out.compose(
        scratchVector.copy(before.translation).lerp(after.translation, fraction),
        scratchQuaternion.copy(before.rotation).slerp(after.rotation, fraction),
        unitScale,
    )
}
