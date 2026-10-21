/** Joins the truthy class names */
export function cx(...names: unknown[]): string {
    return names.filter(Boolean).join(" ")
}
