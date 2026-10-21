// Data display: tables, trees, key/value readouts, stats, lists, logs, code, sparklines, an attitude indicator and a
// timeline scrubber.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type {
    HTMLAttributes,
    Key,
    KeyboardEvent as ReactKeyboardEvent,
    MouseEvent as ReactMouseEvent,
    PointerEvent as ReactPointerEvent,
    ReactNode,
    Ref,
    SVGAttributes,
} from "react"
import { cx } from "../cx.ts"
import { Icon } from "./icon.tsx"
import { copyText } from "../hooks.ts"

const useIsoLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect

/** Controlled when `value` is given, else internal state seeded from `initial`. */
function useControllable<T>(value: T | undefined, initial: T, onChange?: (next: T) => void): [T, (next: T) => void] {
    const [inner, setInner] = useState(initial)
    const controlled = value !== undefined
    const current = controlled ? value : inner
    const set = (next: T) => {
        if (!controlled) {
            setInner(next)
        }
        onChange?.(next)
    }
    return [current, set]
}

// ── Table ──

const compareValues = (a: unknown, b: unknown) => {
    if (a === b) {
        return 0
    }
    if (a === undefined || a === null) {
        return 1
    }
    if (b === undefined || b === null) {
        return -1
    }
    if (typeof a === "number" && typeof b === "number") {
        return a - b
    }
    return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/** A row's field by name (rows are the caller's records, of any shape). */
const field = (row: unknown, key: string): unknown => (row as Record<string, unknown> | null | undefined)?.[key]

export interface TableColumn<Row> {
    /** the row field it shows (and its React key) */
    key: string
    label?: ReactNode
    /** the cell (default: the field as text) */
    render?: (row: Row, index: number) => ReactNode
    /** sortable; a function sorts by it instead of by the value */
    sort?: boolean | ((a: Row, b: Row) => number)
    align?: "left" | "right" | "center"
    width?: string | number
    /** what to sort by (default: the field) */
    value?: (row: Row) => unknown
}

export interface TableSort {
    key: string
    dir: "asc" | "desc"
}

export interface TableProps<Row> extends HTMLAttributes<HTMLDivElement> {
    columns: TableColumn<Row>[]
    rows: Row[]
    /** a field name, or `(row, index) => key` (default: row.id, row.key, the index) */
    rowKey?: string | ((row: Row, index: number) => Key)
    sort?: TableSort | null
    onSortChange?: (sort: TableSort | null) => void
    defaultSort?: TableSort | null
    onRowClick?: (row: Row, index: number) => void
    /** the selected row's key */
    selected?: Key | null
    empty?: ReactNode
    sticky?: boolean
    compact?: boolean
    maxHeight?: string | number
    /** false: the rows arrive already sorted (by a backend); the headers still show and change `sort` */
    sortRows?: boolean
}

/**
 * A sortable table. `sortRows: false`: the rows arrive already sorted (by a backend); the headers still show and change
 * `sort`.
 */
export function Table<Row>({
    columns,
    rows = [],
    rowKey,
    sort,
    onSortChange,
    defaultSort = null,
    onRowClick,
    selected,
    empty = "Nothing here yet",
    sticky = true,
    compact = false,
    maxHeight,
    sortRows = true,
    className,
    style,
    ...rest
}: TableProps<Row>) {
    const [currentSort, setSort] = useControllable(sort, defaultSort, onSortChange)
    const sorted = useMemo(() => {
        if (!currentSort || !sortRows) {
            return rows
        }
        const column = columns.find((item) => item.key === currentSort.key)
        if (!column) {
            return rows
        }
        const read = column.value ?? ((row: Row) => field(row, column.key))
        const compare = typeof column.sort === "function"
            ? column.sort
            : (a: Row, b: Row) => compareValues(read(a), read(b))
        const out = [...rows].sort(compare)
        return currentSort.dir === "desc" ? out.reverse() : out
    }, [rows, columns, currentSort?.key, currentSort?.dir, sortRows])
    const keyOf = (row: Row, index: number): Key =>
        typeof rowKey === "function"
            ? rowKey(row, index)
            : rowKey
            ? (field(row, rowKey) as Key)
            : ((field(row, "id") ?? field(row, "key") ?? index) as Key)
    const onHeader = (column: TableColumn<Row>) => {
        if (!column.sort) {
            return
        }
        if (currentSort?.key !== column.key) {
            setSort({ key: column.key, dir: "asc" })
        } else if (currentSort.dir === "asc") {
            setSort({ key: column.key, dir: "desc" })
        } else {
            setSort(null)
        }
    }
    return (
        <div className={cx("dr-table-wrap", "dr-scroll", className)} style={{ maxHeight, ...style }} {...rest}>
            <table className={cx("dr-table", compact && "dr-table--compact", sticky && "dr-table--sticky")}>
                <thead>
                    <tr>
                        {columns.map((column) => {
                            const active = currentSort?.key === column.key
                            return (
                                <th
                                    key={column.key}
                                    style={{ width: column.width, textAlign: column.align }}
                                    className={cx(column.sort && "dr-table__sortable", active && "dr-table__sorted")}
                                    onClick={() => onHeader(column)}
                                    aria-sort={active
                                        ? (currentSort!.dir === "asc" ? "ascending" : "descending")
                                        : undefined}
                                >
                                    <span>{column.label ?? column.key}</span>
                                    {column.sort
                                        ? (
                                            <Icon
                                                name={active
                                                    ? currentSort!.dir === "asc" ? "chevron-up" : "chevron-down"
                                                    : "sort"}
                                                size={12}
                                                className="dr-table__sort-icon"
                                            />
                                        )
                                        : null}
                                </th>
                            )
                        })}
                    </tr>
                </thead>
                <tbody>
                    {sorted.length === 0
                        ? (
                            <tr>
                                <td className="dr-table__empty" colSpan={columns.length}>
                                    {empty}
                                </td>
                            </tr>
                        )
                        : (
                            sorted.map((row, index) => {
                                const key = keyOf(row, index)
                                return (
                                    <tr
                                        key={key}
                                        className={cx(
                                            onRowClick && "dr-table__clickable",
                                            selected === key && "dr-table__selected",
                                        )}
                                        onClick={onRowClick ? () => onRowClick(row, index) : undefined}
                                    >
                                        {columns.map((column) => (
                                            <td key={column.key} style={{ textAlign: column.align }}>
                                                {column.render
                                                    ? column.render(row, index)
                                                    : String(field(row, column.key) ?? "")}
                                            </td>
                                        ))}
                                    </tr>
                                )
                            })
                        )}
                </tbody>
            </table>
        </div>
    )
}

// ── Tree ──

export interface TreeNode {
    id: string
    label?: ReactNode
    children?: this[]
    icon?: string
    badge?: ReactNode
}

export interface TreeProps<Node extends TreeNode> extends Omit<HTMLAttributes<HTMLUListElement>, "onSelect"> {
    nodes: Node[]
    /** the open nodes' ids (controlled, with onExpandedChange) */
    expanded?: string[]
    defaultExpanded?: string[] | "all"
    onExpandedChange?: (ids: string[]) => void
    selected?: string | null
    onSelect?: (id: string, node: Node) => void
    renderLabel?: (node: Node) => ReactNode
}

/** A collapsible tree (TF frames, recording summaries, URDF links). */
export function Tree<Node extends TreeNode>({
    nodes = [],
    expanded,
    defaultExpanded = [],
    onExpandedChange,
    selected,
    onSelect,
    renderLabel,
    className,
    ...rest
}: TreeProps<Node>) {
    const allIds = useMemo(() => {
        const ids: string[] = []
        const walk = (list: Node[]) =>
            list.forEach((node) => {
                if (node.children?.length) {
                    ids.push(node.id)
                    walk(node.children)
                }
            })
        walk(nodes)
        return ids
    }, [nodes])
    const [open, setOpen] = useControllable(
        expanded,
        defaultExpanded === "all" ? allIds : defaultExpanded,
        onExpandedChange,
    )
    const openSet = new Set(open)
    const toggle = (id: string) => setOpen(openSet.has(id) ? open.filter((other) => other !== id) : [...open, id])
    const renderNodes = (list: Node[], depth: number): ReactNode[] =>
        list.map((node) => {
            const hasChildren = !!node.children?.length
            const isOpen = openSet.has(node.id)
            return (
                <li key={node.id} role="treeitem" aria-expanded={hasChildren ? isOpen : undefined}>
                    <div
                        className={cx("dr-tree__row", selected === node.id && "dr-tree__row--selected")}
                        style={{ paddingLeft: 6 + depth * 14 }}
                        onClick={() => onSelect?.(node.id, node)}
                    >
                        <button
                            type="button"
                            className={cx("dr-tree__twisty", !hasChildren && "dr-tree__twisty--leaf")}
                            tabIndex={hasChildren ? 0 : -1}
                            aria-label={hasChildren ? (isOpen ? "Collapse" : "Expand") : undefined}
                            onClick={(event) => {
                                event.stopPropagation()
                                if (hasChildren) {
                                    toggle(node.id)
                                }
                            }}
                        >
                            {hasChildren ? <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} /> : null}
                        </button>
                        {node.icon ? <Icon name={node.icon} size={14} className="dr-tree__icon" /> : null}
                        <span className="dr-tree__label">
                            {renderLabel ? renderLabel(node) : (node.label ?? node.id)}
                        </span>
                        {node.badge !== undefined && node.badge !== null
                            ? <span className="dr-tree__badge">{node.badge}</span>
                            : null}
                    </div>
                    {hasChildren && isOpen ? <ul role="group">{renderNodes(node.children!, depth + 1)}</ul> : null}
                </li>
            )
        })
    return (
        <ul className={cx("dr-tree", className)} role="tree" {...rest}>
            {renderNodes(nodes, 0)}
        </ul>
    )
}

