// Touch and pointer input: a virtual joystick, a stick readout, a D-pad, a file drop zone, a color swatch and HUD key
// hints.
import { useEffect, useRef, useState } from "react"
import type { CSSProperties, HTMLAttributes, PointerEvent as ReactPointerEvent, ReactNode, SVGAttributes } from "react"
import { cx } from "../cx.ts"
import { Icon } from "./icon.tsx"
import type { StickValue } from "./thumbstick.tsx"

/** Pointer offset from a circle's center → stick value in -1..1 (y up), clamped to the unit circle. */
export function stickValue(dx: number, dy: number, radius: number): StickValue {
    let x = dx / radius
    let y = -dy / radius
    const length = Math.hypot(x, y)
    if (length > 1) {
        x /= length
        y /= length
    }
    return { x, y }
}

export interface JoystickProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
    onChange?: (value: StickValue) => void
    onStart?: () => void
    onEnd?: () => void
    size?: number
    disabled?: boolean
    label?: ReactNode
    className?: string
    style?: CSSProperties
}

/** A virtual joystick: `onChange({ x, y })` (-1..1, y up) on every move while held, `{0, 0}` on release. */
export function Joystick({
    onChange,
    onStart,
    onEnd,
    size = 132,
    disabled,
    label,
    className,
    style,
    ...rest
}: JoystickProps) {
    const base = useRef<HTMLDivElement>(null)
    const [knob, setKnob] = useState({ x: 0, y: 0, active: false })
    const radius = size / 2 - size * 0.18
    const update = (event: ReactPointerEvent<HTMLDivElement>) => {
        const rect = base.current!.getBoundingClientRect()
        const value = stickValue(
            event.clientX - (rect.left + rect.width / 2),
            event.clientY - (rect.top + rect.height / 2),
            radius,
        )
        setKnob({ ...value, active: true })
        onChange?.(value)
    }
    const release = () => {
        setKnob({ x: 0, y: 0, active: false })
        onChange?.({ x: 0, y: 0 })
        onEnd?.()
    }
    return (
        <div
            ref={base}
            className={cx(
                "dr-joystick",
                knob.active && "dr-joystick--active",
                disabled && "dr-joystick--disabled",
                className,
            )}
            style={{ width: size, height: size, touchAction: "none", ...style }}
            role="application"
            aria-label={typeof label === "string" ? label : "Joystick"}
            onPointerDown={(event) => {
                if (disabled) {
                    return
                }
                event.currentTarget.setPointerCapture?.(event.pointerId)
                onStart?.()
                update(event)
            }}
            onPointerMove={(event) => {
                if (knob.active && !disabled) {
                    update(event)
                }
            }}
            onPointerUp={() => knob.active && release()}
            onPointerCancel={() => knob.active && release()}
            onLostPointerCapture={() => knob.active && release()}
            {...rest}
        >
            <span className="dr-joystick__ring" />
            <span className="dr-joystick__cross" />
            <span
                className="dr-joystick__knob"
                style={{
                    width: size * 0.36,
                    height: size * 0.36,
                    transform: `translate(calc(-50% + ${knob.x * radius}px), calc(-50% + ${-knob.y * radius}px))`,
                }}
            />
            {label ? <span className="dr-joystick__label">{label}</span> : null}
        </div>
    )
}

export interface StickIndicatorProps extends SVGAttributes<SVGSVGElement> {
    value: StickValue | null
    size?: number
    label?: string
    className?: string
}

/**
 * A small read-only stick: a ring with a dot where a stick is (x, y in -1..1, y up), e.g. a gamepad's or a policy's
 * sticks. `value` null shows it idle.
 */
export function StickIndicator({ value, size = 22, label = "stick", className, ...rest }: StickIndicatorProps) {
    const x = value?.x ?? 0
    const y = value?.y ?? 0
    return (
        <svg
            className={cx("dr-stick-indicator", value && (x || y) && "dr-stick-indicator--live", className)}
            width={size}
            height={size}
            viewBox="-1.2 -1.2 2.4 2.4"
            role="img"
            aria-label={`${label} ${x.toFixed(2)}, ${y.toFixed(2)}`}
            {...rest}
        >
            <circle r={1} className="dr-stick-indicator__ring" />
            <line x1={0} y1={0} x2={x} y2={-y} className="dr-stick-indicator__arm" />
            <circle cx={x} cy={-y} r={0.28} className="dr-stick-indicator__dot" />
        </svg>
    )
}

