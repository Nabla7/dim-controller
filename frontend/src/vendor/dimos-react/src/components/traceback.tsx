// Python tracebacks (plain, chained and exception groups) split into frames, code, markers and exceptions, and drawn
// frame by frame: your own frames open in an editor, runs of library frames fold, what was raised sums it up.
import type { CSSProperties, HTMLAttributes, ReactNode } from "react"
import { cx } from "../cx.ts"

const FRAME = /^(\s*)File "(.+)", line (\d+)(?:, in (.*))?$/
const MARKER = /^\s*[\^~]+[\^~\s]*$/
const HEAD =
    /^(?:Exception Group )?Traceback \(most recent call last\):|^During handling of the above exception|^The above exception was the direct cause/
const LIBRARY =
    /\/site-packages\/|\/dist-packages\/|\/\.venv\/|\/lib\/python\d[\d.]*\/|\/uv\/python\/|\/nix\/store\/|^<frozen |^<string>/

export interface TracebackFrame {
    kind: "frame"
    /** an exception group's "| " / "+ " prefix */
    gutter: string
    indent: string
    file: string
    line: number
    func: string
    /** in an installed package or the standard library, not your own code */
    library: boolean
    code: { text: string; marker: boolean }[]
}

export type TracebackItem =
    | TracebackFrame
    | { kind: "head" | "text" | "sep"; gutter: string; text: string }
    | { kind: "exception"; gutter: string; depth: number; lines: string[] }

/** Whether a value is a Python traceback's text. */
export const isTraceback = (text: unknown): text is string =>
    typeof text === "string" && /Traceback \(most recent call last\):/.test(text)

const depthOf = (gutter: string) => Math.max(0, Math.round((gutter.search(/[|+]/) - 2) / 2))

/** A traceback's lines as frames (with their code and ^^^ markers), headers and the exceptions raised. */
export function parseTraceback(text: string): TracebackItem[] {
    const grouped = /^\s*\+ Exception Group Traceback/m.test(text)
    const items: TracebackItem[] = []
    for (const raw of text.replace(/\n$/, "").split("\n")) {
        const gutterMatch = grouped ? /^(\s*[|+](?: |$))?(.*)$/.exec(raw) : null
        const gutter = gutterMatch?.[1] ?? ""
        const body = gutterMatch ? gutterMatch[2] : raw
        if (grouped && /^\s*\+-[-+]*(\s.*)?$/.test(raw) && /-{4}/.test(raw)) {
            items.push({ kind: "sep", gutter: "", text: raw })
            continue
        }
        const frame = FRAME.exec(body)
        const previous = items.at(-1)
        if (frame) {
            items.push({
                kind: "frame",
                gutter,
                indent: frame[1],
                file: frame[2],
                line: Number(frame[3]),
                func: frame[4] ?? "",
                library: LIBRARY.test(frame[2]),
                code: [],
            })
        } else if (HEAD.test(body)) {
            items.push({ kind: "head", gutter, text: body })
        } else if (previous?.kind === "frame" && /^\s/.test(body) && body.trim()) {
            previous.code.push({ text: body, marker: MARKER.test(body) })
        } else if (!body.trim()) {
            items.push({ kind: "text", gutter, text: body })
        } else if (!/^\s/.test(body) && previous?.kind === "exception" && previous.gutter === gutter) {
            previous.lines.push(body)
        } else if (!/^\s/.test(body)) {
            items.push({ kind: "exception", gutter, depth: depthOf(gutter), lines: [body] })
        } else {
            items.push({ kind: "text", gutter, text: body })
        }
    }
    return items
}

/** What was raised, outermost first, with its nesting in an exception group. */
export const exceptionsOf = (items: TracebackItem[]): { depth: number; text: string }[] =>
    items.flatMap((item) => (item.kind === "exception" ? [{ depth: item.depth, text: item.lines.join("\n") }] : []))

export interface TracebackProps extends HTMLAttributes<HTMLDivElement> {
    text: string
    /** opens one of your own frames (its file as `formatPath` shows it); without it, frames are plain text */
    onOpenFile?: (file: string, line: number) => void
    /** how a file's path is shown and handed to onOpenFile (default: as written) */
    formatPath?: (file: string) => string
}

