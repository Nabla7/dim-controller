// A settings form's parts: a typed input per setting (toggle, choice, number, JSON, path, secret), its row (name,
// "saved", reset, a docs link), groups of rows and titled sections.
import { useState } from "react"
import type { HTMLAttributes, ReactNode } from "react"
import { cx } from "../cx.ts"
import { HIDDEN_SECRET, parseSettingText, type SettingField, settingLabel, settingText } from "../settings.ts"
import { Select, TextInput, Toggle } from "./controls.tsx"
import { Segmented } from "./nav.tsx"

export interface SettingInputProps {
    field: SettingField
    value: unknown
    /** the parsed value, once it parses (numbers, JSON); typed text that doesn't shows what it needs instead */
    onChange: (value: unknown) => void
}

const optionLabel = (field: SettingField, option: unknown) =>
    field.optionLabels?.[(field.options ?? []).indexOf(option)] ??
        (option === null ? "(none)" : option === "" ? "(empty)" : String(option))

/**
 * The input a setting's kind takes: a Toggle (bool), a Select (enum; "(none)" too when nullable), or a box that
 * reports on Enter / blur and parses by kind (integer, number, JSON; empty = null when nullable). A secret is a
 * password box with show / hide that selects the gateway's "•••" placeholder on focus.
 */
export function SettingInput({ field, value, onChange }: SettingInputProps) {
    const [problem, setProblem] = useState<string | null>(null)
    const [revealed, setRevealed] = useState(false)
    if (field.kind === "bool") {
        return <Toggle size="sm" aria-label={field.name} value={value === true} onChange={onChange} />
    }
    if (field.kind === "enum") {
        const options = [...(field.nullable ? [null] : []), ...(field.options ?? [])]
        return (
            <span className="dr-setting-input">
                <Select
                    size="sm"
                    aria-label={field.name}
                    value={options.find((option) => JSON.stringify(option) === JSON.stringify(value ?? null))}
                    onChange={onChange}
                    options={options.map((option) => [option, optionLabel(field, option)] as const)}
                />
            </span>
        )
    }
    const commit = (text: string) => {
        const parsed = parseSettingText(field, text)
        setProblem("error" in parsed ? `needs ${parsed.error}` : null)
        if ("value" in parsed) {
            onChange(parsed.value)
        }
    }
    return (
        <span className="dr-setting-input">
            <span className="dr-setting-input__box">
                <TextInput
                    size="sm"
                    mono={field.kind !== "string" || field.secret}
                    aria-label={field.name}
                    type={field.secret && !revealed ? "password" : "text"}
                    autoComplete={field.secret ? "off" : undefined}
                    placeholder={field.placeholder ?? (field.nullable ? "(none)" : field.kind === "path" ? "path" : "")}
                    value={settingText(value)}
                    invalid={!!problem}
                    onCommit={commit}
                    onFocus={(event) => field.secret && event.target.value === HIDDEN_SECRET && event.target.select()}
                />
                {field.secret
                    ? (
                        <button
                            type="button"
                            className="dr-setting__link"
                            title="Saved; never shown again. Type a new one to replace it."
                            onClick={() => setRevealed(!revealed)}
                        >
                            {revealed ? "hide" : "show"}
                        </button>
                    )
                    : null}
            </span>
            {problem ? <span className="dr-setting-input__problem">{problem}</span> : null}
        </span>
    )
}

export interface SettingChoiceProps {
    /** what each choice is called */
    labels: string[]
    /** the chosen one's index; -1 for none */
    value: number
    onChange: (index: number) => void
    label: string
}

/** One of a few named choices: a Segmented control for up to four, a Select past that. */
export function SettingChoice({ labels, value, onChange, label }: SettingChoiceProps) {
    return labels.length <= 4
        ? (
            <Segmented<number>
                size="sm"
                label={label}
                items={labels.map((text, index) => ({ value: index, label: text }))}
                value={value < 0 ? null : value}
                onChange={(index) => index !== value && onChange(index)}
            />
        )
        : (
            <Select
                size="sm"
                aria-label={label}
                value={value}
                placeholder="—"
                options={labels.map((text, index) => [index, text] as const)}
                onChange={onChange}
            />
        )
}

export interface SettingRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
    label: ReactNode
    /** the control: a SettingInput, a SettingChoice, … */
    children: ReactNode
    /** set away from its default: marked "saved", with a reset */
    saved?: boolean
    onReset?: () => void
    /** what reset goes back to (its tooltip) */
    resetTo?: unknown
    /** a "How do I find this?" link */
    docs?: string
    /** the row's tooltip */
    description?: string | null
    /** the control on a line of its own, under the name */
    wide?: boolean
}

/** A setting: its name (and "saved"), its control and a reset, and a docs link under them. */
export function SettingRow({
    label,
    children,
    saved = false,
    onReset,
    resetTo,
    docs,
    description,
    wide = false,
    className,
    ...rest
}: SettingRowProps) {
    return (
        <div
            className={cx("dr-setting", saved && "dr-setting--saved", wide && "dr-setting--wide", className)}
            title={description ?? undefined}
            {...rest}
        >
            <span className="dr-setting__name">
                {label}
                {saved ? <span className="dr-setting__mark">saved</span> : null}
            </span>
            <span className="dr-setting__control">
                {children}
                {onReset
                    ? (
                        saved
                            ? (
                                <button
                                    type="button"
                                    className="dr-setting__link dr-setting__reset"
                                    title={`back to ${settingLabel(resetTo)}`}
                                    aria-label={`reset ${typeof label === "string" ? label : ""}`.trim()}
                                    onClick={onReset}
                                >
                                    reset
                                </button>
                            )
                            : <span className="dr-setting__reset" />
                    )
                    : null}
            </span>
            {docs
                ? (
                    <a className="dr-setting__docs" href={docs} target="_blank" rel="noopener noreferrer">
                        How do I find this?
                    </a>
                )
                : null}
        </div>
    )
}

export interface SettingGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
    title: ReactNode
    /** how many are saved (hidden at 0) */
    count?: number
    /** an accent bar on its header (e.g. a module's own settings) */
    accent?: boolean
}

/** A bordered group of SettingRows under a header, with how many of them are saved. */
export function SettingGroup({ title, count = 0, accent = false, className, children, ...rest }: SettingGroupProps) {
    return (
        <div className={cx("dr-setting-group", accent && "dr-setting-group--accent", className)} {...rest}>
            <div className="dr-setting-group__head">
                {title}
                <span className="dr-setting-group__count">{count || ""}</span>
            </div>
            {children}
        </div>
    )
}

export interface SettingSectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
    title: ReactNode
    /** beside the title, e.g. what it applies to */
    note?: ReactNode
    /** a line of help under the title */
    hint?: ReactNode
    /** framed in the accent: the settings to decide first */
    highlight?: boolean
}

/** A titled section of a settings form. */
export function SettingSection({
    title,
    note,
    hint,
    highlight = false,
    className,
    children,
    ...rest
}: SettingSectionProps) {
    return (
        <section
            className={cx("dr-setting-section", highlight && "dr-setting-section--highlight", className)}
            {...rest}
        >
            <div className="dr-setting-section__head">
                {title}
                {note ? <span className="dr-setting-section__note">{note}</span> : null}
            </div>
            {hint ? <p className="dr-setting-section__hint">{hint}</p> : null}
            {children}
        </section>
    )
}
