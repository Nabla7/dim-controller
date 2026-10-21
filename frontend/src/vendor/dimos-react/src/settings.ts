// What a setting's input takes, from a JSON schema or a Python type annotation, and the value text typed into it
// means. No DOM: the settings form (components/settings.tsx) draws them.

export type SettingKind = "bool" | "enum" | "integer" | "number" | "string" | "path" | "json"

/** What <SettingInput> needs to know about a setting. */
export interface SettingField {
    name: string
    kind: SettingKind
    /** null (an empty box) is a value */
    nullable?: boolean
    /** an enum's values */
    options?: unknown[]
    /** an enum's labels, by option */
    optionLabels?: string[]
    /** a password box (with show / hide) */
    secret?: boolean
    placeholder?: string
}

/** What a gateway sends in place of a saved secret. */
export const HIDDEN_SECRET = "•••"

/** Equal as JSON (null and undefined alike). */
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// a JSON schema, as loose as they come
// deno-lint-ignore no-explicit-any -- JSON Schema values are any JSON
export type JsonSchema = Record<string, any>

/** A schema with its $ref followed and an optional (anyOf [T, null]) unwrapped to T. */
export function resolveSchema(schema: JsonSchema, root: JsonSchema = schema): JsonSchema {
    if (schema.$ref) {
        const key = String(schema.$ref).split("/").pop()!
        const target = root.$defs?.[key] ?? root.definitions?.[key]
        if (target) {
            return resolveSchema({ ...target, ...schema, $ref: undefined }, root)
        }
    }
    const variants: JsonSchema[] | undefined = schema.anyOf ?? schema.oneOf
    if (variants && !schema.type) {
        const nonNull = variants.filter((variant) => variant.type !== "null")
        if (nonNull.length === 1) {
            return { ...resolveSchema(nonNull[0], root), description: schema.description, default: schema.default }
        }
    }
    return schema
}

/** Whether a schema takes null. */
export const schemaNullable = (schema: JsonSchema): boolean =>
    ((schema.anyOf ?? schema.oneOf ?? []) as JsonSchema[]).some((variant) => variant.type === "null") ||
    (Array.isArray(schema.type) && schema.type.includes("null"))

/** The input a (resolved) schema takes; "json" for anything without a typed input. */
export function schemaKind(schema: JsonSchema): SettingKind {
    if (schema.enum) {
        return "enum"
    }
    const type = Array.isArray(schema.type) ? schema.type.find((name: string) => name !== "null") : schema.type
    if (type === "boolean") {
        return "bool"
    }
    if (type === "integer" || type === "number") {
        return type
    }
    if (type === "string") {
        return schema.format === "path" ? "path" : "string"
    }
    return "json"
}

const PYTHON_KINDS: Record<string, SettingKind> = { bool: "bool", int: "integer", float: "number", str: "string" }

/** The input a Python annotation (`int`, `str | None`, `Optional[Path]`) takes; "json" for anything else. */
export function pythonTypeKind(type: string | null | undefined): { kind: SettingKind; nullable: boolean } {
    const parts = (type ?? "")
        .split("|")
        .map((part) => part.trim())
        .filter(Boolean)
    const nullable = parts.includes("None") || /^Optional\[/.test(type ?? "")
    const main = parts.filter((part) => part !== "None")
    if (main.length !== 1) {
        return { kind: "json", nullable }
    }
    const one = main[0].replace(/^Optional\[(.*)\]$/, "$1")
    return { kind: PYTHON_KINDS[one] ?? (/(^|\.)Path$/.test(one) ? "path" : "json"), nullable }
}

/** A value as the text in its box ("" for none; JSON for anything not a string). */
export const settingText = (value: unknown): string =>
    value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)

/** A value as a person reads it ("—" for none, "" quoted). */
export const settingLabel = (value: unknown): string =>
    value === null || value === undefined
        ? "—"
        : value === ""
        ? '""'
        : typeof value === "string"
        ? value
        : JSON.stringify(value)

/** The value typed text means for this setting, or what it should have been. */
export function parseSettingText(
    field: Pick<SettingField, "kind" | "nullable">,
    text: string,
): { value: unknown } | { error: string } {
    const trimmed = text.trim()
    if (trimmed === "" && field.nullable) {
        return { value: null }
    }
    if (field.kind === "integer" || field.kind === "number") {
        const number = Number(trimmed)
        if (trimmed === "" || !Number.isFinite(number)) {
            return { error: "a number" }
        }
        if (field.kind === "integer" && !Number.isInteger(number)) {
            return { error: "a whole number" }
        }
        return { value: number }
    }
    if (field.kind === "json") {
        try {
            return { value: JSON.parse(text) }
        } catch {
            return { error: "JSON" }
        }
    }
    return { value: text }
}
