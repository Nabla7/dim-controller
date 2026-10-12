// The two overlays (ui/overlay.ts): the `/` command palette (every action, searchable: words narrow it, ↑ ↓ pick,
// Enter runs, Escape closes) and the `?` shortcut list. Typing in the palette never drives (the keyboard ignores keys
// while a field has the focus); Space still stops, and still types its space.
import { gamepadBindings } from "../core/gamepad.ts"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { type Command, filterCommands } from "./commands.ts"
import { keyBindings } from "./keymap.ts"
import { closeOverlay, overlay } from "./overlay.ts"
import { type CameraActions, useCommands } from "./useCommands.ts"
import type { WorkspaceApi } from "./Workspace.tsx"
import { Icon } from "./icons.tsx"

export function Overlays({ app, api, cameras }: { app: ViewerApp; api: WorkspaceApi; cameras: CameraActions }) {
    const { open } = useStore(overlay)
    if (open === "palette") {
        return <Palette app={app} api={api} cameras={cameras} />
    }
    if (open === "help") {
        return <ShortcutHelp app={app} />
    }
    return null
}

function Palette({ app, api, cameras }: { app: ViewerApp; api: WorkspaceApi; cameras: CameraActions }) {
    const commands = useCommands(app, api, cameras)
    const [query, setQuery] = useState("")
    const [selected, setSelected] = useState(0)
    const input = useRef<HTMLInputElement>(null)
    const list = useRef<HTMLDivElement>(null)
    const shown = useMemo(() => filterCommands(commands, query), [commands, query])
    const index = Math.min(selected, Math.max(0, shown.length - 1))
    useEffect(() => {
        input.current?.focus()
    }, [])
    useEffect(() => {
        list.current?.querySelector<HTMLElement>(".palette-item.on")?.scrollIntoView({ block: "nearest" })
    }, [index])
    const run = (command: Command | undefined) => {
        if (!command || command.blocked) {
            return
        }
        closeOverlay()
        command.run()
    }
    return (
        <div className="lv-overlay" onPointerDown={(event) => event.target === event.currentTarget && closeOverlay()}>
            <div className="dim-panel palette" role="dialog" aria-label="Command palette" data-testid="palette">
                <div className="palette-search">
                    <Icon name="search" size={16} />
                    <input
                        ref={input}
                        className="palette-input"
                        placeholder="Try: add a camera · reset the layout · start recording · keyboard shortcuts"
                        aria-label="Search commands"
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value)
                            setSelected(0)
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                                event.preventDefault()
                                const step = event.key === "ArrowDown" ? 1 : -1
                                setSelected((index + step + shown.length) % Math.max(1, shown.length))
                            } else if (event.key === "Enter") {
                                event.preventDefault()
                                run(shown[index])
                            }
                        }}
                    />
                    <kbd className="lv-kbd">Esc</kbd>
                </div>
                <div className="palette-list" ref={list} role="listbox" aria-label="Commands">
                    {!shown.length && <p className="palette-empty">Nothing matches "{query}".</p>}
                    {shown.map((command, at) => (
                        <button
                            key={command.id}
                            type="button"
                            role="option"
                            aria-selected={at === index}
                            aria-disabled={!!command.blocked || undefined}
                            className={`palette-item ${at === index ? "on" : ""} ${command.danger ? "danger" : ""} ${command.blocked ? "blocked" : ""}`}
                            title={command.blocked ?? command.hint ?? ""}
                            onPointerMove={() => at !== index && setSelected(at)}
                            onClick={() => run(command)}
                        >
                            <span className="palette-group">{command.group}</span>
                            <span className="palette-label">{command.label}</span>
                            {(command.blocked ?? command.hint) && <span className="palette-hint">{command.blocked ?? command.hint}</span>}
                            {command.keys?.map((key) => <kbd key={key} className="lv-kbd">{key}</kbd>)}
                        </button>
                    ))}
                </div>
                <div className="palette-foot">
                    <span><kbd className="lv-kbd">↑</kbd><kbd className="lv-kbd">↓</kbd> pick</span>
                    <span><kbd className="lv-kbd">Enter</kbd> run</span>
                    <span><kbd className="lv-kbd">Space</kbd> stops, always</span>
                    <span><kbd className="lv-kbd">?</kbd> all shortcuts</span>
                </div>
            </div>
        </div>
    )
}

function ShortcutHelp({ app }: { app: ViewerApp }) {
    useStore(app.robot)
    const bindings = keyBindings(app.profile)
    const groups = [...new Set(bindings.map((binding) => binding.group))]
    return (
        <div className="lv-overlay" onPointerDown={(event) => event.target === event.currentTarget && closeOverlay()}>
            <div className="dim-panel shortcut-help" role="dialog" aria-label="Keyboard shortcuts" data-testid="shortcut-help">
                <div className="help-head">
                    <h2 className="dim-card-title">Keyboard</h2>
                    <span className="hint">{app.profile.name} keys · keys drive whenever the page has focus, never while typing</span>
                    <button type="button" className="dim-btn icon icon-button" aria-label="Close" title="Close (Esc)" onClick={closeOverlay}><Icon name="close" size={15} /></button>
                </div>
                <div className="help-groups">
                    {groups.map((group) => (
                        <section key={group} className="help-group">
                            <h3 className="dim-label">{group}</h3>
                            <dl>
                                {bindings.filter((binding) => binding.group === group).map((binding) => (
                                    <div key={binding.action} className="help-row">
                                        <dt>{binding.keys.map((key) => <kbd key={key} className="lv-kbd">{key}</kbd>)}</dt>
                                        <dd>{binding.action}</dd>
                                    </div>
                                ))}
                            </dl>
                        </section>
                    ))}
                    <section className="help-group" data-testid="gamepad-help">
                        <h3 className="dim-label">Gamepad</h3>
                        <dl>
                            {gamepadBindings(app.profile).map((binding) => (
                                <div key={binding.buttons} className="help-row">
                                    <dt><kbd className="lv-kbd">{binding.buttons}</kbd></dt>
                                    <dd>{binding.action}</dd>
                                </div>
                            ))}
                        </dl>
                        <p className="hint">Nothing is sent until both sticks are at rest after the pad connects (or after a stop, a blur or a hidden tab).</p>
                    </section>
                    <section className="help-group">
                        <h3 className="dim-label">Panels</h3>
                        <p className="hint">Every panel's header has the same buttons, shown on hover: collapse / expand (collapsed, it stops its stream), make it the main view, pop out / dock. Drag a header into a rail, onto the main view's middle (swap), or anywhere to float; it snaps to edges. Double-click a header to collapse it. The arrangement is saved on this device.</p>
                    </section>
                </div>
            </div>
        </div>
    )
}
