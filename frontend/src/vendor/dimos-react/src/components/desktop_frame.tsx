// A page framed by Desktop (its Details modal, a panel): Desktop answers dimos:* messages from the frame. It says
// whether the page should draw its own top bar (dimos:chrome → dimos:chrome-ok), closes it (dimos:close) and opens
// files in the user's editor (dimos:open-in-editor → dimos:open-in-editor-result) and hides or shows a preloaded page
// (dimos:visible).
import { useEffect, useState } from "react"
import { cx } from "../cx.ts"
import { useLatest } from "../hooks.ts"

/** Whether this page is in a frame (Desktop's), so it can ask Desktop for things. */
export const framedByDesktop = (): boolean => typeof window !== "undefined" && window.parent !== window

/** Posts a dimos:* message to the Desktop framing this page. */
export const toDesktop = (message: { type: string; [key: string]: unknown }): void =>
    window.parent.postMessage(message, location.origin)

/** Calls `handler` with each message Desktop (the parent, same origin) posts of this type. */
export function useDesktopMessage(type: string, handler: (data: Record<string, unknown>) => void): void {
    const latest = useLatest(handler)
    useEffect(() => {
        const listen = (event: MessageEvent) => {
            if (event.origin === location.origin && event.source === window.parent && event.data?.type === type) {
                latest.current(event.data)
            }
        }
        addEventListener("message", listen)
        return () => removeEventListener("message", listen)
    }, [type, latest])
}

/**
 * Whether to draw the page's own top bar: always off Desktop; framed, once Desktop says so (dimos:chrome-ok).
 * `{ pausable: true }` tells Desktop the page stops polling while hidden (useDesktopVisible), so it may preload it.
 */
export function useDesktopChrome(features: { pausable?: boolean } = {}): boolean {
    const framed = framedByDesktop()
    const [chrome, setChrome] = useState(!framed)
    useDesktopMessage("dimos:chrome-ok", () => setChrome(true))
    const pausable = !!features.pausable
    useEffect(() => {
        if (framed) {
            toDesktop({ type: "dimos:chrome", ...(pausable ? { pausable } : {}) })
        }
    }, [framed, pausable])
    return chrome
}

/** Whether the page is shown: false from the start with ?hidden=1 (Desktop preloading it), then per dimos:visible. */
export function useDesktopVisible(): boolean {
    const [visible, setVisible] = useState(
        () => typeof location === "undefined" || new URLSearchParams(location.search).get("hidden") !== "1",
    )
    useDesktopMessage("dimos:visible", (data) => setVisible(!!data.visible))
    return visible
}

export interface EditorStatus {
    ok: boolean
    text: string
}

/** `open(file, line)` asks Desktop to open a file in the user's editor (null when not framed); `status` is its answer. */
export function useDesktopEditor(): {
    open: ((file: string, line: number) => void) | null
    status: EditorStatus | null
} {
    const [status, setStatus] = useState<EditorStatus | null>(null)
    useDesktopMessage(
        "dimos:open-in-editor-result",
        (data) => setStatus({ ok: !!data.ok, text: String(data.text ?? "") }),
    )
    const open = (file: string, line: number) => {
        setStatus(null)
        toDesktop({ type: "dimos:open-in-editor", file, line })
    }
    return { open: framedByDesktop() ? open : null, status }
}

/** One line saying how opening a file in the editor went (nothing before an answer). */
export function EditorNote({ status, className }: { status: EditorStatus | null; className?: string }) {
    return status
        ? (
            <div
                className={cx("dr-editor-note", !status.ok && "dr-editor-note--failed", className)}
                title={status.text}
            >
                {status.text}
            </div>
        )
        : null
}
