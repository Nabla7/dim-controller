// Navigation and overlays: tabs, segmented controls, menus, context menus, popovers, tooltips, sidebars, a nav
// rail, a stepper, breadcrumbs and a command palette.
import { cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type {
    ButtonHTMLAttributes,
    CSSProperties,
    HTMLAttributes,
    Key,
    KeyboardEvent as ReactKeyboardEvent,
    MouseEvent as ReactMouseEvent,
    ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { cx } from "../cx.ts"
import { Icon } from "./icon.tsx"
import { useEscape, useHotkeys } from "../hooks.ts"

const useIsoLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect

function useControllable<T>(value: T | undefined, initial: T, onChange?: (next: T) => void): [T, (next: T) => void] {
    const [inner, setInner] = useState(initial)
    const controlled = value !== undefined
    const set = useCallback(
        (next: T) => {
            if (!controlled) {
                setInner(next)
            }
            onChange?.(next)
        },
        [controlled, onChange],
    )
    return [controlled ? value : inner, set]
}

/** A Tabs / Segmented choice. */
export interface ChoiceItem<T extends string | number = string> {
    value: T
    label?: ReactNode
    icon?: string
    badge?: ReactNode
    disabled?: boolean
    title?: string
    /** more attributes for this item's button, e.g. data-* */
    props?: ButtonHTMLAttributes<HTMLButtonElement> & {
        [data: `data-${string}`]: string | number | boolean | undefined
    }
}
/**
 * A choice as given: a string (value and label), a [value, label] pair, or a ChoiceItem. A pair built by `.map()` types
 * as an array rather than a tuple, so any array is taken (its first item is the value).
 */
export type ChoiceInput<T extends string | number> =
    | (T & string)
    | readonly [T, ReactNode?]
    | readonly NoInfer<T | ReactNode>[]
    | ChoiceItem<T>

/** [[value, label]] or [{ value, label, … }] → [{ value, label, … }] */
const normalizeItems = <T extends string | number>(items: readonly ChoiceInput<T>[] = []): ChoiceItem<T>[] =>
    items.map((item): ChoiceItem<T> =>
        Array.isArray(item)
            ? { value: item[0], label: item[1] }
            : typeof item === "string"
            ? { value: item, label: item }
            // Array.isArray doesn't narrow readonly arrays away, so name what's left
            : (item as ChoiceItem<T>)
    )

/** Renders into document.body (nothing during server rendering). */
function Portal({ children }: { children?: ReactNode }) {
    const [mounted, setMounted] = useState(false)
    useEffect(() => setMounted(true), [])
    return mounted && typeof document !== "undefined" ? createPortal(children, document.body) : null
}

// ── Tabs / Segmented ──

export interface TabsProps<T extends string | number = string> extends
    Omit<
        HTMLAttributes<HTMLDivElement>,
        "onChange"
    > {
    items: readonly ChoiceInput<T>[]
    /** null: none selected (e.g. tabs that open a panel, all closed) */
    value: T | null
    onChange?: (value: T) => void
    variant?: "line" | "pill"
    size?: "sm" | "md"
    /** stacks them (↑/↓ move) */
    vertical?: boolean
    /** the tab list's accessible name */
    label?: string
}

function choiceGroup<T extends string | number>(
    baseClass: string,
    { items, value, onChange, variant, size, vertical = false, className, label, ...rest }: TabsProps<T>,
) {
    const list = normalizeItems(items)
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        const index = list.findIndex((item) => item.value === value)
        const [next, back] = vertical ? ["ArrowDown", "ArrowUp"] : ["ArrowRight", "ArrowLeft"]
        const delta = event.key === next ? 1 : event.key === back ? -1 : 0
        if (!delta) {
            return
        }
        event.preventDefault()
        for (let step = 1; step <= list.length; step++) {
            const next = list[(index + delta * step + list.length * step) % list.length]
            if (!next.disabled) {
                onChange?.(next.value)
                const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(String(next.value)) : String(next.value)
                event.currentTarget.querySelector<HTMLElement>(`[data-value="${escaped}"]`)?.focus()
                break
            }
        }
    }
    return (
        <div
            className={cx(
                baseClass,
                variant && `${baseClass}--${variant}`,
                size === "sm" && `${baseClass}--sm`,
                vertical && `${baseClass}--vertical`,
                className,
            )}
            role="tablist"
            aria-label={label}
            aria-orientation={vertical ? "vertical" : undefined}
            onKeyDown={onKeyDown}
            {...rest}
        >
            {list.map((item) => {
                const active = item.value === value
                // with none selected, the first enabled item is the one Tab reaches
                const focusable = active ||
                    (!list.some((other) => other.value === value) && item === list.find((other) => !other.disabled))
                return (
                    <button
                        key={item.value}
                        type="button"
                        role="tab"
                        data-value={item.value}
                        aria-selected={active}
                        tabIndex={focusable ? 0 : -1}
                        disabled={item.disabled}
                        title={item.title}
                        className={cx(`${baseClass}__item`, active && `${baseClass}__item--active`)}
                        onClick={() => onChange?.(item.value)}
                        {...item.props}
                    >
                        {item.icon ? <Icon name={item.icon} size={15} /> : null}
                        {item.label !== undefined ? <span>{item.label}</span> : null}
                        {item.badge !== undefined && item.badge !== null
                            ? <span className={`${baseClass}__badge`}>{item.badge}</span>
                            : null}
                    </button>
                )
            })}
        </div>
    )
}

/**
 * Tabs: `items` as [{ value, label, icon, badge, disabled, title, props }] or [[value, label]] (`props`: more
 * attributes for that item's button, e.g. data-*). `vertical` stacks them (↑/↓ move).
 */
export function Tabs<T extends string | number = string>({ variant = "line", ...props }: TabsProps<T>) {
    return choiceGroup("dr-tabs", { variant, ...props })
}

/** A compact segmented control (same API as Tabs). */
export function Segmented<T extends string | number = string>(props: TabsProps<T>) {
    return choiceGroup("dr-segmented", props)
}

// ── Popover ──

type Side = "top" | "bottom" | "left" | "right"
/** A side of the anchor, optionally aligned to its start or end (default: centered). */
export type Placement = Side | `${Side}-${"start" | "center" | "end"}`

/** The anchor's box (a DOMRect, or a point as a zero-size rect). */
export type AnchorRect = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">

/** Where to put a `floating` box of size (w, h) next to an anchor rect, kept on screen. */
export function placeFloating(
    anchor: AnchorRect,
    size: { width: number; height: number },
    placement: Placement = "bottom-start",
    gap = 6,
): { x: number; y: number; side: string } {
    const [side, align = "center"] = placement.split("-")
    let x: number
    let y: number
    const vw = globalThis.innerWidth ?? 1024
    const vh = globalThis.innerHeight ?? 768
    const along = (start: number, length: number, own: number) =>
        align === "start" ? start : align === "end" ? start + length - own : start + (length - own) / 2
    let actualSide = side
    if (side === "bottom" && anchor.bottom + gap + size.height > vh && anchor.top - gap - size.height > 0) {
        actualSide = "top"
    } else if (side === "top" && anchor.top - gap - size.height < 0) {
        actualSide = "bottom"
    } else if (side === "right" && anchor.right + gap + size.width > vw) {
        actualSide = "left"
    } else if (side === "left" && anchor.left - gap - size.width < 0) {
        actualSide = "right"
    }
    if (actualSide === "bottom" || actualSide === "top") {
        x = along(anchor.left, anchor.width, size.width)
        y = actualSide === "bottom" ? anchor.bottom + gap : anchor.top - gap - size.height
    } else {
        y = along(anchor.top, anchor.height, size.height)
        x = actualSide === "right" ? anchor.right + gap : anchor.left - gap - size.width
    }
    return {
        x: Math.max(4, Math.min(x, vw - size.width - 4)),
        y: Math.max(4, Math.min(y, vh - size.height - 4)),
        side: actualSide,
    }
}

interface FloatingProps extends HTMLAttributes<HTMLDivElement> {
    anchor?: HTMLElement | null
    point?: { x: number; y: number }
    placement?: Placement
    onClose?: () => void
}

/** A floating box positioned at an anchor element or a point, in a portal; closes on outside click / Escape. */
function Floating({
    anchor,
    point,
    placement,
    onClose,
    className,
    children,
    role = "dialog",
    style,
    ...rest
}: FloatingProps) {
    const box = useRef<HTMLDivElement | null>(null)
    const [position, setPosition] = useState({ x: -9999, y: -9999 })
    const place = useRef(() => {})
    place.current = () => {
        const element = box.current
        if (!element) {
            return
        }
        const size = { width: element.offsetWidth, height: element.offsetHeight }
        const rect = point
            ? { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 }
            : anchor?.getBoundingClientRect()
        if (rect) {
            setPosition(placeFloating(rect, size, point ? "bottom-start" : placement, point ? 2 : 6))
        }
    }
    // the box mounts a render later (Portal), so it places itself once it exists
    const setBox = useCallback((element: HTMLDivElement | null) => {
        box.current = element
        if (element) {
            place.current()
        }
    }, [])
    useIsoLayoutEffect(() => {
        const update = () => place.current()
        update()
        addEventListener("resize", update)
        addEventListener("scroll", update, true)
        return () => {
            removeEventListener("resize", update)
            removeEventListener("scroll", update, true)
        }
    }, [anchor, point?.x, point?.y, placement])
    useEffect(() => {
        const onDown = (event: PointerEvent) => {
            const target = event.target instanceof Node ? event.target : null
            if (box.current?.contains(target) || anchor?.contains?.(target)) {
                return
            }
            onClose?.()
        }
        const timer = setTimeout(() => document.addEventListener("pointerdown", onDown, true))
        return () => {
            clearTimeout(timer)
            document.removeEventListener("pointerdown", onDown, true)
        }
    }, [anchor, onClose])
    useEscape(() => onClose?.(), true)
    return (
        <Portal>
            <div
                ref={setBox}
                role={role}
                className={cx("dr-floating", className)}
                style={{ left: position.x, top: position.y, ...style }}
                {...rest}
            >
                {children}
            </div>
        </Portal>
    )
}

/** What a Popover / Menu gives its trigger (spread them onto the element that opens it). */
export interface TriggerProps {
    ref: (element: HTMLElement | null) => void
    onClick: () => void
    "aria-expanded": boolean
    "aria-haspopup": "dialog" | "menu"
    onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void
}

/** An element (gets onClick + ref), `(props) => element`, or other content (wrapped in a span / button). */
export type Trigger = ReactNode | ((props: TriggerProps & { open: boolean }) => ReactNode)

export interface PopoverProps {
    /** an element (gets onClick + ref) or `(props) => element` */
    trigger: Trigger
    /** content, or `({ close }) => content` */
    children: ReactNode | ((api: { close: () => void }) => ReactNode)
    open?: boolean
    onOpenChange?: (open: boolean) => void
    defaultOpen?: boolean
    placement?: Placement
    className?: string
    style?: CSSProperties
}

/** A popover anchored to its trigger. `trigger`: an element (gets onClick + ref) or `(props) => element`. */
export function Popover({
    trigger,
    children,
    open,
    onOpenChange,
    defaultOpen = false,
    placement = "bottom-start",
    className,
    style,
}: PopoverProps) {
    const [isOpen, setOpen] = useControllable(open, defaultOpen, onOpenChange)
    const [anchor, setAnchor] = useState<HTMLElement | null>(null)
    const triggerProps: TriggerProps = {
        ref: setAnchor,
        onClick: () => setOpen(!isOpen),
        "aria-expanded": isOpen,
        "aria-haspopup": "dialog",
    }
    const triggerElement = typeof trigger === "function"
        ? (
            trigger({ ...triggerProps, open: isOpen })
        )
        : isValidElement<Partial<TriggerProps>>(trigger)
        ? (
            cloneElement(trigger, triggerProps)
        )
        : <span {...triggerProps}>{trigger}</span>
    return (
        <span className="dr-popover-anchor">
            {triggerElement}
            {isOpen && anchor
                ? (
                    <Floating
                        anchor={anchor}
                        placement={placement}
                        onClose={() => setOpen(false)}
                        className={cx("dr-popover", className)}
                        style={style}
                    >
                        {typeof children === "function" ? children({ close: () => setOpen(false) }) : children}
                    </Floating>
                )
                : null}
        </span>
    )
}

// ── Menu ──

/** A menu entry that does something. Its `data-*` / `aria-*` keys (and `id`) go on its button. */
export interface MenuAction {
    label: ReactNode
    icon?: string
    onSelect?: () => void
    danger?: boolean
    disabled?: boolean
    /** makes it a checkbox item (a check when true) */
    checked?: boolean
    shortcut?: ReactNode
    title?: string
    /** stays open after a pick */
    keepOpen?: boolean
    key?: Key
    id?: string
    separator?: false
    heading?: undefined
    [dataOrAria: `data-${string}` | `aria-${string}`]: string | number | boolean | undefined
}
/** A line between groups of items ("-" does the same). */
export interface MenuSeparator {
    separator: true
    heading?: undefined
}
/** A group's title (not clickable). */
export interface MenuHeading {
    heading: ReactNode
    separator?: false
}
export type MenuItem = MenuAction | MenuSeparator | MenuHeading | "-"

/** A heading (one with no heading text renders as an action, as it always has). */
const isHeading = (item: MenuAction | MenuHeading): item is MenuHeading => !!item.heading

/** A menu item's own DOM attributes: its `data-*` (a test id) and `aria-*` keys, and `id`. */
function domProps(item: MenuAction): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(item).filter(([key]) => key === "id" || key.startsWith("data-") || key.startsWith("aria-")),
    )
}

