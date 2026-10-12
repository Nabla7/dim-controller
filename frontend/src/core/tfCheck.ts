// What's wrong with the live TF tree, worst first, for the view's footnote and the TF panel (the Recordings app's
// warnings.ts checks a recording the same way): a cycle, a frame with two parents, separate trees, a fixed frame or a
// drawn layer's frame_id with no path in the tree, and dynamic transforms that stopped while others keep coming.
import type { TfSnapshot } from "./tf.ts"

export type TfIssueKind = "cycle" | "twoParents" | "separateTrees" | "fixedFrame" | "unplaced" | "stale"

export interface TfIssue {
    kind: TfIssueKind
    /** one short line, e.g. "2 separate trees (odom, go2_odom)" */
    summary: string
    /** the longer why, for the TF panel */
    detail: string
    /** the frames to point at */
    frames: string[]
}

export interface TfCheckInput {
    snapshot: TfSnapshot
    fixedFrame: string
    /** the enabled layers' data frames (layer name, the frame_id its data is in) */
    layers: { name: string; frame: string }[]
    /** whether `frame` can be placed in the fixed frame (TfTree.lookup !== null) */
    placed: (frame: string) => boolean
}

/** A dynamic transform this much older than its newest sibling has stopped (tf_static is exempt). */
export const STALE_MS = 2000

const list = (names: string[], max = 3) => names.length > max ? `${names.slice(0, max).join(", ")}, +${names.length - max}` : names.join(", ")
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`

export function checkTf({ snapshot, fixedFrame, layers, placed }: TfCheckInput): TfIssue[] {
    const { edges, problems } = snapshot
    const issues: TfIssue[] = []
    const cycle = [...problems.cycle].sort()
    if (cycle.length) {
        issues.push({
            kind: "cycle",
            summary: `a cycle through ${list(cycle)}`,
            detail: `${cycle.join(", ")} ${cycle.length === 1 ? "is its own ancestor" : "are their own ancestors"}: none of them can be placed`,
            frames: cycle,
        })
    }
    for (const [child, parents] of problems.doubleParent) {
        issues.push({
            kind: "twoParents",
            summary: `"${child}" has ${parents.length} parents`,
            detail: `"${child}" is published under ${parents.join(" and ")}: tf allows one, so its pose flips between them`,
            frames: [child, ...parents],
        })
    }
    const parentOf = new Map(edges.map((edge) => [edge.child, edge.parent]))
    const rootOf = (frame: string) => {
        let at = frame
        for (let step = 0; step <= parentOf.size && parentOf.has(at); step++) {
            at = parentOf.get(at)!
        }
        return at
    }
    const frames = new Set(edges.flatMap((edge) => [edge.parent, edge.child]))
    if (problems.roots.length > 1) {
        // the fixed frame's tree first: the others are the ones that can't be drawn
        const fixedRoot = frames.has(fixedFrame) ? rootOf(fixedFrame) : null
        const roots = [...problems.roots].sort((a, b) => Number(b === fixedRoot) - Number(a === fixedRoot))
        const sizes = roots.map((root) => `${root} (${[...frames].filter((frame) => rootOf(frame) === root).length})`)
        issues.push({
            kind: "separateTrees",
            summary: `${roots.length} separate trees (${list(roots)})`,
            detail: `roots ${sizes.join(", ")}: frames in different trees can't be placed relative to each other` +
                (fixedRoot ? `, so only ${fixedRoot}'s tree can be drawn in "${fixedFrame}"` : ""),
            frames: [...frames].filter((frame) => rootOf(frame) !== fixedRoot).sort(),
        })
    }
    if (frames.size && !frames.has(fixedFrame) && !problems.roots.some(placed)) {
        issues.push({
            kind: "fixedFrame",
            summary: `fixed frame "${fixedFrame}" isn't in the tree`,
            detail: `nothing in tf connects to "${fixedFrame}": pick a fixed frame from the tree`,
            frames: problems.roots,
        })
    }
    const unplaced = new Map<string, string[]>()
    for (const { name, frame } of layers) {
        if (frame && !placed(frame)) {
            unplaced.set(frame, [...(unplaced.get(frame) ?? []), name])
        }
    }
    for (const [frame, names] of [...unplaced].sort(([a], [b]) => a.localeCompare(b))) {
        const inTree = frames.has(frame)
        issues.push({
            kind: "unplaced",
            summary: inTree ? `"${frame}" isn't connected to "${fixedFrame}" (${list(names, 2)})` : `"${frame}" isn't in the tree (${list(names, 2)})`,
            detail: `${names.join(", ")} ${names.length === 1 ? "is" : "are"} in "${frame}", which ` +
                (inTree ? `has no tf path to "${fixedFrame}"` : "tf never publishes") + ", so nothing places it in the view",
            frames: [frame],
        })
    }
    const dynamic = edges.filter((edge) => !edge.isStatic)
    const freshest = Math.min(...dynamic.map((edge) => edge.ageMs))
    // only while others still update: when everything pauses (sim paused, connection gone) nothing in particular broke
    const stale = dynamic.filter((edge) => edge.ageMs > STALE_MS && edge.ageMs - freshest > STALE_MS).sort((a, b) => a.child.localeCompare(b.child))
    if (stale.length) {
        const oldest = Math.max(...stale.map((edge) => edge.ageMs))
        issues.push({
            kind: "stale",
            summary: stale.length === 1 ? `${stale[0].parent} → ${stale[0].child} stopped ${seconds(stale[0].ageMs)} ago` : `${stale.length} transforms stopped updating`,
            detail: `${stale.map((edge) => `${edge.parent} → ${edge.child}`).join(", ")}: no update for up to ${seconds(oldest)} while other transforms keep arriving`,
            frames: stale.map((edge) => edge.child),
        })
    }
    return issues
}

// separate trees by their roots (the summary), not their frames, which grow as frames arrive
const keyOf = (issue: TfIssue) => `${issue.kind}:${issue.kind === "separateTrees" ? issue.summary : issue.frames.join(",")}`

/** The issues in `next` that were also in `previous`: a problem must last two checks before it's shown (frames arrive one by one at startup). */
export function confirmed(previous: TfIssue[], next: TfIssue[]): TfIssue[] {
    const seen = new Set(previous.map(keyOf))
    return next.filter((issue) => seen.has(keyOf(issue)))
}