// ── key / value ──

export interface KeyValueRowProps extends HTMLAttributes<HTMLDivElement> {
    label?: ReactNode
    /** the value in the monospace face (default true) */
    mono?: boolean
}

/** One label / value row (`children` is the value). */
export function KeyValueRow({ label, children, mono = true, className, ...rest }: KeyValueRowProps) {
    return (
        <div className={cx("dr-kv__row", className)} {...rest}>
            <span className="dr-kv__key">{label}</span>
            <span className={cx("dr-kv__value", mono && "dr-mono")}>{children}</span>
        </div>
    )
}

export interface KeyValueProps extends HTMLAttributes<HTMLDivElement> {
    /** [label, value] rows */
    items?: (readonly [ReactNode, ReactNode])[]
    mono?: boolean
}

/** Label / value readout rows. */
export function KeyValue({ items, children, mono = true, className, ...rest }: KeyValueProps) {
    return (
        <div className={cx("dr-kv", className)} {...rest}>
            {items?.map(([label, value], index) => (
                <KeyValueRow key={index} label={label} mono={mono}>
                    {value}
                </KeyValueRow>
            ))}
            {children}
        </div>
    )
}

export interface StatProps extends HTMLAttributes<HTMLDivElement> {
    label: ReactNode
    value: ReactNode
    unit?: ReactNode
    /** a change: a number shows +/- colored, a string as is */
    delta?: number | string
    tone?: "ok" | "warn" | "danger" | "info"
    hint?: ReactNode
}