export interface MenuListProps {
    items: readonly MenuItem[]
    onClose?: () => void
    autoFocus?: boolean
}

/**
 * A menu's items in place (inside a Popover, a panel): what Menu and MenuAt show. `items` as for Menu; `onClose` after
 * a pick (unless the item `keepOpen`s).
 */
export function MenuList({ items, onClose, autoFocus = true }: MenuListProps) {
    const list = useRef<HTMLDivElement>(null)
    const focusable = () => [...(list.current?.querySelectorAll<HTMLElement>(".dr-menu__item:not([disabled])") ?? [])]
    useEffect(() => {
        if (autoFocus) {
            focusable()[0]?.focus()
        }
    }, [])
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        const elements = focusable()
        const index = elements.findIndex((element) => element === document.activeElement)
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            const delta = event.key === "ArrowDown" ? 1 : -1
            elements[(index + delta + elements.length) % elements.length]?.focus()
        } else if (event.key === "Home") {
            elements[0]?.focus()
        } else if (event.key === "End") {
            elements.at(-1)?.focus()
        } else if (event.key === "Tab") {
            onClose?.()
        }
    }
    return (
        <div className="dr-menu" role="menu" ref={list} onKeyDown={onKeyDown}>
            {items.map((item, index) => {
                if (item === "-" || item?.separator) {
                    return <div key={index} className="dr-menu__sep" role="separator" />
                }
                if (isHeading(item)) {
                    return (
                        <div key={index} className="dr-menu__heading">
                            {item.heading}
                        </div>
                    )
                }
                return (
                    <button
                        key={item.key ?? index}
                        type="button"
                        role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
                        aria-checked={item.checked}
                        disabled={item.disabled}
                        title={item.title}
                        className={cx("dr-menu__item", item.danger && "dr-menu__item--danger")}
                        {...domProps(item)}
                        onClick={() => {
                            item.onSelect?.()
                            if (!item.keepOpen) {
                                onClose?.()
                            }
                        }}
                    >
                        <span className="dr-menu__icon">
                            {item.checked !== undefined
                                ? (
                                    item.checked ? <Icon name="check" size={14} /> : null
                                )
                                : item.icon
                                ? <Icon name={item.icon} size={14} />
                                : null}
                        </span>
                        <span className="dr-menu__label">{item.label}</span>
                        {item.shortcut ? <span className="dr-menu__shortcut">{item.shortcut}</span> : null}
                    </button>
                )
            })}
        </div>
    )
}

