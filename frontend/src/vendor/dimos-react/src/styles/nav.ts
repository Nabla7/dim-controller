// Tabs, segmented controls, menus, popovers, tooltips, sidebar, nav rail, stepper, breadcrumbs, command palette.
// Tokens only.
export const NAV_CSS = /* css */ `
/* tabs */
.dr-tabs {
    display: flex;
    align-items: stretch;
    gap: 2px;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
}
.dr-tabs__item {
    appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    margin-bottom: -1px;
    font: 500 13px/1.2 var(--sans);
    letter-spacing: var(--chip-track, 0.01em);
    color: var(--muted-fg);
    background: none;
    border: 0;
    border-bottom: var(--tab-rule, 2px) solid transparent;
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
:root[data-dr-dark] .dr-tabs__item {
    font: 400 12px/1.2 var(--sans);
    letter-spacing: 0.04em;
}
.dr-tabs__item:hover { color: var(--fg); }
.dr-tabs__item:focus-visible { outline: none; box-shadow: var(--dr-focus); }
.dr-tabs__item:disabled { opacity: 0.45; cursor: not-allowed; }
.dr-tabs__item--active {
    color: var(--tab-active-fg, var(--primary));
    border-bottom-color: var(--primary);
}
:root[data-dr-dark] .dr-tabs__item--active { text-shadow: var(--head-shadow, none); }
.dr-tabs--sm .dr-tabs__item { padding: 5px 9px; font-size: 12px; }
.dr-tabs--pill {
    border-bottom: 0;
    gap: 4px;
}
.dr-tabs--pill .dr-tabs__item {
    margin: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-pill);
    padding: 6px 12px;
}
.dr-tabs--pill .dr-tabs__item:hover { background: var(--hover); }
.dr-tabs--pill .dr-tabs__item--active {
    background: var(--sel);
    border-color: var(--primary);
}
.dr-tabs__badge,
.dr-segmented__badge,
.dr-navrail__badge {
    font: 500 10px/1.5 var(--mono);
    padding: 0 6px;
    border-radius: var(--radius-pill);
    background: var(--badge-bg, var(--primary));
    color: var(--badge-fg, var(--primary-fg));
    box-shadow: inset 0 0 0 1px var(--badge-border, transparent);
}

/* segmented */
.dr-segmented {
    display: inline-flex;
    align-items: stretch;
    padding: 2px;
    gap: 2px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}
.dr-segmented__item {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 5px 11px;
    font: 500 12.5px/1.2 var(--sans);
    color: var(--muted-fg);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
}
.dr-segmented__item:hover { color: var(--fg); background: var(--hover); }
.dr-segmented__item:focus-visible { outline: none; box-shadow: var(--dr-focus); }
.dr-segmented__item:disabled { opacity: 0.45; cursor: not-allowed; }
.dr-segmented__item--active,
.dr-segmented__item--active:hover {
    color: var(--fg);
    background: var(--card);
    border-color: var(--border);
    box-shadow: var(--shadow-xs, none);
}
:root[data-dr-dark] .dr-segmented__item--active,
:root[data-dr-dark] .dr-segmented__item--active:hover {
    color: var(--primary);
    background: var(--sel);
    border-color: var(--primary);
}
.dr-segmented--sm .dr-segmented__item { padding: 3px 8px; font-size: 11.5px; }
.dr-segmented--vertical, .dr-tabs--vertical { flex-direction: column; align-items: stretch; }
.dr-segmented--vertical .dr-segmented__item { justify-content: space-between; }

/* floating layers (menus, popovers) */
.dr-popover-anchor { display: inline-flex; position: relative; }
.dr-floating {
    position: fixed;
    z-index: 1000;
    animation: dr-fade-in 0.12s ease;
}
.dr-popover {
    min-width: 180px;
    max-width: min(420px, calc(100vw - 16px));
    padding: 12px;
    color: var(--fg);
    background: var(--raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    backdrop-filter: var(--blur);
}
.dr-menu-trigger {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 5px;
    color: var(--muted-fg);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    cursor: pointer;
}
.dr-menu-trigger:hover,
.dr-menu-trigger[aria-expanded="true"] { color: var(--fg); background: var(--hover); border-color: var(--border); }
.dr-menu {
    min-width: 190px;
    max-height: min(70vh, 480px);
    overflow-y: auto;
    padding: 4px;
    background: var(--raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    backdrop-filter: var(--blur);
}
.dr-menu__item {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px 6px 6px;
    font: 13px/1.3 var(--sans);
    color: var(--fg);
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    outline: none;
}
.dr-menu__item:hover,
.dr-menu__item:focus-visible { background: var(--hover); }
.dr-menu__item:focus-visible { box-shadow: inset 0 0 0 1px var(--ring); }
.dr-menu__item:disabled { opacity: 0.45; cursor: not-allowed; background: none; }
.dr-menu__item--danger { color: var(--danger); }
.dr-menu__icon {
    width: 16px;
    display: inline-flex;
    justify-content: center;
    color: var(--muted-fg);
    flex: none;
}
.dr-menu__item[aria-checked="true"] .dr-menu__icon { color: var(--primary); }
.dr-menu__item--danger .dr-menu__icon { color: var(--danger); }
.dr-menu__label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-menu__shortcut { font: 11px var(--mono); color: var(--muted-fg); margin-left: 16px; }
.dr-menu__sep { height: 1px; margin: 4px 6px; background: var(--hair); }
.dr-menu__heading {
    padding: 6px 10px 3px;
    font: 500 10px/1.4 var(--mono);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
    color: var(--muted-fg);
}
.dr-context-menu { display: contents; }

/* tooltip */
.dr-tooltip {
    position: fixed;
    z-index: 1100;
    max-width: 280px;
    padding: 5px 9px;
    font: 12px/1.4 var(--sans);
    color: var(--fg);
    background: var(--raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-lg);
    pointer-events: none;
    animation: dr-fade-in 0.1s ease;
}

/* sidebar */
.dr-sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: var(--surface);
    color: var(--fg);
    border-right: 1px solid var(--border);
    transition: width 0.18s ease;
}
.dr-sidebar--right { border-right: 0; border-left: 1px solid var(--border); }
.dr-sidebar--collapsed { width: 40px; }
.dr-sidebar__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 8px 8px 8px 14px;
    border-bottom: 1px solid var(--hair);
    min-height: 40px;
}
.dr-sidebar--collapsed .dr-sidebar__head { padding: 8px 4px; justify-content: center; border-bottom: 0; }
.dr-sidebar__toggle {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    color: var(--muted-fg);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
}
.dr-sidebar__toggle:hover { color: var(--fg); background: var(--hover); border-color: var(--border); }
.dr-sidebar__body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 6px 8px 12px;
}
.dr-sidebar__section { padding: 8px 0; }
.dr-sidebar__section + .dr-sidebar__section { border-top: 1px solid var(--hair); }
.dr-sidebar__section-title { padding: 0 6px 6px; }
.dr-sidebar__foot { padding: 10px 12px; border-top: 1px solid var(--hair); }

/* nav rail */
.dr-navrail {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 8px 6px;
    height: 100%;
    background: var(--surface);
    border-right: 1px solid var(--border);
}
.dr-navrail__items,
.dr-navrail__foot {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: stretch;
}
.dr-navrail__item {
    appearance: none;
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-width: 40px;
    min-height: 40px;
    padding: 6px;
    color: var(--muted-fg);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    cursor: pointer;
}
.dr-navrail__item:hover { color: var(--fg); background: var(--hover); }
.dr-navrail__item:focus-visible { outline: none; box-shadow: var(--dr-focus); }
.dr-navrail__item:disabled { opacity: 0.4; cursor: not-allowed; }
.dr-navrail__item--active,
.dr-navrail__item--active:hover {
    color: var(--primary);
    background: var(--sel);
    box-shadow: inset var(--list-rule, 2px) 0 0 var(--primary);
}
.dr-navrail__label { font: 10.5px/1.2 var(--sans); }
.dr-navrail--labels .dr-navrail__item { min-width: 60px; }
.dr-navrail__badge {
    position: absolute;
    top: 2px;
    right: 2px;
    font-size: 9px;
    padding: 0 4px;
}

/* stepper */
.dr-stepper {
    display: flex;
    gap: 8px;
    list-style: none;
    margin: 0;
    padding: 0;
}
.dr-stepper--vertical { flex-direction: column; gap: 14px; }
.dr-stepper__step {
    flex: 1 1 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
    position: relative;
}
.dr-stepper:not(.dr-stepper--vertical) .dr-stepper__step:not(:last-child)::after {
    content: "";
    flex: 1;
    height: 1px;
    margin-top: 11px;
    background: var(--border);
    min-width: 12px;
}
.dr-stepper__step--done:not(:last-child)::after { background: var(--primary) !important; }
.dr-stepper__mark {
    appearance: none;
    flex: none;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font: 500 11px var(--mono);
    color: var(--muted-fg);
    background: var(--input-bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-round);
    padding: 0;
}
button.dr-stepper__mark { cursor: pointer; }
button.dr-stepper__mark:hover { box-shadow: var(--dr-focus); }
.dr-stepper__step--current .dr-stepper__mark {
    color: var(--primary);
    border-color: var(--primary);
    background: var(--sel);
}
:root[data-dr-dark] .dr-stepper__step--current .dr-stepper__mark { box-shadow: var(--glow); }
.dr-stepper__step--done .dr-stepper__mark {
    color: var(--primary-fg);
    background: var(--primary);
    border-color: var(--primary);
}
.dr-stepper__step--failed .dr-stepper__mark {
    color: var(--danger-fg);
    background: var(--danger);
    border-color: var(--danger);
}
.dr-stepper__step--failed .dr-stepper__label { color: var(--danger); }
.dr-stepper__text { display: flex; flex-direction: column; min-width: 0; flex: 0 1 auto; overflow: hidden; padding-top: 2px; }
.dr-stepper__label { font-size: 13px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dr-stepper__step--todo .dr-stepper__label { color: var(--muted-fg); }
.dr-stepper__desc { font-size: 12px; color: var(--muted-fg); }

/* breadcrumbs */
.dr-breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    color: var(--muted-fg);
}
.dr-breadcrumbs__item { display: inline-flex; align-items: center; gap: 4px; }
.dr-breadcrumbs__link { color: var(--muted-fg); text-decoration: none; }
.dr-breadcrumbs__link:hover { color: var(--primary); }
.dr-breadcrumbs__current { color: var(--fg); }
.dr-breadcrumbs__sep { opacity: 0.6; }

/* command palette */
.dr-palette-scrim {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 12vh 16px 16px;
    background: var(--scrim);
    animation: dr-fade-in 0.12s ease;
}
.dr-palette {
    width: min(560px, 100%);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    color: var(--fg);
    background: var(--raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    animation: dr-rise-in 0.15s ease;
}
.dr-palette__search {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    color: var(--muted-fg);
    border-bottom: 1px solid var(--hair);
}
.dr-palette__input {
    flex: 1;
    min-width: 0;
    padding: 14px 0;
    font: 15px var(--sans);
    color: var(--fg);
    background: none;
    border: 0;
    outline: none;
}
.dr-palette__list { overflow-y: auto; padding: 6px; }
.dr-palette__group {
    padding: 8px 10px 4px;
    font: 500 10px/1.4 var(--mono);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
    color: var(--muted-fg);
}
.dr-palette__item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    font-size: 13.5px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--fg);
}
.dr-palette__item > .dr-icon { color: var(--muted-fg); }
.dr-palette__item--active { background: var(--sel); }
.dr-palette__item--active > .dr-icon { color: var(--primary); }
.dr-palette__noicon { width: 15px; flex: none; }
.dr-palette__label { flex: 1; min-width: 0; }
.dr-palette__shortcut { font: 11px var(--mono); color: var(--muted-fg); }
.dr-palette__empty { padding: 18px; text-align: center; color: var(--muted-fg); font-size: 13px; }
`