export type DPadDirection = "up" | "down" | "left" | "right" | "center"

const DIRECTIONS: [DPadDirection, string | null][] = [
    ["up", "arrow-up"],
    ["left", "arrow-left"],
    ["center", null],
    ["right", "arrow-right"],
    ["down", "arrow-down"],
]

export interface DPadProps extends HTMLAttributes<HTMLDivElement> {
    onPress?: (dir: DPadDirection) => void
    onRelease?: (dir: DPadDirection) => void
    size?: number
    /** content of the middle button (omit for none) */
    center?: ReactNode
    disabled?: boolean
    /** directions to show as pressed (e.g. from keys) */
    held?: string[]
    className?: string
    style?: CSSProperties
}

/**
 * A D-pad: `onPress(dir)` when a direction goes down, `onRelease(dir)` when it comes up ("up" | "down" | "left" |
 * "right" | "center"). Holds while the pointer is down.
 */
export function DPad({
    onPress,
    onRelease,
    size = 132,
    center,
    disabled,
    held = [],
    className,
    style,
    ...rest
}: DPadProps) {
    const [down, setDown] = useState<DPadDirection | null>(null)
    const press = (dir: DPadDirection, event: ReactPointerEvent<HTMLButtonElement>) => {
        if (disabled) {
            return
        }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setDown(dir)
        onPress?.(dir)
    }
    const release = (dir: DPadDirection) => {
        if (down === dir) {
            setDown(null)
            onRelease?.(dir)
        }
    }
    return (
        <div
            className={cx("dr-dpad", disabled && "dr-dpad--disabled", className)}
            style={{ width: size, height: size, ...style }}
            {...rest}
        >
            {DIRECTIONS.map(([dir, icon]) => {
                if (dir === "center" && center === undefined) {
                    return <span key={dir} className="dr-dpad__hub" />
                }
                return (
                    <button
                        key={dir}
                        type="button"
                        aria-label={dir}
                        aria-pressed={down === dir || held.includes(dir)}
                        disabled={disabled}
                        className={cx("dr-dpad__btn", `dr-dpad__btn--${dir}`)}
                        style={{ touchAction: "none" }}
                        onPointerDown={(event) => press(dir, event)}
                        onPointerUp={() => release(dir)}
                        onPointerCancel={() => release(dir)}
                        onLostPointerCapture={() => release(dir)}
                        onContextMenu={(event) => event.preventDefault()}
                    >
                        {icon ? <Icon name={icon} size={Math.round(size * 0.15)} /> : center}
                    </button>
                )
            })}
        </div>
    )
}

export interface FileDropProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
    onFiles: (files: File[]) => void
    accept?: string
    multiple?: boolean
    disabled?: boolean
    title?: ReactNode
    hint?: ReactNode
    icon?: string
    children?: ReactNode
    className?: string
    style?: CSSProperties
}

