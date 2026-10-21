// A structured log (structlog-style records: time, level, logger, event, extra fields), followed live, with its
// filters: lowest level, a search and follow. Tracebacks in a record's fields are drawn by <Traceback>.
import { useEffect, useLayoutEffect, useRef } from "react"
import type { HTMLAttributes, ReactNode } from "react"
import { cx } from "../cx.ts"
import { useLatest } from "../hooks.ts"
import { Checkbox, SearchInput, Select } from "./controls.tsx"
import { isTraceback, Traceback } from "./traceback.tsx"

export interface LogRecord {
    timestamp: string
    level: string
    logger?: string
    event: string
    /** more fields: short ones show as chips, multi-line ones under the line, a traceback as a traceback */
    extra?: Record<string, unknown>
    /** the record as written (its tooltip) */
    raw?: string
}

export const LOG_LEVELS = ["debug", "info", "warning", "error", "critical"]

/** How far from the bottom still counts as at the bottom (px). */
const BOTTOM_SLACK = 24

const shortTime = (timestamp: string) => /T?(\d\d:\d\d:\d\d)/.exec(timestamp)?.[1] ?? timestamp
const fieldText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value))
const multiline = (value: unknown) => typeof value === "string" && value.includes("\n")

/** A record's traceback (from `traceback_lines` or a traceback-shaped `exception`), and its other fields. */
export function splitRecord(record: LogRecord): {
    traceback: string | null
    where: string
    fields: [string, unknown][]
} {
    const extra = { ...(record.extra ?? {}) }
    const traceback = Array.isArray(extra.traceback_lines)
        ? extra.traceback_lines.join("")
        : isTraceback(extra.exception)
        ? extra.exception
        : null
    if (traceback) {
        for (const key of ["traceback_lines", "exception", "exception_type", "exception_message"]) {
            delete extra[key]
        }
    }
    const where = [extra.lineno !== undefined && `line ${extra.lineno}`, extra.func_name && `in ${extra.func_name}`]
        .filter(Boolean)
        .join(" ")
    delete extra.lineno
    delete extra.func_name
    return { traceback, where, fields: Object.entries(extra) }
}

interface RecordProps {
    record: LogRecord
    onOpenFile?: (file: string, line: number) => void
    formatPath?: (file: string) => string
}

function Record({ record, onOpenFile, formatPath }: RecordProps) {
    const { traceback, where, fields } = splitRecord(record)
    const level = record.level.toLowerCase()
    return (
        <div className={cx("dr-slog__rec", `dr-slog__rec--${level}`)} title={traceback ? undefined : record.raw}>
            <div className="dr-slog__line">
                <span className="dr-slog__ts">{shortTime(record.timestamp)}</span>
                <span className="dr-slog__lv">{record.level}</span>
                <span className="dr-slog__ev">
                    {record.logger
                        ? (
                            <span
                                className="dr-slog__logger"
                                title={where ? `${record.logger} ${where}` : record.logger}
                            >
                                {record.logger}
                            </span>
                        )
                        : null}
                    {record.event}
                    {fields
                        .filter(([, value]) => !multiline(value))
                        .map(([key, value]) => (
                            <span key={key} className="dr-slog__chip">
                                <span className="dr-slog__key">{key}</span>
                                {fieldText(value)}
                            </span>
                        ))}
                </span>
            </div>
            {fields
                .filter(([, value]) => multiline(value))
                .map(([key, value]) => (
                    <div key={key} className="dr-slog__field">
                        <span className="dr-slog__key">{key}</span>
                        <pre>{String(value).replace(/\n$/, "")}</pre>
                    </div>
                ))}
            {traceback
                ? <Traceback text={traceback} onOpenFile={onOpenFile} formatPath={formatPath} className="dr-slog__tb" />
                : null}
        </div>
    )
}

export interface StructuredLogProps extends HTMLAttributes<HTMLDivElement> {
    records: LogRecord[]
    /** keeps the newest record in view; scrolling up (or opening folded frames) turns it off through onFollowChange */
    follow?: boolean
    onFollowChange?: (follow: boolean) => void
    /** the lowest level shown, with onLevelChange: a level picker (filtering is yours, e.g. on the server) */
    level?: string
    onLevelChange?: (level: string) => void
    /** the search, with onQueryChange: a search box (filtering is yours) */
    query?: string
    onQueryChange?: (query: string) => void
    /** shown over the records: "loading…", an error, "No log lines yet." */
    note?: ReactNode
    /** between the filters and the records */
    banner?: ReactNode
    onOpenFile?: (file: string, line: number) => void
    formatPath?: (file: string) => string
}

/**
 * A structured log: each record's time, level, logger and event, its short fields as chips, its multi-line fields
 * below and its traceback drawn frame by frame. The filters (level, search, follow) show when their handlers are given.
 */
export function StructuredLog({
    records,
    follow = true,
    onFollowChange,
    level,
    onLevelChange,
    query,
    onQueryChange,
    note,
    banner,
    onOpenFile,
    formatPath,
    className,
    ...rest
}: StructuredLogProps) {
    const box = useRef<HTMLDivElement>(null)
    const followChange = useLatest(onFollowChange)
    useLayoutEffect(() => {
        if (follow && box.current) {
            box.current.scrollTop = box.current.scrollHeight
        }
    }, [records, follow])
    useEffect(() => {
        // opening folded library frames means reading back up: stop following (toggle doesn't bubble, so capture it)
        const element = box.current!
        const opened = (event: Event) => (event.target as HTMLDetailsElement).open && followChange.current?.(false)
        element.addEventListener("toggle", opened, true)
        return () => element.removeEventListener("toggle", opened, true)
    }, [followChange])
    const atBottom = () => {
        const element = box.current!
        return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK
    }
    const filters = onLevelChange || onQueryChange || onFollowChange
    return (
        <div className={cx("dr-slog", className)} {...rest}>
            {filters
                ? (
                    <div className="dr-slog__tools">
                        {onLevelChange
                            ? (
                                <Select
                                    size="sm"
                                    aria-label="lowest level"
                                    className="dr-slog__level"
                                    value={level ?? "info"}
                                    onChange={onLevelChange}
                                    options={LOG_LEVELS.map((name) => [name, `${name} and up`] as const)}
                                />
                            )
                            : null}
                        {onQueryChange
                            ? (
                                <SearchInput
                                    placeholder="search the log…"
                                    aria-label="search the log"
                                    value={query ?? ""}
                                    onChange={onQueryChange}
                                />
                            )
                            : null}
                        {onFollowChange ? <Checkbox label="follow" value={follow} onChange={onFollowChange} /> : null}
                    </div>
                )
                : null}
            {banner}
            <div
                ref={box}
                className="dr-slog__body dr-scroll"
                onScroll={() => atBottom() !== follow && onFollowChange?.(atBottom())}
            >
                {note ? <div className="dr-slog__note">{note}</div> : null}
                {records.map((record, index) => (
                    <Record key={index} record={record} onOpenFile={onOpenFile} formatPath={formatPath} />
                ))}
            </div>
        </div>
    )
}