export interface MenuProps {
    items: readonly MenuItem[]
    /** an element (gets onClick + ref), `(props) => element`, or a button's content (default: a ⋯ icon) */
    trigger?: Trigger
    placement?: Placement
    open?: boolean
    onOpenChange?: (open: boolean) => void
    className?: string
}

/** A dropdown menu. An item's `data-*` / `aria-*` keys (and `id`) go on its button, like other components' DOM props. */
export function Menu({ items, trigger, placement = "bottom-start", open, onOpenChange, className }: MenuProps) {
    const [isOpen, setOpen] = useControllable(open, false, onOpenChange)
    const [anchor, setAnchor] = useState<HTMLElement | null>(null)
    const triggerProps: TriggerProps = {
        ref: setAnchor,
        onClick: () => setOpen(!isOpen),
        "aria-expanded": isOpen,
        "aria-haspopup": "menu",
        onKeyDown: (event) => {
            if (event.key === "ArrowDown" && !isOpen) {
                event.preventDefault()
                setOpen(true)
            }
        },
    }
    const triggerElement = typeof trigger === "function"
        ? (
            trigger({ ...triggerProps, open: isOpen })
        )
        : isValidElement<Partial<TriggerProps>>(trigger)
        ? (
            cloneElement(trigger, triggerProps)
        )
        : (
            <button type="button" className="dr-menu-trigger" {...triggerProps}>
                {trigger ?? <Icon name="more-horizontal" />}
            </button>
        )
    const close = () => {
        setOpen(false)
        anchor?.focus?.()
    }
    return (
        <span className="dr-popover-anchor">
            {triggerElement}
            {isOpen && anchor
                ? (
                    <Floating
                        anchor={anchor}
                        placement={placement}
                        onClose={close}
                        role="presentation"
                        className={className}
                    >
                        <MenuList items={items} onClose={close} />
                    </Floating>
                )
                : null}
        </span>
    )
}

