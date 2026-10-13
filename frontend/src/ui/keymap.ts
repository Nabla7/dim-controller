// The keyboard, decided in one place (pure, unit tested in test/keymap.test.ts): what a key press means given whether a
// field has the focus and which overlay is open. Space always stops (even while typing, where it still types its
// space; even with the palette open). Drive keys (the profile's: WASD/QE and the arrows) and Shift only while nothing
// is being typed and no overlay is open; Ctrl/Alt/Meta combinations belong to the browser and Desktop's shell.
import type { RobotProfile } from "../profile/types.ts"

export type Overlay = "palette" | "help" | "drawer" | null

export interface KeyInput {
    code: string
    key: string
    metaKey?: boolean
    ctrlKey?: boolean
    altKey?: boolean
    shiftKey?: boolean
    repeat?: boolean
}

export type KeyDecision =
    /** release everything and stop; `consume`: keep the key from the page (not while typing: the space is typed) */
    | { kind: "stop"; consume: boolean }
    | { kind: "palette" }
    | { kind: "help" }
    /** Escape: close the open overlay (and stop) */
    | { kind: "close" }
    | { kind: "boost"; on: boolean }
    /** a profile drive key: hold to move */
    | { kind: "drive" }
    | { kind: "rail"; side: "left" | "right" }
    | { kind: "focus" }
    | { kind: "none" }

export interface KeyContext {
    /** a text field, select or contenteditable has the focus */
    typing: boolean
    overlay: Overlay
    /** the profile's drive keys (KeyboardEvent.code → action) */
    driveKeys: RobotProfile["drive"]["keys"]
}

export function isTypingTarget(target: unknown): boolean {
    const element = target as { tagName?: string; isContentEditable?: boolean } | null
    return !!element && (element.isContentEditable === true || ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName ?? ""))
}

export function routeKeyDown(event: KeyInput, context: KeyContext): KeyDecision {
    const modified = event.metaKey || event.ctrlKey || event.altKey
    if (event.code === "Space" && !modified) {
        return { kind: "stop", consume: !context.typing }
    }
    if (event.key === "Escape") {
        return { kind: "close" }
    }
    if (modified || context.typing) {
        return { kind: "none" }
    }
    if (event.key === "?") {
        return { kind: "help" }
    }
    if (event.key === "/") {
        return { kind: "palette" }
    }
    if (context.overlay === "palette" || context.overlay === "help") {
        return { kind: "none" }
    }
    if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
        return { kind: "boost", on: true }
    }
    if (event.code in context.driveKeys) {
        return { kind: "drive" }
    }
    if (event.key === "[") {
        return { kind: "rail", side: "left" }
    }
    if (event.key === "]") {
        return { kind: "rail", side: "right" }
    }
    if (event.key === "\\") {
        return { kind: "focus" }
    }
    return { kind: "none" }
}

export interface Binding {
    keys: string[]
    action: string
    group: "Drive" | "Commands" | "Panels"
}

const KEY_NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space" }
export const keyName = (code: string) => KEY_NAMES[code] ?? code.replace(/^Key/, "").replace(/^Digit/, "")

const AXIS_WORDS: Record<string, [string, string]> = {
    forward: ["Forward", "Back"],
    turn: ["Turn left", "Turn right"],
    strafe: ["Strafe left", "Strafe right"],
    vertical: ["Up", "Down"],
}

/** Every binding, for the `?` sheet and the palette: the profile's drive keys (grouped per action), then the fixed ones. */
export function keyBindings(profile: Pick<RobotProfile, "drive" | "controls"> | null): Binding[] {
    const drive = new Map<string, string[]>()
    for (const [code, action] of Object.entries(profile?.drive.keys ?? {})) {
        const label = "axis" in action
            ? `${AXIS_WORDS[action.axis]?.[action.value > 0 ? 0 : 1] ?? action.axis} (hold)`
            : "joint" in action
            ? `Picked joint ${action.joint > 0 ? "▲ +" : "▼ −"} (hold)`
            : `${profile?.controls.find((control) => control.id === action.control)?.label ?? action.control} ${(action.step ?? 1) > 0 ? "+" : "−"}`
        drive.set(label, [...(drive.get(label) ?? []), keyName(code)])
    }
    return [
        ...[...drive].map(([action, keys]) => ({ keys, action, group: "Drive" as const })),
        { keys: ["Shift"], action: "Boost while held", group: "Drive" },
        { keys: ["Space"], action: "STOP (always, even while typing)", group: "Drive" },
        { keys: ["/"], action: "Command palette: every action, searchable", group: "Commands" },
        { keys: ["?"], action: "This list of shortcuts", group: "Commands" },
        { keys: ["Esc"], action: "Close the palette, this list or a drawer; stop", group: "Commands" },
        { keys: ["["], action: "Show / hide the left rail", group: "Panels" },
        { keys: ["]"], action: "Show / hide the right rail", group: "Panels" },
        { keys: ["\\"], action: "Focus the main view (hide both rails)", group: "Panels" },
    ]
}
