// The action bar's buttons (server/src/action_buttons.rs): this machine's, each a label and a shell command a click
// runs. Agents add them (POST api/action_buttons); the bar's edit mode adds and removes them. Every open page follows
// the backend's `action_buttons` events (core/agent.ts).
import { Store } from "./store.ts"

export interface ActionButton {
    id: string
    label: string
    command: string
}

export interface RunResult {
    ok: boolean
    exitCode: number | null
    stdout: string
    stderr: string
    ms: number
    error?: string
}

export const actionButtons = new Store<{ buttons: ActionButton[] }>({ buttons: [] })

const url = (path: string) => new URL(path, location.href).href

async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(url(path), { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    const result = await response.json().catch(() => ({}))
    if (!response.ok && !("exitCode" in result)) {
        throw new Error(result.error ?? `${response.status}`)
    }
    return result
}

export async function loadActionButtons() {
    const { buttons } = await call("GET", "api/action_buttons")
    actionButtons.set({ buttons: buttons ?? [] })
}

export async function addActionButton(label: string, command: string) {
    const { buttons } = await call("POST", "api/action_buttons", { label, command })
    actionButtons.set({ buttons })
}

export async function removeActionButton(id: string) {
    const { buttons } = await call("DELETE", `api/action_buttons/${encodeURIComponent(id)}`)
    actionButtons.set({ buttons })
}

export async function runActionButton(id: string): Promise<RunResult> {
    try {
        return await call("POST", `api/action_buttons/${encodeURIComponent(id)}/run`)
    } catch (error) {
        return { ok: false, exitCode: null, stdout: "", stderr: "", ms: 0, error: (error as Error).message }
    }
}
