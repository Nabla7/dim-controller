// Small hooks every app hand-rolled: persisted state, keys, Escape, mobile, pointer drags, a ticking clock, gamepads.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { CSSProperties, MutableRefObject, PointerEvent as ReactPointerEvent } from "react"

/** useState that survives reloads (localStorage, JSON). A blocked or full storage just keeps it in memory. */
export function usePersistentState<T>(key: string, initial: T | (() => T)): [T, (next: T | ((old: T) => T)) => void] {
    const [value, setValue] = useState<T>(() => {
        try {
            const saved = globalThis.localStorage?.getItem(key)
            if (saved !== null && saved !== undefined) {
                return JSON.parse(saved)
            }
        } catch {
            // unreadable: the initial value
        }
        return typeof initial === "function" ? (initial as () => T)() : initial
    })
    const set = useCallback(
        (next: T | ((old: T) => T)) => {
            setValue((old) => {
                const resolved = typeof next === "function" ? (next as (old: T) => T)(old) : next
                try {
                    globalThis.localStorage?.setItem(key, JSON.stringify(resolved))
                } catch {
                    // storage blocked or full
                }
                return resolved
            })
        },
        [key],
    )
    return [value, set]
}

const isTyping = (event: Event) => {
    const target = event.target as HTMLElement | null
    return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? ""))
}

/** The parts of a keyboard event (DOM or React) a hotkey looks at. */
export type HotkeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">

/** "mod+k" → does `event` match it (mod = ⌘ on Mac, Ctrl elsewhere)? */
export function matchesHotkey(event: HotkeyEvent, combo: string): boolean {
    const parts = combo
        .toLowerCase()
        .split("+")
        .map((part) => part.trim())
    const key = parts.pop() ?? ""
    const mac = /mac|iphone|ipad/i.test(globalThis.navigator?.platform ?? "")
    const want = {
        ctrl: parts.includes("ctrl") || (!mac && parts.includes("mod")),
        meta: parts.includes("meta") || parts.includes("cmd") || (mac && parts.includes("mod")),
        alt: parts.includes("alt") || parts.includes("option"),
        shift: parts.includes("shift"),
    }
    const pressed = (event.key ?? "").toLowerCase()
    const named: Record<string, string> = {
        esc: "escape",
        space: " ",
        up: "arrowup",
        down: "arrowdown",
        left: "arrowleft",
        right: "arrowright",
    }
    return (
        (pressed === (named[key] ?? key) || (event.code ?? "").toLowerCase() === `key${key}`) &&
        event.ctrlKey === want.ctrl &&
        event.metaKey === want.meta &&
        event.altKey === want.alt &&
        (event.shiftKey === want.shift || (key.length === 1 && !/[a-z0-9]/.test(key)))
    )
}

/**
 * Keyboard shortcuts: `{ "mod+k": openPalette, "?": showHelp }`. Ignored while typing in a field unless the combo has
 * a modifier. `enabled: false` turns them all off.
 */
export function useHotkeys(
    bindings: Record<string, (event: KeyboardEvent) => void>,
    { enabled = true, target }: { enabled?: boolean; target?: EventTarget } = {},
): void {
    const ref = useRef(bindings)
    ref.current = bindings
    useEffect(() => {
        if (!enabled) {
            return
        }
        const on: EventTarget = target ?? globalThis
        const listener = (domEvent: Event) => {
            const event = domEvent as KeyboardEvent
            for (const [combo, handler] of Object.entries(ref.current)) {
                if (!matchesHotkey(event, combo)) {
                    continue
                }
                if (isTyping(event) && !/(mod|ctrl|meta|cmd|alt)\+/.test(combo.toLowerCase())) {
                    continue
                }
                event.preventDefault()
                handler(event)
                return
            }
        }
        on.addEventListener("keydown", listener)
        return () => on.removeEventListener("keydown", listener)
    }, [enabled, target])
}

/**
 * The set of keys held right now (KeyboardEvent.code, e.g. "KeyW", "ArrowUp"), for driving and jogging. Cleared when
 * the window loses focus so a key never sticks. Only `codes` are tracked (default: all).
 */
export function useHeldKeys({ codes, enabled = true }: { codes?: string[]; enabled?: boolean } = {}): Set<string> {
    const [held, setHeld] = useState(() => new Set<string>())
    const wanted = codes ? codes.join(",") : ""
    useEffect(() => {
        if (!enabled) {
            setHeld(new Set())
            return
        }
        const allow = wanted ? new Set(wanted.split(",")) : null
        const current = new Set<string>()
        const push = () => setHeld(new Set(current))
        const down = (event: KeyboardEvent) => {
            if (isTyping(event) || (allow && !allow.has(event.code)) || current.has(event.code)) {
                return
            }
            current.add(event.code)
            push()
        }
        const up = (event: KeyboardEvent) => {
            if (current.delete(event.code)) {
                push()
            }
        }
        const clear = () => {
            if (current.size) {
                current.clear()
                push()
            }
        }
        addEventListener("keydown", down)
        addEventListener("keyup", up)
        addEventListener("blur", clear)
        document.addEventListener("visibilitychange", clear)
        return () => {
            removeEventListener("keydown", down)
            removeEventListener("keyup", up)
            removeEventListener("blur", clear)
            document.removeEventListener("visibilitychange", clear)
        }
    }, [wanted, enabled])
    return held
}