export interface ContextMenuProps extends HTMLAttributes<HTMLDivElement> {
    /** the items, or `(event) => items` for where it was opened (none: no menu) */
    items: readonly MenuItem[] | ((event: ReactMouseEvent<HTMLDivElement>) => readonly MenuItem[] | null | undefined)
    disabled?: boolean
}

/** Right-click (or long-press on touch) opens a menu at the pointer. */
export function ContextMenu({ items, children, disabled, className, ...rest }: ContextMenuProps) {
    const [menu, setMenu] = useState<{ x: number; y: number; items: readonly MenuItem[] } | null>(null)
    const press = useRef<ReturnType<typeof setTimeout>>(undefined)
    const openAt = (event: ReactMouseEvent<HTMLDivElement>, x: number, y: number) => {
        const list = typeof items === "function" ? items(event) : items
        if (list?.length) {
            setMenu({ x, y, items: list })
        }
    }
    return (
        <div
            className={cx("dr-context-menu", className)}
            onContextMenu={disabled ? undefined : (event) => {
                event.preventDefault()
                openAt(event, event.clientX, event.clientY)
            }}
            onPointerDown={disabled ? undefined : (event) => {
                if (event.pointerType !== "touch") {
                    return
                }
                const { clientX, clientY } = event
                press.current = setTimeout(() => openAt(event, clientX, clientY), 550)
            }}
            onPointerUp={() => clearTimeout(press.current)}
            onPointerMove={() => clearTimeout(press.current)}
            onPointerCancel={() => clearTimeout(press.current)}
            {...rest}
        >
            {children}
            {menu
                ? (
                    <Floating point={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} role="presentation">
                        <MenuList items={menu.items} onClose={() => setMenu(null)} />
                    </Floating>
                )
                : null}
        </div>
    )
}