/** A big number: label, value, unit, a change, a tone. */
export function Stat({ label, value, unit, delta, tone, hint, className, ...rest }: StatProps) {
    const deltaTone = typeof delta === "number" ? (delta > 0 ? "up" : delta < 0 ? "down" : "flat") : "flat"
    return (
        <div className={cx("dr-stat", tone && `dr-stat--${tone}`, className)} {...rest}>
            <div className="dr-stat__label">{label}</div>
            <div className="dr-stat__value">
                {value}
                {unit ? <span className="dr-stat__unit">{unit}</span> : null}
            </div>
            {delta !== undefined && delta !== null
                ? (
                    <div className={cx("dr-stat__delta", `dr-stat__delta--${deltaTone}`)}>
                        {typeof delta === "number" && delta > 0 ? `+${delta}` : String(delta)}
                    </div>
                )
                : null}
            {hint ? <div className="dr-stat__hint">{hint}</div> : null}
        </div>
    )
}

// ── lists ──

export interface ListProps extends HTMLAttributes<HTMLDivElement> {
    /** lines between rows (default true) */
    divided?: boolean
}

/** A vertical list of ListRows. */
export function List({ children, className, divided = true, ...rest }: ListProps) {
    return (
        <div className={cx("dr-list", divided && "dr-list--divided", className)} role="list" {...rest}>
            {children}
        </div>
    )
}

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "onClick"> {
    /** an Icon name, or an element */
    icon?: ReactNode
    title: ReactNode
    subtitle?: ReactNode
    /** on the right */
    meta?: ReactNode
    actions?: ReactNode
    selected?: boolean
    /** a click, or Enter / Space on the focused row */
    onClick?: (event: ReactMouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>) => void
    /** show a drag grip (an object = props for it, e.g. from useDrag) */
    handle?: boolean | HTMLAttributes<HTMLSpanElement>
    disabled?: boolean
    ref?: Ref<HTMLDivElement>
}

