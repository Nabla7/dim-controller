// A picker for the point-cloud color gradients: a swatch per gradient (GRADIENTS), the chosen one outlined.
import { cx } from "../cx.ts"
import { gradientCss, GRADIENTS } from "./gradients.ts"

import type { HTMLAttributes } from "react"

export interface GradientPickerProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
    value: string
    onChange?: (name: string) => void
    gradients?: string[]
    disabled?: boolean
    className?: string
}

export function GradientPicker({
    value,
    onChange,
    gradients = GRADIENTS,
    disabled,
    className,
    ...rest
}: GradientPickerProps) {
    return (
        <div className={cx("dr-gradient-picker", className)} role="radiogroup" aria-label="Gradient" {...rest}>
            {gradients.map((name) => (
                <button
                    key={name}
                    type="button"
                    role="radio"
                    title={name}
                    aria-label={name}
                    aria-checked={name === value}
                    disabled={disabled}
                    className="dr-gradient-picker__swatch"
                    style={{ background: gradientCss(name) }}
                    onClick={() => onChange?.(name)}
                />
            ))}
        </div>
    )
}