export interface MenuAtProps extends HTMLAttributes<HTMLDivElement> {
    x: number
    y: number
    items?: readonly MenuItem[]
    onClose: () => void
}

/**
 * A menu open at a screen point, for triggers ContextMenu can't tell apart (a 3D view's right click that isn't a
 * right-drag pan, say). `children` go above the items (a heading line, or an inline form instead of `items`).
 */
export function MenuAt({ x, y, items = [], onClose, children, className, ...rest }: MenuAtProps) {
    return (
        <Floating point={{ x, y }} onClose={onClose} role="presentation" className={className} {...rest}>
            {children}
            {items.length ? <MenuList items={items} onClose={onClose} autoFocus={!children} /> : null}
        </Floating>
    )
}

// ── Tooltip ──

export interface TooltipProps {
    content: ReactNode
    /** an element (gets the hover / focus handlers and a ref), or content to wrap in a span */
    children: ReactNode
    /** ms */
    delay?: number
    placement?: Placement
    disabled?: boolean
}

/** A hover / focus tooltip. */
export function Tooltip({ content, children, delay = 350, placement = "top", disabled }: TooltipProps) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null)
    const [open, setOpen] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
    useEffect(() => () => clearTimeout(timer.current), [])
    const show = () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setOpen(true), delay)
    }
    const hide = () => {
        clearTimeout(timer.current)
        setOpen(false)
    }
    const handlers = { onPointerEnter: show, onPointerLeave: hide, onFocus: show, onBlur: hide }
    const child = isValidElement<typeof handlers & { ref?: (element: HTMLElement | null) => void }>(children)
        ? (
            cloneElement(children, { ref: setAnchor, ...handlers })
        )
        : (
            <span ref={setAnchor} {...handlers}>
                {children}
            </span>
        )
    return (
        <span className="dr-popover-anchor">
            {child}
            {open && anchor && !disabled && content
                ? (
                    <TooltipBox anchor={anchor} placement={placement}>
                        {content}
                    </TooltipBox>
                )
                : null}
        </span>
    )
}

