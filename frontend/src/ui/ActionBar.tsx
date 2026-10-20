// The action bar (core/actionButtons.ts): this machine's buttons along the bottom of the main view, scrolling sideways;
// a click runs the button's shell command and shows how it went. Edit adds a button (label + command) or removes one
// for good. With no buttons it's a single › at the edge.
import { useEffect, useState } from "react"
import { Button, Card, TextInput } from "dimos-react"
import { useStore } from "../core/store.ts"
import { actionButtons, addActionButton, removeActionButton, type RunResult, runActionButton } from "../core/actionButtons.ts"
import { Icon } from "./icons.tsx"
import type { WorkspaceApi } from "./Workspace.tsx"

/** how long a run's result stays beside the bar */
const RESULT_MS = 8000

export function ActionBar({ api }: { api: WorkspaceApi }) {
    const { buttons } = useStore(actionButtons)
    const [opened, setOpened] = useState(false)
    const [editing, setEditing] = useState(false)
    const [adding, setAdding] = useState(false)
    const [running, setRunning] = useState<Set<string>>(new Set())
    const [result, setResult] = useState<(RunResult & { label: string; at: number }) | null>(null)
    const [details, setDetails] = useState(false)
    const [confirm, setConfirm] = useState<string | null>(null)
    useEffect(() => {
        if (!result || details) {
            return
        }
        const timer = setTimeout(() => setResult(null), RESULT_MS)
        return () => clearTimeout(timer)
    }, [result, details])
    const stage = api.layout.stage
    if (api.view.drawer || stage.width < 120) {
        return null
    }
    const open = opened || buttons.length > 0
    const place = { left: stage.x + 8, bottom: innerHeight - (stage.y + stage.height) + 8, maxWidth: stage.width - 16 }
    if (!open) {
        return (
            <div className="action-bar collapsed" style={place}>
                <Button className="dr-btn--icon action-bar-toggle" title="Action buttons" aria-label="Action buttons" onClick={() => setOpened(true)} data-testid="action-bar-open">
                    <Icon name="chevron-right" size={16} />
                </Button>
            </div>
        )
    }
    const run = async (id: string, label: string) => {
        setRunning((now) => new Set(now).add(id))
        const outcome = await runActionButton(id)
        setRunning((now) => {
            const next = new Set(now)
            next.delete(id)
            return next
        })
        setDetails(false)
        setResult({ ...outcome, label, at: Date.now() })
    }
    return (
        <div className="action-bar" style={place} data-testid="action-bar">
            {buttons.length === 0 && (
                <Button className="dr-btn--icon action-bar-toggle" title="Hide" aria-label="Hide the action bar" onClick={() => {
                    setOpened(false)
                    setEditing(false)
                    setAdding(false)
                }}>
                    <Icon name="chevron-left" size={16} />
                </Button>
            )}
            <div className="action-bar-scroll">
                {buttons.map((button) => (
                    <span key={button.id} className="action-button-wrap">
                        <Button
                            className="action-button"
                            title={button.command}
                            disabled={editing || running.has(button.id)}
                            onClick={() => run(button.id, button.label)}
                            data-testid="action-button"
                        >
                            {running.has(button.id) ? `${button.label}…` : button.label}
                        </Button>
                        {editing && (
                            confirm === button.id
                                ? <Button className="action-button-remove confirm" onClick={() => {
                                    setConfirm(null)
                                    removeActionButton(button.id).catch(() => {})
                                }}>Remove for good</Button>
                                : <Button className="dr-btn--icon action-button-remove" title={`Remove ${button.label}`} aria-label={`Remove ${button.label}`} onClick={() => setConfirm(button.id)}>
                                    <Icon name="close" size={13} />
                                </Button>
                        )}
                    </span>
                ))}
                {(editing || buttons.length === 0) && (
                    <Button className="action-button add" onClick={() => setAdding(true)} data-testid="action-add">+ Add</Button>
                )}
            </div>
            {buttons.length > 0 && (
                <Button className="dr-btn--icon action-bar-edit" pressed={editing} title={editing ? "Done" : "Edit: add or remove buttons"} aria-label="Edit the action buttons" onClick={() => {
                    setEditing(!editing)
                    setConfirm(null)
                    setAdding(false)
                }} data-testid="action-edit">
                    <Icon name={editing ? "check" : "edit"} size={15} />
                </Button>
            )}
            {adding && <AddForm onClose={() => setAdding(false)} />}
            {result && (
                <button type="button" className={`action-result ${result.ok ? "ok" : "bad"}`} onClick={() => setDetails(!details)} data-testid="action-result">
                    {result.ok ? "✓" : "✕"} {result.label}{result.error ? `: ${result.error}` : result.ok ? ` · ${(result.ms / 1000).toFixed(1)} s` : ` · exit ${result.exitCode ?? "?"}`}
                </button>
            )}
            {result && details && (
                <Card className="action-output" padded>
                    <div className="action-output-head">
                        <span>{result.label}: exit {result.exitCode ?? "?"} · {(result.ms / 1000).toFixed(1)} s</span>
                        <button type="button" className="net-icon-button" aria-label="Close" onClick={() => setResult(null)}>×</button>
                    </div>
                    {result.stdout && <pre>{result.stdout}</pre>}
                    {result.stderr && <pre className="stderr">{result.stderr}</pre>}
                    {!result.stdout && !result.stderr && <p className="dim">no output</p>}
                </Card>
            )}
        </div>
    )
}

function AddForm({ onClose }: { onClose: () => void }) {
    const [label, setLabel] = useState("")
    const [command, setCommand] = useState("")
    const [error, setError] = useState("")
    const add = async () => {
        try {
            await addActionButton(label, command)
            onClose()
        } catch (failed) {
            setError((failed as Error).message)
        }
    }
    return (
        <Card className="action-add-form" padded data-testid="action-add-form">
            <TextInput value={label} onChange={setLabel} placeholder="Label" aria-label="Label" autoFocus />
            <TextInput value={command} onChange={setCommand} onEnter={add} placeholder="Shell command (runs on this machine)" aria-label="Command" className="mono" />
            {error && <p className="action-add-error">{error}</p>}
            <div className="action-add-actions">
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="primary" disabled={!label.trim() || !command.trim()} onClick={add}>Add</Button>
            </div>
        </Card>
    )
}