function Gutter({ text }: { text: string }) {
    return <span className="dr-tb__gutter">{text}</span>
}

function frameRows(
    frame: TracebackFrame,
    key: string,
    onOpenFile: TracebackProps["onOpenFile"],
    formatPath: (file: string) => string,
): ReactNode[] {
    const shown = `${formatPath(frame.file)}:${frame.line}`
    return [
        <div key={key} className={cx("dr-tb__row", frame.library ? "dr-tb__frame--lib" : "dr-tb__frame--own")}>
            <Gutter text={frame.gutter} />
            {frame.indent}
            {frame.library
                ? (
                    <span className="dr-tb__path" title={frame.file}>
                        {frame.file}:{frame.line}
                    </span>
                )
                : onOpenFile
                ? (
                    <button
                        type="button"
                        className="dr-tb__file"
                        title={`${frame.file}:${frame.line} (open in the editor)`}
                        data-tb-open
                        onClick={() => onOpenFile(formatPath(frame.file), frame.line)}
                    >
                        {shown}
                    </button>
                )
                : (
                    <span className="dr-tb__file" title={`${frame.file}:${frame.line}`}>
                        {shown}
                    </span>
                )}
            {frame.func ? <span className="dr-tb__func">in {frame.func}</span> : null}
        </div>,
        ...frame.code.map(({ text, marker }, index) => (
            <div
                key={`${key}.${index}`}
                className={cx(
                    "dr-tb__row",
                    marker ? "dr-tb__marker" : "dr-tb__code",
                    !frame.library && "dr-tb__code--own",
                )}
            >
                <Gutter text={frame.gutter} />
                {text}
            </div>
        )),
    ]
}

/**
 * A Python traceback drawn frame by frame: your own frames stand out (and open with `onOpenFile`), each run of library
 * frames folds into one line, and what was raised is summed up below, the innermost exception in bold.
 */
export function Traceback({ text, onOpenFile, formatPath = (file) => file, className, ...rest }: TracebackProps) {
    const items = parseTraceback(text)
    const rows: ReactNode[] = []
    for (let index = 0; index < items.length; index++) {
        const item = items[index]
        if (item.kind === "frame" && item.library) {
            let end = index
            while (items[end + 1]?.kind === "frame" && (items[end + 1] as TracebackFrame).library) {
                end += 1
            }
            const run = items.slice(index, end + 1) as TracebackFrame[]
            rows.push(
                <details key={index} className="dr-tb__lib">
                    <summary className="dr-tb__row">
                        <Gutter text={item.gutter} />
                        {item.indent}
                        {run.length} library frame{run.length === 1 ? "" : "s"}
                    </summary>
                    {run.flatMap((frame, at) => frameRows(frame, `${index}.${at}`, onOpenFile, formatPath))}
                </details>,
            )
            index = end
        } else if (item.kind === "frame") {
            rows.push(...frameRows(item, String(index), onOpenFile, formatPath))
        } else if (item.kind === "exception") {
            rows.push(
                ...item.lines.map((line, at) => (
                    <div key={`${index}.${at}`} className="dr-tb__row dr-tb__exc">
                        <Gutter text={item.gutter} />
                        {line}
                    </div>
                )),
            )
        } else {
            rows.push(
                <div key={index} className={cx("dr-tb__row", item.kind !== "text" && "dr-tb__dim")}>
                    <Gutter text={item.gutter} />
                    {item.text}
                </div>,
            )
        }
    }
    const raised = exceptionsOf(items)
    return (
        <div className={cx("dr-tb", className)} {...rest}>
            <div className="dr-tb__lines">{rows}</div>
            {raised.length > 0
                ? (
                    <div className="dr-tb__raised" data-tb-raised>
                        {raised.map(({ depth, text: what }, index) => {
                            const innermost = !(raised[index + 1]?.depth > depth) && !/^\w*ExceptionGroup:/.test(what)
                            return (
                                <div
                                    key={index}
                                    className={cx("dr-tb__raised-one", innermost && "dr-tb__raised-one--leaf")}
                                    style={{ "--dr-tb-depth": String(depth) } as CSSProperties}
                                >
                                    {what}
                                </div>
                            )
                        })}
                    </div>
                )
                : null}
        </div>
    )
}