function TooltipBox({
    anchor,
    placement,
    children,
}: {
    anchor: HTMLElement
    placement: Placement
    children: ReactNode
}) {
    const [position, setPosition] = useState({ x: -9999, y: -9999 })
    // the box mounts a render later (Portal), so it places itself once it exists
    const place = useCallback(
        (box: HTMLDivElement | null) => {
            if (box) {
                const size = { width: box.offsetWidth, height: box.offsetHeight }
                setPosition(placeFloating(anchor.getBoundingClientRect(), size, placement, 6))
            }
        },
        [anchor, placement],
    )
    return (
        <Portal>
            <div ref={place} role="tooltip" className="dr-tooltip" style={{ left: position.x, top: position.y }}>
                {children}
            </div>
        </Portal>
    )
}

// ── Sidebar / NavRail ──

export interface SidebarSection {
    title?: ReactNode
    content: ReactNode
    key?: Key
}

export interface SidebarProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
    title?: ReactNode
    sections?: SidebarSection[]
    collapsed?: boolean
    onCollapsedChange?: (collapsed: boolean) => void
    side?: "left" | "right"
    width?: number | string
    footer?: ReactNode
}

/** A collapsible side panel with titled sections. */
export function Sidebar({
    title,
    sections,
    children,
    collapsed,
    onCollapsedChange,
    side = "left",
    width = 260,
    footer,
    className,
    style,
    ...rest
}: SidebarProps) {
    const [isCollapsed, setCollapsed] = useControllable(collapsed, false, onCollapsedChange)
    return (
        <aside
            className={cx("dr-sidebar", `dr-sidebar--${side}`, isCollapsed && "dr-sidebar--collapsed", className)}
            style={{ width: isCollapsed ? undefined : width, ...style }}
            {...rest}
        >
            <div className="dr-sidebar__head">
                {!isCollapsed && title ? <div className="dr-sidebar__title dr-h3">{title}</div> : null}
                <button
                    type="button"
                    className="dr-sidebar__toggle"
                    onClick={() => setCollapsed(!isCollapsed)}
                    aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                    aria-expanded={!isCollapsed}
                >
                    <Icon name={(side === "left") === isCollapsed ? "chevron-right" : "chevron-left"} size={14} />
                </button>
            </div>
            {isCollapsed ? null : (
                <div className="dr-sidebar__body dr-scroll">
                    {sections?.map((section, index) => (
                        <section key={section.key ?? index} className="dr-sidebar__section">
                            {section.title
                                ? <div className="dr-sidebar__section-title dr-label">{section.title}</div>
                                : null}
                            {section.content}
                        </section>
                    ))}
                    {children}
                </div>
            )}
            {!isCollapsed && footer ? <div className="dr-sidebar__foot">{footer}</div> : null}
        </aside>
    )
}

export interface NavRailItem<T extends Key = string> {
    value: T
    icon: string
    label: string
    badge?: ReactNode
    disabled?: boolean
}

export interface NavRailProps<T extends Key = string> extends Omit<HTMLAttributes<HTMLElement>, "onChange"> {
    items: NavRailItem<T>[]
    value: T
    onChange?: (value: T) => void
    showLabels?: boolean
    footer?: ReactNode
}

/** A vertical icon rail (Desktop's left rail, the Controller's panel switcher). */
export function NavRail<T extends Key = string>({
    items = [],
    value,
    onChange,
    showLabels = false,
    footer,
    className,
    ...rest
}: NavRailProps<T>) {
    return (
        <nav className={cx("dr-navrail", showLabels && "dr-navrail--labels", className)} {...rest}>
            <div className="dr-navrail__items">
                {items.map((item) => {
                    const active = item.value === value
                    return (
                        <button
                            key={item.value}
                            type="button"
                            title={item.label}
                            aria-label={item.label}
                            aria-current={active ? "page" : undefined}
                            disabled={item.disabled}
                            className={cx("dr-navrail__item", active && "dr-navrail__item--active")}
                            onClick={() => onChange?.(item.value)}
                        >
                            <Icon name={item.icon} size={20} />
                            {showLabels ? <span className="dr-navrail__label">{item.label}</span> : null}
                            {item.badge !== undefined && item.badge !== null
                                ? <span className="dr-navrail__badge">{item.badge}</span>
                                : null}
                        </button>
                    )
                })}
            </div>
            {footer ? <div className="dr-navrail__foot">{footer}</div> : null}
        </nav>
    )
}

