// A few seconds of every TF edge, so data can be placed with the transform from when it was seen (TfTree keeps only
// the latest). A point cloud looks its frame up here once, at its own timestamp, and keeps that placement: odom moving
// at 50 Hz must not drag a 10 Hz scan along between scans. Timestamps are the gateway's (message.timestamp, ms), the
// one clock both tf and the clouds carry (the compact cloud encoding drops the header stamp).
import { Matrix4, Quaternion, Vector3 } from "three"
import type { TfTree } from "dimos-react/three"

/** How far back each dynamic edge is kept. */
export const TF_HISTORY_MS = 5000

interface Sample {
    stamp: number
    translation: Vector3
    rotation: Quaternion
}

interface Edge {
    parent: string
    isStatic: boolean
    /** oldest first */
    samples: Sample[]
}

const unitScale = new Vector3(1, 1, 1)

export class TfHistory {
    #edges = new Map<string, Edge>()

    constructor(readonly tree: TfTree, readonly windowMs = TF_HISTORY_MS) {}

    /** Records T_parent_child at `stamp` (ms); rotation is x, y, z, w. */
    record(parent: string, child: string, translation: [number, number, number], rotation: [number, number, number, number], stamp: number, isStatic = false) {
        if (!parent || !child || parent === child) {
            return
        }
        let edge = this.#edges.get(child)
        if (!edge || edge.parent !== parent) {
            edge = { parent, isStatic, samples: [] } // a new parent: the old one's samples don't chain to it
            this.#edges.set(child, edge)
        }
        edge.isStatic ||= isStatic
        const quaternion = new Quaternion(...rotation)
        const sample = { stamp, translation: new Vector3(...translation), rotation: quaternion.lengthSq() < 1e-12 ? new Quaternion() : quaternion.normalize() }
        if (edge.isStatic) {
            edge.samples = [sample]
            return
        }
        const samples = edge.samples
        let index = samples.length
        while (index > 0 && samples[index - 1].stamp > stamp) {
            index-- // out of order (reliable delivery from several publishers): keep them sorted
        }
        samples.splice(index, 0, sample)
        const cutoff = samples[samples.length - 1].stamp - this.windowMs
        let drop = 0
        while (drop < samples.length - 1 && samples[drop].stamp < cutoff) {
            drop++
        }
        if (drop) {
            samples.splice(0, drop)
        }
    }

    /**
     * T_fixed_frame at `stamp`: each edge interpolated between its samples around it, or its newest sample when the
     * stamp is outside what's kept. Falls back to the live tree's (latest) lookup when this history has no path
     * (e.g. world/map standing in for each other with no tf). A new matrix each call: the caller may keep it.
     */
    lookupAt(frame: string, fixed: string, stamp: number): Matrix4 | null {
        if (frame !== fixed && frame !== "") {
            const from = this.#toRoot(frame, stamp)
            const to = this.#toRoot(fixed, stamp)
            if (from && to && from.root === to.root) {
                return (to.matrix ?? new Matrix4()).invert().multiply(from.matrix ?? new Matrix4())
            }
        }
        return this.tree.lookup(frame, fixed)?.clone() ?? null
    }

    /** The root above `frame` and T_root_frame at `stamp` (matrix null: `frame` is itself a root); null on a cycle. */
    #toRoot(frame: string, stamp: number): { root: string; matrix: Matrix4 | null } | null {
        let matrix: Matrix4 | null = null
        let current = frame
        for (let guard = 0; guard < 128; guard++) {
            const edge = this.#edges.get(current)
            if (!edge) {
                return { root: current, matrix }
            }
            matrix = (matrix ?? new Matrix4()).premultiply(edgeAt(edge.samples, stamp))
            current = edge.parent
        }
        return null
    }
}

/** One edge's transform at `stamp`: interpolated (lerp + slerp) between the samples around it, else the newest. */
export function edgeAt(samples: Sample[], stamp: number, out = new Matrix4()): Matrix4 {
    const newest = samples[samples.length - 1]
    if (samples.length < 2 || stamp < samples[0].stamp || stamp >= newest.stamp) {
        return out.compose(newest.translation, newest.rotation, unitScale)
    }
    let low = 0, high = samples.length - 1 // samples[low].stamp <= stamp < samples[high].stamp
    while (high - low > 1) {
        const middle = (low + high) >> 1
        if (samples[middle].stamp <= stamp) {
            low = middle
        } else {
            high = middle
        }
    }
    const before = samples[low], after = samples[high]
    const fraction = (stamp - before.stamp) / (after.stamp - before.stamp)
    return out.compose(before.translation.clone().lerp(after.translation, fraction), before.rotation.clone().slerp(after.rotation, fraction), unitScale)
}