/** A list row: icon, title, subtitle, meta on the right, actions. `handle`: a drag grip. */
export function ListRow({
    icon,
    title,
    subtitle,
    meta,
    actions,
    selected,
    onClick,
    handle,
    disabled,
    className,
    ...rest
}: ListRowProps) {
    return (
        <div
            className={cx(
                "dr-list-row",
                onClick && "dr-list-row--clickable",
                selected && "dr-list-row--selected",
                disabled && "dr-list-row--disabled",
                className,
            )}
            role="listitem"
            tabIndex={onClick && !disabled ? 0 : undefined}
            aria-selected={selected || undefined}
            onClick={disabled ? undefined : onClick}
            onKeyDown={onClick && !disabled
                ? (event) => {
                    // keys typed into a control inside the row (a rename box) are that control's
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault()
                        onClick(event)
                    }
                }
                : undefined}
            {...rest}
        >
            {handle
                ? (
                    <span className="dr-list-row__handle" {...(typeof handle === "object" ? handle : {})}>
                        <Icon name="grip" size={14} />
                    </span>
                )
                : null}
            {icon
                ? (
                    <span className="dr-list-row__icon">
                        {typeof icon === "string" ? <Icon name={icon} size={16} /> : icon}
                    </span>
                )
                : null}
            <span className="dr-list-row__text">
                <span className="dr-list-row__title">{title}</span>
                {subtitle ? <span className="dr-list-row__subtitle">{subtitle}</span> : null}
            </span>
            {meta !== undefined && meta !== null ? <span className="dr-list-row__meta">{meta}</span> : null}
            {actions
                ? (
                    <span className="dr-list-row__actions" onClick={(event) => event.stopPropagation()}>
                        {actions}
                    </span>
                )
                : null}
        </div>
    )
}

// ── LogView ──

/** A log line's time: epoch ms, a date string or a Date. */
export type LogTime = number | string | Date

const formatTs = (ts: LogTime | null | undefined) => {
    if (ts === undefined || ts === null) {
        return ""
    }
    const date = typeof ts === "number" || typeof ts === "string" ? new Date(ts) : ts
    return Number.isNaN(date.getTime?.()) ? String(ts) : date.toTimeString().slice(0, 8)
}

export interface LogLine {
    text: string
    level?: "debug" | "info" | "warn" | "error"
    ts?: LogTime
}

export interface LogViewProps extends HTMLAttributes<HTMLDivElement> {
    lines: (string | LogLine)[]
    /** shows only lines containing it (case-insensitive) */
    filter?: string
    maxLines?: number
    follow?: boolean
    height?: string | number
    showTime?: boolean
    wrap?: boolean
}

