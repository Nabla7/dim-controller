// dimOS topics at a glance: a color per message type, and a table of the bus's rates (Hz and bandwidth), hot cells
// tinted.
import type { CSSProperties, HTMLAttributes } from "react"
import { cx } from "../cx.ts"

const TYPE_COLORS: Record<string, string> = {
    Image: "warn",
    CompressedImage: "warn",
    CameraInfo: "warn",
    PointCloud2: "violet",
    LaserScan: "violet",
    OccupancyGrid: "cat-1",
    Path: "cat-1",
    Odometry: "info",
    PoseStamped: "info",
    Twist: "info",
    TFMessage: "ok",
    Bool: "cat-2",
    String: "cat-2",
}
const PACKAGE_COLORS: Record<string, string> = {
    sensor_msgs: "warn",
    geometry_msgs: "info",
    nav_msgs: "cat-1",
    tf2_msgs: "ok",
    vision_msgs: "violet",
    std_msgs: "cat-2",
}
const PALETTE = ["info", "warn", "cat-1", "violet", "ok", "cat-2", "cat-3", "cat-4"]
// tokens a skin may leave out, and what stands in
const FALLBACKS: Record<string, string> = {
    violet: "var(--info)",
    "cat-1": "var(--primary)",
    "cat-2": "var(--ok)",
    "cat-3": "var(--violet, var(--info))",
    "cat-4": "var(--warn)",
}

/** A message type's short name: `sensor_msgs.Image` → `Image`. */
export const messageTypeName = (type: string | null | undefined): string => (type ?? "").split(/[./]/).pop() || ""

/** The theme token a message type is drawn in (by type, else by package, else a stable pick): `info`, `warn`, … */
export function messageTypeToken(type: string | null | undefined): string {
    const pkg = (type ?? "").split(/[./]/).find((part) => part.endsWith("_msgs")) ?? ""
    return (
        TYPE_COLORS[messageTypeName(type)] ??
            PACKAGE_COLORS[pkg] ??
            PALETTE[[...(type ?? "")].reduce((sum, char) => sum + char.charCodeAt(0), 0) % PALETTE.length]
    )
}

/** The CSS color a message type is drawn in: `var(--warn)`, … */
export function messageTypeColor(type: string | null | undefined): string {
    const token = messageTypeToken(type)
    return FALLBACKS[token] ? `var(--${token}, ${FALLBACKS[token]})` : `var(--${token})`
}

/** `12.3 Hz` (`123 Hz` from 100 up). */
export const formatRate = (hz: number): string => `${hz >= 100 ? hz.toFixed(0) : hz.toFixed(1)} Hz`

/** `850 B/s`, `1.2 MB/s`, … */
export function formatBandwidth(bytesPerSecond: number): string {
    const units = ["B/s", "KB/s", "MB/s", "GB/s"]
    let value = bytesPerSecond
    let unit = 0
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000
        unit += 1
    }
    return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`
}

/** A cell's tint for `value` out of `max` (log scale, cool to hot); none at 0. */
export function heatStyle(value: number, max: number): CSSProperties | undefined {
    if (!(value > 0) || !(max > 0)) {
        return undefined
    }
    const t = Math.log1p(value) / Math.log1p(max)
    const hue = `color-mix(in srgb, var(--close-red, var(--danger)) ${Math.round(t * 100)}%, var(--info))`
    return { background: `color-mix(in srgb, ${hue} ${Math.round(22 + 45 * t)}%, transparent)` }
}

export interface TopicRate {
    /** "/odom" */
    topic: string
    type?: string
    hz?: number
    /** bytes per second */
    bps?: number
}

export interface TopicRatesProps extends HTMLAttributes<HTMLDivElement> {
    rows: TopicRate[]
    /** shown when there are no rows (default "no topics on the bus") */
    empty?: string | null
    /** rows visible before it scrolls (default 6.5) */
    visibleRows?: number
}

/** A table of topics with their rate and bandwidth: each topic in its type's color, hot cells tinted, quiet rows dim. */
export function TopicRates({ rows, empty, visibleRows = 6.5, className, style, ...rest }: TopicRatesProps) {
    const top = (key: "hz" | "bps") => Math.max(...rows.map((row) => row[key] ?? 0), 0)
    const [maxHz, maxBps] = [top("hz"), top("bps")]
    return (
        <div
            className={cx("dr-rates", className)}
            style={{ maxHeight: `calc(${visibleRows} * 21px + 2px)`, ...style }}
            {...rest}
        >
            <table>
                <tbody>
                    {rows.length === 0
                        ? (
                            <tr>
                                <td className="dr-rates__empty" colSpan={3}>
                                    {empty ?? "no topics on the bus"}
                                </td>
                            </tr>
                        )
                        : null}
                    {rows.map((row) => {
                        const type = String(row.type ?? "").replace(/\//g, ".")
                        return (
                            <tr
                                key={`${row.topic} ${type}`}
                                className={(row.hz ?? 0) > 0 ? undefined : "dr-rates--quiet"}
                            >
                                <td
                                    className="dr-rates__topic"
                                    title={`${row.topic}\n${type || "unknown type"}`}
                                    style={{ color: messageTypeColor(type) }}
                                >
                                    {row.topic}
                                </td>
                                <td className="dr-rates__num" style={heatStyle(row.hz ?? 0, maxHz)}>
                                    {(row.hz ?? 0).toFixed(1)} Hz
                                </td>
                                <td className="dr-rates__num" style={heatStyle(row.bps ?? 0, maxBps)}>
                                    {formatBandwidth(row.bps ?? 0)}
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}
