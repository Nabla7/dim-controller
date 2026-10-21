// <Icon name="close" />: the shared dimOS line icons (24-unit grid, stroke = currentColor).
import type { SVGAttributes } from "react"
import { cx } from "../cx.ts"
import { ICONS } from "../icons_data.ts"

export { ICONS }

const ICON_PATHS: Record<string, string | undefined> = ICONS

export interface IconProps extends Omit<SVGAttributes<SVGSVGElement>, "name" | "path"> {
    /** a key of ICONS */
    name: string
    /** px */
    size?: number
    strokeWidth?: number
    /** an accessible name (an unnamed icon is aria-hidden) */
    title?: string
    /** your own SVG path data instead of a named icon */
    path?: string
}

/** A dimOS line icon by `name` (or your own `path`). */
export function Icon({ name, size = 18, strokeWidth = 1.8, className, title, path, ...rest }: IconProps) {
    return (
        <svg
            className={cx("dr-icon", className)}
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden={title ? undefined : "true"}
            role={title ? "img" : undefined}
            {...rest}
        >
            {title ? <title>{title}</title> : null}
            <path d={path ?? ICON_PATHS[name] ?? ""} />
        </svg>
    )
}