/** A console: follows the tail (auto scroll) until you scroll up, then offers "jump to end". */
export function LogView({
    lines = [],
    filter = "",
    maxLines = 5000,
    follow = true,
    height = 260,
    showTime = true,
    wrap = false,
    className,
    style,
    ...rest
}: LogViewProps) {
    const box = useRef<HTMLDivElement>(null)
    const [atEnd, setAtEnd] = useState(true)
    const shown = useMemo(() => {
        const needle = filter.trim().toLowerCase()
        const normalized = lines.map((line): LogLine => (typeof line === "string" ? { text: line } : line))
        const filtered = needle ? normalized.filter((line) => line.text.toLowerCase().includes(needle)) : normalized
        return filtered.length > maxLines ? filtered.slice(filtered.length - maxLines) : filtered
    }, [lines, filter, maxLines])
    useIsoLayoutEffect(() => {
        if (follow && atEnd && box.current) {
            box.current.scrollTop = box.current.scrollHeight
        }
    }, [shown, follow, atEnd])
    const onScroll = () => {
        const element = box.current
        if (element) {
            setAtEnd(element.scrollHeight - element.scrollTop - element.clientHeight < 24)
        }
    }
    const jump = () => {
        setAtEnd(true)
        if (box.current) {
            box.current.scrollTop = box.current.scrollHeight
        }
    }
    return (
        <div className={cx("dr-log", className)} style={{ height, ...style }} {...rest}>
            <div
                className={cx("dr-log__lines", "dr-scroll", wrap && "dr-log__lines--wrap")}
                ref={box}
                onScroll={onScroll}
            >
                {shown.length === 0
                    ? <div className="dr-log__empty">{filter ? "No lines match" : "No output yet"}</div>
                    : (
                        shown.map((line, index) => (
                            <div
                                key={index}
                                className={cx("dr-log__line", line.level && `dr-log__line--${line.level}`)}
                            >
                                {showTime && line.ts !== undefined
                                    ? <span className="dr-log__ts">{formatTs(line.ts)}</span>
                                    : null}
                                <span className="dr-log__text">{line.text}</span>
                            </div>
                        ))
                    )}
            </div>
            {!atEnd && follow
                ? (
                    <button type="button" className="dr-log__jump" onClick={jump}>
                        <Icon name="arrow-down" size={12} />
                        Jump to end
                    </button>
                )
                : null}
        </div>
    )
}

// ── CodeBlock ──

const KEYWORDS: Record<string, string> = {
    js: "const let var function return if else for while of in new class extends import export from await async true false null undefined this throw try catch",
    py: "def return if elif else for while in import from as class with try except finally raise lambda True False None and or not is pass yield async await self",
    sh: "if then else fi for do done case esac function export local echo cd sudo",
    json: "true false null",
}
KEYWORDS.ts = KEYWORDS.js
KEYWORDS.python = KEYWORDS.py
KEYWORDS.bash = KEYWORDS.sh
KEYWORDS.javascript = KEYWORDS.js

export type TokenKind = "kw" | "str" | "num" | "com" | "func" | "plain"

/** Splits one line of code into [kind, text] tokens (kw, str, num, com, func, plain). */
export function tokenizeLine(line: string, language = "js"): [TokenKind, string][] {
    const keywords = new Set((KEYWORDS[language] ?? KEYWORDS.js).split(" "))
    const comment = language === "py" || language === "python" || language === "sh" || language === "bash"
        ? "#[^\\n]*"
        : language === "json"
        ? "(?!)"
        : "\\/\\/[^\\n]*"
    const pattern = new RegExp(
        `(${comment})|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*)(?=\\s*\\()|([A-Za-z_$][\\w$]*)`,
        "g",
    )
    const tokens: [TokenKind, string][] = []
    let last = 0
    for (const match of line.matchAll(pattern)) {
        if (match.index > last) {
            tokens.push(["plain", line.slice(last, match.index)])
        }
        if (match[1]) {
            tokens.push(["com", match[1]])
        } else if (match[2]) {
            tokens.push(["str", match[2]])
        } else if (match[3]) {
            tokens.push(["num", match[3]])
        } else if (match[4]) {
            tokens.push([keywords.has(match[4]) ? "kw" : "func", match[4]])
        } else {
            tokens.push([keywords.has(match[5]) ? "kw" : "plain", match[5]])
        }
        last = match.index + match[0].length
    }
    if (last < line.length) {
        tokens.push(["plain", line.slice(last)])
    }
    return tokens
}

export interface CodeBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
    code: string
    /** js, ts, py, sh, json, … (default js) */
    language?: string
    lineNumbers?: boolean
    /** a copy button (default true) */
    copy?: boolean
    /** the header's text (default: the language) */
    title?: ReactNode
    /** false: no header (no language, no copy button) */
    header?: boolean
    maxHeight?: string | number
    /** a line (1-based) to mark and scroll to */
    highlightLine?: number
    /** fills its parent (a flex column) and scrolls inside, without a border */
    fill?: boolean
}