// ── Stepper ──

export type StepState = "done" | "current" | "todo" | "failed"

export interface Step {
    label: ReactNode
    description?: ReactNode
    /** wins over `current` (a process that reports each step, one of which may have failed) */
    state?: StepState
    key?: Key
}

export interface StepperProps extends HTMLAttributes<HTMLOListElement> {
    steps: Step[]
    /** the current step's index */
    current?: number
    /** lets the user go back to a finished step */
    onStep?: (index: number) => void
    vertical?: boolean
}

/**
 * Wizard steps, or a process's progress (a launch, an install). `onStep`: lets the user go back to a finished step. A
 * step's own `state` wins over `current` (a process that reports each step, one of which may have failed).
 */
export function Stepper({ steps = [], current = 0, onStep, vertical = false, className, ...rest }: StepperProps) {
    return (
        <ol className={cx("dr-stepper", vertical && "dr-stepper--vertical", className)} {...rest}>
            {steps.map((step, index) => {
                const state = step.state ?? (index < current ? "done" : index === current ? "current" : "todo")
                const clickable = onStep && index < current
                const Mark = clickable ? "button" : "span"
                return (
                    <li
                        key={step.key ?? index}
                        className={cx("dr-stepper__step", `dr-stepper__step--${state}`)}
                        data-state={state}
                        aria-current={state === "current" ? "step" : undefined}
                    >
                        {
                            <Mark
                                className="dr-stepper__mark"
                                type={clickable ? "button" : undefined}
                                onClick={clickable ? () => onStep?.(index) : undefined}
                            >
                                {state === "done" ? <Icon name="check" size={12} /> : state === "failed"
                                    ? (
                                        "!"
                                    )
                                    : (
                                        index + 1
                                    )}
                            </Mark>
                        }
                        <span className="dr-stepper__text">
                            <span className="dr-stepper__label">{step.label}</span>
                            {step.description ? <span className="dr-stepper__desc">{step.description}</span> : null}
                        </span>
                    </li>
                )
            })}
        </ol>
    )
}

// ── Breadcrumbs ──

export interface Crumb {
    label: ReactNode
    onClick?: () => void
    href?: string
}

export interface BreadcrumbsProps extends HTMLAttributes<HTMLElement> {
    /** the last one is the current page */
    items: Crumb[]
}

/** Where you are: links back up a path, then the current page. */
export function Breadcrumbs({ items = [], className, ...rest }: BreadcrumbsProps) {
    return (
        <nav className={cx("dr-breadcrumbs", className)} aria-label="Breadcrumb" {...rest}>
            {items.map((item, index) => {
                const last = index === items.length - 1
                const label = last
                    ? (
                        <span className="dr-breadcrumbs__current" aria-current="page">
                            {item.label}
                        </span>
                    )
                    : item.href || item.onClick
                    ? (
                        <a
                            className="dr-breadcrumbs__link"
                            href={item.href ?? "#"}
                            onClick={item.onClick
                                ? (event) => {
                                    event.preventDefault()
                                    item.onClick?.()
                                }
                                : undefined}
                        >
                            {item.label}
                        </a>
                    )
                    : <span>{item.label}</span>
                return (
                    <span key={index} className="dr-breadcrumbs__item">
                        {label}
                        {last ? null : <Icon name="chevron-right" size={12} className="dr-breadcrumbs__sep" />}
                    </span>
                )
            })}
        </nav>
    )
}

// ── CommandPalette ──

/** Fuzzy score of `query` in `text` (higher = better; -1 = no match). */
export function fuzzyScore(query: string, text: unknown): number {
    const needle = query.toLowerCase().trim()
    const hay = String(text).toLowerCase()
    if (!needle) {
        return 0
    }
    const direct = hay.indexOf(needle)
    if (direct >= 0) {
        return 1000 - direct
    }
    let score = 0
    let at = 0
    let streak = 0
    for (const char of needle) {
        const found = hay.indexOf(char, at)
        if (found < 0) {
            return -1
        }
        streak = found === at ? streak + 1 : 0
        score += 1 + streak * 2 - Math.min(found - at, 5) * 0.2
        at = found + 1
    }
    return score
}

