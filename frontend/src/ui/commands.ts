// Every action on the page as a command, so the `/` palette reaches all of them: driving (STOP, Reconnect, boost), each
// panel's own actions (the ones its header has), the layout, the view, recording, settings and the robot
// profile's buttons. The filter (multi-word, every word must match) and the per-panel commands are pure and unit tested
// (test/commands.test.ts).
import { type Arrangement, isCamera, locate } from "./workspace.ts"

export type CommandGroup = "Drive" | "Panels" | "Layout" | "View" | "Cameras" | "Record" | "Robot" | "Settings" | "Help"

export interface Command {
    id: string
    label: string
    group: CommandGroup
    /** shortcut keys to show beside it */
    keys?: string[]
    /** a short tag: where it goes, what it changes */
    hint?: string
    /** red: it stops or moves the robot */
    danger?: boolean
    /** why it can't run now (shown, and it doesn't run) */
    blocked?: string
    /** extra words it's found by */
    words?: string
    run: () => void
}

/** Commands matching `query`: every word in the label, group, hint, keys or extra words; the order kept (empty: all). */
export function filterCommands(commands: Command[], query: string): Command[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) {
        return commands
    }
    return commands.filter((command) => {
        const text = [command.label, command.group, command.hint ?? "", (command.keys ?? []).join(" "), command.words ?? ""].join(" ").toLowerCase()
        return words.every((word) => text.includes(word))
    })
}

/**
 * A panel's header actions: fold / unfold (folded, a panel with a stream of its own unsubscribes), make it the main view
 * (swap: the main view's panel takes its place), and pop out / dock. No close: a panel folds instead.
 */
export type PanelAction = "collapse" | "main" | "minimize" | "popout"

export interface PanelActionState {
    action: PanelAction
    label: string
}

/** The header buttons a panel has where it is now, in their fixed order (the header and the palette share this). */
export function panelActions(arrangement: Arrangement, id: string, options: { mobile: boolean }): PanelActionState[] {
    const zone = locate(arrangement, id)?.zone
    if (!zone) {
        return []
    }
    const states: PanelActionState[] = []
    if (zone !== "stage") {
        states.push({ action: "collapse", label: arrangement.collapsed.includes(id) ? "Expand" : "Collapse (stops its stream)" })
        states.push({ action: "main", label: "Make this the main view (swap)" })
    } else if (arrangement.left.length + arrangement.right.length + arrangement.floating.length > 0) {
        states.push({ action: "minimize", label: "Back to its rail (the previous main view returns)" })
    }
    if (!options.mobile) {
        states.push({ action: "popout", label: zone === "float" ? "Dock into the nearest rail" : "Pop out: float over the main view" })
    }
    return states
}

/** The palette's commands for one panel: show it, then each of its header's actions. */
export function panelCommands(arrangement: Arrangement, id: string, title: string, options: { mobile: boolean }, act: (action: PanelAction | "show") => void): Command[] {
    const zone = locate(arrangement, id)?.zone
    const commands: Command[] = [{
        id: `panel.${id}.show`,
        label: `${title}: show`,
        group: "Panels",
        hint: zone === "stage" ? "main view" : zone === "float" ? "floating" : `${zone} rail`,
        words: "open reveal expand panel",
        run: () => act("show"),
    }]
    for (const state of panelActions(arrangement, id, options)) {
        commands.push({ id: `panel.${id}.${state.action}`, label: `${title}: ${state.label}`, group: "Panels", words: `panel ${state.action} maximize minimize main float dock collapse fold`, run: () => act(state.action) })
    }
    return commands
}

/** what each panel is called (a header's title, a palette entry) */
export function panelTitle(id: string): string {
    if (isCamera(id)) {
        const n = Number(id.split(":")[1])
        return n > 1 ? `Camera ${n}` : "Camera"
    }
    return ({ map: "Map", scene: "3D view", status: "Status", settings: "Settings", arms: "Arms", layers: "Layers", tf: "Transforms (TF)" } as Record<string, string>)[id] ?? id
}