/**
 * Code with light highlighting (the theme's --code-* colors), line numbers and a copy button. `highlightLine` marks a
 * line and scrolls it into view; `fill` makes it fill its parent.
 */
export function CodeBlock({
    code = "",
    language = "js",
    lineNumbers = false,
    copy = true,
    title,
    header = true,
    maxHeight,
    highlightLine,
    fill = false,
    className,
    style,
    ...rest
}: CodeBlockProps) {
    const [copied, setCopied] = useState(false)
    const pre = useRef<HTMLPreElement>(null)
    const lines = String(code).replace(/\n$/, "").split("\n")
    useEffect(() => {
        const element = pre.current
        const target = highlightLine
            ? element?.querySelectorAll<HTMLElement>(".dr-code__line")[highlightLine - 1]
            : null
        if (element && target) {
            element.scrollTop = target.offsetTop - element.offsetTop - 8
        }
    }, [code, highlightLine])
    const onCopy = async () => {
        if (await copyText(code)) {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
        }
    }
    return (
        <div className={cx("dr-code", fill && "dr-code--fill", className)} style={style} {...rest}>
            {header && (title || language || copy)
                ? (
                    <div className="dr-code__head">
                        <span className="dr-code__lang">{title ?? language}</span>
                        {copy
                            ? (
                                <button type="button" className="dr-code__copy" onClick={onCopy} aria-label="Copy code">
                                    <Icon name={copied ? "check" : "copy"} size={13} />
                                    {copied ? "Copied" : "Copy"}
                                </button>
                            )
                            : null}
                    </div>
                )
                : null}
            <pre ref={pre} className="dr-code__pre dr-scroll" style={{ maxHeight }}>
                <code>
                    {lines.map((line, index) => (
                        <div
                            key={index}
                            className={cx("dr-code__line", index + 1 === highlightLine && "dr-code__line--at")}
                        >
                            {lineNumbers ? <span className="dr-code__num">{index + 1}</span> : null}
                            <span>
                                {tokenizeLine(line, language).map(([kind, text], tokenIndex) =>
                                    kind === "plain" ? (
                                        text
                                    ) : (
                                        <span key={tokenIndex} className={`dr-tok-${kind}`}>
                                            {text}
                                        </span>
                                    ),
                                )}
                                {line === "" ? "​" : null}
                            </span>
                        </div>
                    ))}
                </code>
            </pre>
        </div>
    )
}

// ── Sparkline ──

export interface AttitudeIndicatorProps extends HTMLAttributes<HTMLDivElement> {
    roll?: number | null
    pitch?: number | null
    yaw?: number | null
    /** px */
    height?: number
    /** px of shift per degree of pitch (default 1.4) */
    pitchScale?: number
}

/**
 * An attitude indicator (artificial horizon): the horizon rolls and shifts with the body's roll and pitch, yaw is
 * printed below. Angles in radians; null shows a level, dimmed horizon.
 */
export function AttitudeIndicator({
    roll = null,
    pitch = null,
    yaw = null,
    height = 84,
    pitchScale = 1.4,
    className,
    ...rest
}: AttitudeIndicatorProps) {
    const deg = (radians: number) => (radians * 180) / Math.PI
    const known = roll !== null && pitch !== null
    const shift = known ? Math.max(-height / 2, Math.min(height / 2, deg(pitch) * pitchScale)) : 0
    return (
        <div
            className={cx("dr-attitude", !known && "dr-attitude--unknown", className)}
            style={{ height }}
            role="img"
            aria-label={known ? `roll ${deg(roll).toFixed(1)}°, pitch ${deg(pitch).toFixed(1)}°` : "attitude unknown"}
            {...rest}
        >
            <div
                className="dr-attitude__sky"
                style={known
                    ? { transform: `rotate(${(-deg(roll)).toFixed(1)}deg) translateY(${shift.toFixed(0)}px)` }
                    : undefined}
            />
            <div className="dr-attitude__cross" />
            <div className="dr-attitude__yaw">{`yaw ${yaw === null ? "—" : deg(yaw).toFixed(0)}°`}</div>
        </div>
    )
}