/** Calls `handler` on Escape (while `enabled`). The most recently mounted handler wins, so nested popups close in order. */
const escapeStack: { call: (event: KeyboardEvent) => void }[] = []
export function useEscape(handler: (event: KeyboardEvent) => void, enabled = true): void {
    const ref = useRef(handler)
    ref.current = handler
    useEffect(() => {
        if (!enabled) {
            return
        }
        const entry = { call: (event: KeyboardEvent) => ref.current(event) }
        escapeStack.push(entry)
        const listener = (event: KeyboardEvent) => {
            if (event.key === "Escape" && escapeStack[escapeStack.length - 1] === entry) {
                event.stopPropagation()
                entry.call(event)
            }
        }
        addEventListener("keydown", listener)
        return () => {
            removeEventListener("keydown", listener)
            escapeStack.splice(escapeStack.indexOf(entry), 1)
        }
    }, [enabled])
}

/** Whether a CSS media query matches, live. */
export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback(
        (notify: () => void) => {
            const list = globalThis.matchMedia?.(query)
            list?.addEventListener("change", notify)
            return () => list?.removeEventListener("change", notify)
        },
        [query],
    )
    return useSyncExternalStore(
        subscribe,
        () => !!globalThis.matchMedia?.(query).matches,
        () => false,
    )
}

/** A phone-sized or touch-first viewport (narrow, or a coarse pointer with no hover). */
export function useMobile(maxWidth = 700): boolean {
    const narrow = useMediaQuery(`(max-width: ${maxWidth}px)`)
    const touch = useMediaQuery("(hover: none) and (pointer: coarse)")
    return narrow || touch
}

/** Where a drag is: pointer position, offset since the start, the event and the handle element. */
export interface DragInfo {
    x: number
    y: number
    dx: number
    dy: number
    event: PointerEvent | ReactPointerEvent<HTMLElement>
    element: HTMLElement
}

export interface DragHandlers {
    onStart?: (info: DragInfo) => void
    onMove?: (info: DragInfo) => void
    onEnd?: (info: DragInfo) => void
    disabled?: boolean
}

/** The props useDrag returns, to spread on the handle element. */
export interface DragProps {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    style: CSSProperties
}

/**
 * Pointer drags (mouse, pen, touch) on an element: `onStart(point)`, `onMove({ dx, dy, x, y, event })` with dx/dy
 * since the start, `onEnd(...)`. Returns props to spread on the handle element.
 */
export function useDrag(handlers: DragHandlers): DragProps {
    const ref = useRef(handlers)
    ref.current = handlers
    const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
        if (ref.current.disabled || (event.pointerType === "mouse" && event.button !== 0)) {
            return
        }
        const element = event.currentTarget
        const start = { x: event.clientX, y: event.clientY }
        element.setPointerCapture?.(event.pointerId)
        const info = (moveEvent: PointerEvent | ReactPointerEvent<HTMLElement>): DragInfo => ({
            x: moveEvent.clientX,
            y: moveEvent.clientY,
            dx: moveEvent.clientX - start.x,
            dy: moveEvent.clientY - start.y,
            event: moveEvent,
            element,
        })
        ref.current.onStart?.(info(event))
        const move = (moveEvent: PointerEvent) => ref.current.onMove?.(info(moveEvent))
        const end = (endEvent: PointerEvent) => {
            element.removeEventListener("pointermove", move)
            element.removeEventListener("pointerup", end)
            element.removeEventListener("pointercancel", end)
            ref.current.onEnd?.(info(endEvent))
        }
        element.addEventListener("pointermove", move)
        element.addEventListener("pointerup", end)
        element.addEventListener("pointercancel", end)
    }, [])
    return { onPointerDown, style: { touchAction: "none" } }
}

/** `Date.now()`, re-rendered every `intervalMs` (for "3 s ago" labels and staleness). */
export function useNow(intervalMs = 1000): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(timer)
    }, [intervalMs])
    return now
}

/** A gamepad's state (useGamepad). */
export interface GamepadState {
    id: string
    axes: number[]
    buttons: boolean[]
}

/**
 * The first connected gamepad, polled each animation frame: `{ id, axes, buttons: boolean[] } | null`.
 * `deadzone` zeroes small stick values.
 */
export function useGamepad({
    deadzone = 0.08,
    enabled = true,
}: { deadzone?: number; enabled?: boolean } = {}): GamepadState | null {
    const [pad, setPad] = useState<GamepadState | null>(null)
    useEffect(() => {
        if (!enabled || !globalThis.navigator?.getGamepads) {
            return
        }
        let frame = 0
        let last = ""
        const poll = () => {
            frame = requestAnimationFrame(poll)
            const found = [...navigator.getGamepads()].find(Boolean)
            const next: GamepadState | null = found
                ? {
                    id: found.id,
                    axes: found.axes.map((value) => (Math.abs(value) < deadzone ? 0 : value)),
                    buttons: found.buttons.map((button) => button.pressed),
                }
                : null
            const signature = JSON.stringify(next)
            if (signature !== last) {
                last = signature
                setPad(next)
            }
        }
        poll()
        return () => cancelAnimationFrame(frame)
    }, [deadzone, enabled])
    return pad
}

/** The latest value of `value` in a ref (for callbacks that must not re-subscribe). */
export function useLatest<T>(value: T): MutableRefObject<T> {
    const ref = useRef(value)
    ref.current = value
    return ref
}

/**
 * Copies text to the clipboard → true when it worked. Pages served over plain http (a robot reached by IP) have no
 * navigator.clipboard (secure contexts only), so it falls back to a hidden textarea + execCommand("copy").
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (globalThis.navigator?.clipboard && globalThis.isSecureContext) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {
        // fall through to the textarea
    }
    if (typeof document === "undefined") {
        return false
    }
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0"
    document.body.appendChild(area)
    area.select()
    let ok: boolean
    try {
        ok = document.execCommand("copy")
    } catch {
        ok = false
    }
    area.remove()
    return ok
}