export interface Command {
    id: string
    label: string
    group?: string
    shortcut?: string
    icon?: string
    /** more words to match */
    keywords?: string
    run: () => void
}

export interface CommandPaletteProps {
    open: boolean
    onClose: () => void
    commands: Command[]
    placeholder?: string
}

/** ⌘K-style command list. */
export function CommandPalette({ open, onClose, commands = [], placeholder = "Type a command…" }: CommandPaletteProps) {
    const [query, setQuery] = useState("")
    const [active, setActive] = useState(0)
    const input = useRef<HTMLInputElement>(null)
    useEffect(() => {
        if (open) {
            setQuery("")
            setActive(0)
            setTimeout(() => input.current?.focus())
        }
    }, [open])
    useEscape(() => onClose?.(), !!open)
    const matches = useMemo(
        () =>
            commands
                .map((command) => ({
                    command,
                    score: fuzzyScore(query, `${command.label} ${command.group ?? ""} ${command.keywords ?? ""}`),
                }))
                .filter((item) => item.score >= 0)
                .sort((a, b) => (query ? b.score - a.score : 0))
                .map((item) => item.command),
        [commands, query],
    )
    if (!open) {
        return null
    }
    const run = (command: Command | undefined) => {
        onClose?.()
        command?.run?.()
    }
    const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown") {
            event.preventDefault()
            setActive((index) => Math.min(matches.length - 1, index + 1))
        } else if (event.key === "ArrowUp") {
            event.preventDefault()
            setActive((index) => Math.max(0, index - 1))
        } else if (event.key === "Enter") {
            event.preventDefault()
            run(matches[active])
        }
    }
    let lastGroup: string | null | undefined = null
    return (
        <Portal>
            <div
                className="dr-palette-scrim"
                onPointerDown={(event) => event.target === event.currentTarget && onClose?.()}
            >
                <div className="dr-palette" role="dialog" aria-label="Command palette">
                    <div className="dr-palette__search">
                        <Icon name="search" size={16} />
                        <input
                            ref={input}
                            className="dr-palette__input"
                            value={query}
                            placeholder={placeholder}
                            onChange={(event) => {
                                setQuery(event.target.value)
                                setActive(0)
                            }}
                            onKeyDown={onKeyDown}
                            aria-activedescendant={matches[active] ? `dr-cmd-${matches[active].id}` : undefined}
                        />
                    </div>
                    <div className="dr-palette__list dr-scroll" role="listbox">
                        {matches.length === 0 ? <div className="dr-palette__empty">No matching commands</div> : null}
                        {matches.map((command, index) => {
                            const heading = !query && command.group && command.group !== lastGroup
                                ? (
                                    <div key={`g-${command.group}`} className="dr-palette__group">
                                        {command.group}
                                    </div>
                                )
                                : null
                            lastGroup = command.group
                            return [
                                heading,
                                <div
                                    key={command.id}
                                    id={`dr-cmd-${command.id}`}
                                    role="option"
                                    aria-selected={index === active}
                                    className={cx("dr-palette__item", index === active && "dr-palette__item--active")}
                                    onPointerMove={() => setActive(index)}
                                    onClick={() => run(command)}
                                >
                                    {command.icon
                                        ? <Icon name={command.icon} size={15} />
                                        : <span className="dr-palette__noicon" />}
                                    <span className="dr-palette__label">{command.label}</span>
                                    {command.shortcut
                                        ? <span className="dr-palette__shortcut">{command.shortcut}</span>
                                        : null}
                                </div>,
                            ]
                        })}
                    </div>
                </div>
            </div>
        </Portal>
    )
}

/**
 * `const palette = useCommandPalette()` → `{ open, setOpen, toggle }`, opened with mod+k (⌘K / Ctrl+K).
 * Render `<CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} commands={commands} />`.
 */
export function useCommandPalette(hotkey = "mod+k") {
    const [open, setOpen] = useState(false)
    useHotkeys({ [hotkey]: () => setOpen((value) => !value) })
    return { open, setOpen, toggle: () => setOpen((value) => !value) }
}