export interface SparklineProps extends
    Omit<
        SVGAttributes<SVGSVGElement>,
        "values" | "width" | "height" | "color" | "fill" | "min" | "max" | "strokeWidth"
    > {
    values: number[]
    /** px */
    width?: number
    /** px */
    height?: number
    /** a CSS color, default var(--primary) */
    color?: string
    /** shade under the line (default true) */
    fill?: boolean
    min?: number
    max?: number
    strokeWidth?: number
    /** an accessible name (an untitled sparkline is aria-hidden) */
    title?: string
}

/** A tiny line chart (rates, latency, battery). `color`: a CSS color, default var(--primary). */
export function Sparkline({
    values = [],
    width = 120,
    height = 28,
    color = "var(--primary)",
    fill = true,
    min,
    max,
    strokeWidth = 1.5,
    className,
    title,
    ...rest
}: SparklineProps) {
    const finite = values.filter(Number.isFinite)
    const low = min ?? Math.min(...finite, 0)
    const high = max ?? Math.max(...finite, low + 1e-9)
    const span = high - low || 1
    const step = values.length > 1 ? width / (values.length - 1) : width
    const points = values.map((value, index): [number, number] => [
        index * step,
        height - 1 - (((Number.isFinite(value) ? value : low) - low) / span) * (height - 2),
    ])
    const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("")
    return (
        <svg
            className={cx("dr-sparkline", className)}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role={title ? "img" : undefined}
            aria-hidden={title ? undefined : "true"}
            style={{ color }}
            {...rest}
        >
            {title ? <title>{title}</title> : null}
            {points.length > 1 && fill
                ? <path d={`${line}L${width},${height}L0,${height}Z`} className="dr-sparkline__fill" />
                : null}
            {points.length > 1
                ? <path d={line} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" />
                : null}
            {points.length ? <circle cx={points.at(-1)![0]} cy={points.at(-1)![1]} r={2} fill="currentColor" /> : null}
        </svg>
    )
}

// ── Timeline ──

