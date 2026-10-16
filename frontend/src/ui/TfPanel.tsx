// The TF tree as an indented list, what's wrong with it, and which frame the view is fixed to.
import { useEffect, useRef, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import type { TfSnapshot } from "dimos-react/three"
import { Field, Select } from "dimos-react"

function Tree({ app, snapshot, frame, depth, chain = false, seen, hovered, flagged }: { app: ViewerApp; snapshot: TfSnapshot; frame: string; depth: number; chain?: boolean; seen: Set<string>; hovered: string | null; flagged: Set<string> }) {
    if (seen.has(frame) || depth > 64) {
        return null
    }
    seen.add(frame)
    const edge = snapshot.edges.find((other) => other.child === frame)
    const stale = snapshot.problems.stale.includes(frame)
    const children = snapshot.edges.filter((other) => other.parent === frame).map((other) => other.child).sort()
    return (
        <>
            <div
                className={`tf-frame ${stale ? "stale" : ""} ${flagged.has(frame) ? "flagged" : ""} ${hovered === frame ? "highlighted" : ""}`}
                style={{ paddingLeft: Math.min(depth, 8) * 12 + 4 }}
                data-frame={frame}
                title={`${frame}: hover to find it in the 3D view`}
                onPointerEnter={() => app.highlight.set(frame)}
                onPointerLeave={() => app.highlight.set(null)}
            >
                <span className="tf-name">{chain ? "↳ " : ""}{frame}</span>
                {edge && <span className="tf-age">{edge.isStatic ? "static" : `${Math.round(edge.ageMs)} ms`}</span>}
            </div>
            {/* an only child stays at its parent's indent (a chain like link1 → link7 reads down, not off the panel's edge) */}
            {children.map((child) => <Tree key={child} app={app} snapshot={snapshot} frame={child} depth={children.length > 1 ? depth + 1 : depth} chain={children.length === 1} seen={seen} hovered={hovered} flagged={flagged} />)}
        </>
    )
}

export function TfPanel({ app }: { app: ViewerApp }) {
    const view = useStore(app.settings)
    const frameInfo = useStore(app.frameInfo)
    const [snapshot, setSnapshot] = useState<TfSnapshot>(() => app.tf.snapshot())
    useEffect(() => {
        const timer = setInterval(() => setSnapshot(app.tf.snapshot()), 1000)
        return () => clearInterval(timer)
    }, [app])
    const highlight = useStore(app.highlight.state)
    // the highlight goes with the panel
    useEffect(() => () => app.highlight.set(null), [app])
    const { problems } = snapshot
    const { issues } = useStore(app.tfIssues)
    const flagged = new Set(issues.flatMap((issue) => issue.frames))
    // opened from the view's TF note: bring the first frame it's about into sight
    const tree = useRef<HTMLDivElement>(null)
    const scrolled = useRef(false)
    useEffect(() => {
        const first = tree.current?.querySelector(".tf-frame.flagged")
        if (first && !scrolled.current) {
            scrolled.current = true
            first.scrollIntoView({ block: "nearest" })
        }
    })
    return (
        <div className="tf-panel">
            <Field inline label="Fixed frame" title="everything is drawn relative to this frame">
                <Select value={view.fixedFrame} options={[["", `auto (${frameInfo.fixedFrame})`], ...snapshot.frames.map((frame) => [frame, frame] as [string, string])]} onChange={(fixedFrame) => app.settings.update({ fixedFrame })} />
            </Field>
            <p className="hint">Robot frame: {app.profile.baseFrame} {frameInfo.robotFound ? "(in TF)" : "(not in TF yet)"}</p>
            {issues.map((issue) => <p key={issue.kind + issue.summary} className="problem" title={issue.frames.join(", ")}>{issue.summary}: {issue.detail}</p>)}
            {!snapshot.frames.length && <p className="empty">no tf yet</p>}
            <div className="tf-tree" ref={tree} onPointerLeave={() => app.highlight.set(null)}>
                {problems.roots.map((root) => <Tree key={root} app={app} snapshot={snapshot} frame={root} depth={0} seen={new Set()} hovered={highlight.frame} flagged={flagged} />)}
            </div>
            {highlight.frame && !highlight.placed && <p className="hint">{highlight.frame} isn't connected to {frameInfo.fixedFrame}: it can't be shown in the view</p>}
        </div>
    )
}