/** A drop zone that also opens the file picker on click. */
export function FileDrop({
    onFiles,
    accept,
    multiple = false,
    disabled,
    title = "Drop a file here",
    hint = "or click to choose",
    icon = "upload",
    children,
    className,
    style,
    ...rest
}: FileDropProps) {
    const input = useRef<HTMLInputElement>(null)
    const [over, setOver] = useState(false)
    const accepts = (file: File) => {
        if (!accept) {
            return true
        }
        return accept
            .split(",")
            .map((part) => part.trim().toLowerCase())
            .some((rule) =>
                rule.startsWith(".")
                    ? file.name.toLowerCase().endsWith(rule)
                    : rule.endsWith("/*")
                    ? file.type.startsWith(rule.slice(0, -1))
                    : file.type === rule
            )
    }
    const take = (list: FileList | null | undefined) => {
        const files = [...(list ?? [])].filter(accepts)
        if (files.length) {
            onFiles?.(multiple ? files : files.slice(0, 1))
        }
    }
    return (
        <div
            className={cx("dr-filedrop", over && "dr-filedrop--over", disabled && "dr-filedrop--disabled", className)}
            style={style}
            role="button"
            tabIndex={disabled ? -1 : 0}
            onClick={() => !disabled && input.current?.click()}
            onKeyDown={(event) => {
                if (!disabled && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault()
                    input.current?.click()
                }
            }}
            onDragOver={(event) => {
                if (disabled) {
                    return
                }
                event.preventDefault()
                setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                event.preventDefault()
                setOver(false)
                if (!disabled) {
                    take(event.dataTransfer?.files)
                }
            }}
            {...rest}
        >
            <input
                ref={input}
                type="file"
                accept={accept}
                multiple={multiple}
                hidden={true}
                onChange={(event) => {
                    take(event.target.files)
                    event.target.value = ""
                }}
            />
            {children ?? [
                <Icon key="i" name={icon} size={24} className="dr-filedrop__icon" />,
                <div key="t" className="dr-filedrop__title">
                    {title}
                </div>,
                hint
                    ? (
                        <div key="h" className="dr-filedrop__hint">
                            {hint}
                        </div>
                    )
                    : null,
            ]}
        </div>
    )
}

export interface ColorSwatchProps extends Omit<HTMLAttributes<HTMLSpanElement>, "onChange"> {
    value: string
    onChange?: (color: string) => void
    presets?: string[]
    disabled?: boolean
    label?: string
    className?: string
}

/** A color picker swatch (the color is user data: a layer's color, a path's color), with optional presets. */
export function ColorSwatch({
    value,
    onChange,
    presets,
    disabled,
    label = "Color",
    className,
    ...rest
}: ColorSwatchProps) {
    return (
        <span className={cx("dr-swatch", className)} {...rest}>
            <label className={cx("dr-swatch__pick", disabled && "dr-swatch__pick--disabled")} title={value}>
                <span className="dr-swatch__color" style={{ background: value }} />
                <input
                    type="color"
                    className="dr-sr-only"
                    aria-label={label}
                    value={value}
                    disabled={disabled}
                    onChange={(event) => onChange?.(event.target.value)}
                />
            </label>
            {presets?.map((preset) => (
                <button
                    key={preset}
                    type="button"
                    disabled={disabled}
                    title={preset}
                    aria-label={`${label} ${preset}`}
                    aria-pressed={preset.toLowerCase() === String(value).toLowerCase()}
                    className="dr-swatch__preset"
                    style={{ background: preset }}
                    onClick={() => onChange?.(preset)}
                />
            ))}
        </span>
    )
}

export interface KeyHintsProps extends HTMLAttributes<HTMLDivElement> {
    /** [keys, label] pairs; keys is a list or a space-separated string */
    hints?: [string | string[], ReactNode][]
    vertical?: boolean
    className?: string
}

/** Key hints for a HUD: `[[["W", "A", "S", "D"], "drive"], [["Space"], "stop"]]` (a string key list works too: "W A S D"). */
export function KeyHints({ hints = [], vertical = false, className, ...rest }: KeyHintsProps) {
    return (
        <div className={cx("dr-keyhints", vertical && "dr-keyhints--vertical", className)} {...rest}>
            {hints.map(([keys, label], index) => (
                <span key={index} className="dr-keyhints__item">
                    {(Array.isArray(keys) ? keys : String(keys).split(" ")).map((key, keyIndex) => (
                        <kbd key={keyIndex} className="dr-kbd">
                            {key}
                        </kbd>
                    ))}
                    <span className="dr-keyhints__label">{label}</span>
                </span>
            ))}
        </div>
    )
}

/** Keeps calling `onTick(value)` at `hz` while `value` is non-zero (a joystick held still still drives). */
export function useRepeatWhileHeld(
    value: StickValue | null | undefined,
    onTick: (value: StickValue) => void,
    hz: number = 10,
): void {
    const latest = useRef(onTick)
    latest.current = onTick
    const active = value && (value.x || value.y)
    useEffect(() => {
        if (!active) {
            return
        }
        const timer = setInterval(() => latest.current(value), 1000 / hz)
        return () => clearInterval(timer)
    }, [active, value?.x, value?.y, hz])
}