/** Seconds → "m:ss" (or "h:mm:ss"). */
export function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const secs = String(total % 60).padStart(2, "0")
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`
}

export interface TimelineMarker {
    t: number
    label?: string
    tone?: "ok" | "warn" | "danger" | "info"
}

export interface TimelineProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
    start?: number
    end: number
    value: number
    onChange?: (t: number) => void
    playing?: boolean
    /** adds a play/pause button (Space too) */
    onPlayPause?: (playing: boolean) => void
    markers?: TimelineMarker[]
    format?: (t: number) => string
    /** snaps to multiples of it; the arrow keys' nudge (default 1% of the span) */
    step?: number
    disabled?: boolean
}

/**
 * A recording player's scrubber: play/pause, the position, markers. Times in seconds (any unit works with your own
 * `format`).
 */
export function Timeline({
    start = 0,
    end,
    value,
    onChange,
    playing,
    onPlayPause,
    markers = [],
    format,
    step,
    disabled,
    className,
    style,
    ...rest
}: TimelineProps) {
    const track = useRef<HTMLDivElement>(null)
    const show = format ?? ((t: number) => formatDuration(t - start))
    const span = Math.max(1e-9, end - start)
    const fraction = Math.min(1, Math.max(0, (value - start) / span))
    const timeAt = (clientX: number) => {
        const rect = track.current!.getBoundingClientRect()
        const t = start + Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))) * span
        return step ? Math.round(t / step) * step : t
    }
    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (disabled || !onChange) {
            return
        }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        onChange(timeAt(event.clientX))
    }
    const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!disabled && onChange && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            onChange(timeAt(event.clientX))
        }
    }
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (disabled || !onChange) {
            return
        }
        const nudge = step ?? span / 100
        if (event.key === "ArrowRight") {
            onChange(Math.min(end, value + nudge))
        } else if (event.key === "ArrowLeft") {
            onChange(Math.max(start, value - nudge))
        } else if (event.key === "Home") {
            onChange(start)
        } else if (event.key === "End") {
            onChange(end)
        } else if (event.key === " " && onPlayPause) {
            onPlayPause(!playing)
        } else {
            return
        }
        event.preventDefault()
    }
    return (
        <div className={cx("dr-timeline", disabled && "dr-timeline--disabled", className)} style={style} {...rest}>
            {onPlayPause
                ? (
                    <button
                        type="button"
                        className="dr-timeline__play"
                        onClick={() => onPlayPause(!playing)}
                        disabled={disabled}
                        aria-label={playing ? "Pause" : "Play"}
                    >
                        <Icon name={playing ? "pause" : "play"} size={16} />
                    </button>
                )
                : null}
            <span className="dr-timeline__time">{show(value)}</span>
            <div
                className="dr-timeline__track"
                ref={track}
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-valuemin={start}
                aria-valuemax={end}
                aria-valuenow={value}
                aria-valuetext={show(value)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onKeyDown={onKeyDown}
                style={{ touchAction: "none" }}
            >
                <div className="dr-timeline__rail" />
                <div className="dr-timeline__done" style={{ width: `${fraction * 100}%` }} />
                {markers.map((marker, index) => (
                    <span
                        key={index}
                        className={cx("dr-timeline__marker", marker.tone && `dr-timeline__marker--${marker.tone}`)}
                        style={{ left: `${Math.min(1, Math.max(0, (marker.t - start) / span)) * 100}%` }}
                        title={marker.label}
                    />
                ))}
                <div className="dr-timeline__thumb" style={{ left: `${fraction * 100}%` }} />
            </div>
            <span className="dr-timeline__time dr-timeline__time--end">{show(end)}</span>
        </div>
    )
}

export interface MediaFrameProps extends HTMLAttributes<HTMLDivElement> {
    /** plays in a muted inline <video> (null: a video with nothing yet) */
    stream?: MediaStream | null
    /** an image, when there's no `stream` */
    src?: string | null
    alt?: string
    fit?: "contain" | "cover"
    height?: string | number
    /** covers it until there is something to show */
    placeholder?: ReactNode
    /** the <video> (with `stream`) or the <img> */
    ref?: Ref<HTMLVideoElement | HTMLImageElement>
}

/**
 * A video stream or an image in a themed frame. `stream` (a MediaStream, e.g. a zenoh-gateway camera track) plays in a
 * muted inline <video>; without `stream`, `src` shows as an image. `placeholder` covers it until there is something to
 * show. `ref` reaches the <video>/<img> (for captureFrame).
 */
export function MediaFrame({
    stream,
    src,
    alt = "",
    fit = "contain",
    height = 360,
    placeholder = "No video",
    ref,
    className,
    style,
    ...rest
}: MediaFrameProps) {
    const element = useRef<HTMLVideoElement | HTMLImageElement | null>(null)
    const [playing, setPlaying] = useState(false)
    const isVideo = stream !== undefined
    useEffect(() => {
        // with a stream the element is the <video>
        const video = element.current as HTMLVideoElement | null
        if (isVideo && video && video.srcObject !== (stream ?? null)) {
            video.srcObject = stream ?? null
            setPlaying(false)
        }
    }, [isVideo, stream])
    const setRef = (node: HTMLVideoElement | HTMLImageElement | null) => {
        element.current = node
        if (typeof ref === "function") {
            ref(node)
        } else if (ref) {
            ref.current = node
        }
    }
    const shown = isVideo ? stream && playing : Boolean(src)
    return (
        <div
            className={cx("dr-media", className)}
            style={{ maxHeight: height, aspectRatio: "16 / 9", ...style }}
            {...rest}
        >
            {isVideo
                ? (
                    <video
                        ref={setRef}
                        className="dr-media__el"
                        style={{ objectFit: fit }}
                        autoPlay={true}
                        muted={true}
                        playsInline={true}
                        onPlaying={() => setPlaying(true)}
                        onEmptied={() => setPlaying(false)}
                    />
                )
                : src
                ? <img ref={setRef} className="dr-media__el" style={{ objectFit: fit }} src={src} alt={alt} />
                : null}
            {!shown && placeholder ? <div className="dr-media__placeholder">{placeholder}</div> : null}
        </div>
    )
}

/** The frame a <video> is showing, as a data URL (null before its first frame). */
export function captureFrame(video: HTMLVideoElement | null | undefined, type = "image/png"): string | null {
    if (!video?.videoWidth) {
        return null
    }
    const canvas = Object.assign(document.createElement("canvas"), {
        width: video.videoWidth,
        height: video.videoHeight,
    })
    canvas.getContext("2d")!.drawImage(video, 0, 0)
    return canvas.toDataURL(type)
}
