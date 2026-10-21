// The settings form: rows (name | control + reset), bordered groups and titled sections. Tokens only.
export const SETTINGS_CSS = /* css */ `
.dr-setting {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 2px 10px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--hair);
}
.dr-setting:last-child { border-bottom: 0; }
.dr-setting__name { font-size: 12.5px; }
.dr-setting__mark { margin-left: 6px; color: var(--primary); font-size: 10.5px; }
.dr-setting__control { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.dr-setting--wide .dr-setting__control { grid-column: 1 / -1; justify-content: flex-start; }
.dr-setting__link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted-fg);
    font: 11px var(--sans);
    cursor: pointer;
}
.dr-setting__link:hover { color: var(--fg); }
.dr-setting__reset { width: 40px; flex: none; }
.dr-setting__docs { grid-column: 1 / -1; color: var(--muted-fg); font-size: 11.5px; }
.dr-setting-input { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.dr-setting-input__box { display: inline-flex; align-items: center; gap: 6px; }
.dr-setting-input .dr-input-wrap, .dr-setting-input .dr-select { width: 150px; }
.dr-setting-input__problem { color: var(--warn); font-size: 11px; }

.dr-setting-group { margin-bottom: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.dr-setting-group__head {
    display: flex;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid var(--hair);
    font: 600 12px var(--mono);
}
.dr-setting-group__count { color: var(--primary); }
.dr-setting-group--accent > .dr-setting-group__head {
    border-left: 3px solid var(--primary);
    background: color-mix(in srgb, var(--primary) 9%, transparent);
    color: color-mix(in srgb, var(--primary) 70%, var(--fg));
}

.dr-setting-section__head {
    margin-bottom: 6px;
    font: 400 10px var(--display);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
    color: var(--primary);
}
.dr-setting-section__note {
    margin-left: 8px;
    color: var(--muted-fg);
    font: 11px var(--mono);
    letter-spacing: 0;
    text-transform: none;
}
.dr-setting-section__hint { margin: 0 0 6px; color: var(--muted-fg); font-size: 12px; }
.dr-setting-section--highlight {
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--primary) 50%, transparent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--primary) 6%, transparent);
}
@media (max-width: 720px) {
    .dr-setting-input .dr-input-wrap, .dr-setting-input .dr-select { width: 120px; }
}
`
