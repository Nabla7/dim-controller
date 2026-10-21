// Tables, trees, key/value rows, stats, lists, logs, code blocks, sparklines and the timeline scrubber. Tokens only.
export const DATA_CSS = /* css */ `
/* table */
.dr-table-wrap {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    overflow: auto;
}
.dr-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    color: var(--fg);
}
.dr-table th {
    text-align: left;
    font: 500 10.5px/1.4 var(--mono);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
    color: var(--muted-fg);
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    white-space: nowrap;
    user-select: none;
}
:root[data-dr-dark] .dr-table th {
    font: 400 10px/1.4 var(--display);
}
.dr-table--sticky th {
    position: sticky;
    top: 0;
    z-index: 1;
}
.dr-table th > span { vertical-align: middle; }
.dr-table__sortable { cursor: pointer; }
.dr-table__sortable:hover { color: var(--fg); }
.dr-table__sorted { color: var(--primary); }
.dr-table__sort-icon {
    vertical-align: middle;
    margin-left: 4px;
    opacity: 0.55;
}
.dr-table__sorted .dr-table__sort-icon { opacity: 1; }
.dr-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--hair);
    vertical-align: middle;
}
.dr-table tbody tr:last-child td { border-bottom: 0; }
.dr-table--compact th { padding: 6px 10px; }
.dr-table--compact td { padding: 4px 10px; font-size: 12.5px; }
.dr-table__clickable { cursor: pointer; }
.dr-table tbody tr:hover { background: var(--hover); }
.dr-table__selected,
.dr-table tbody tr.dr-table__selected:hover {
    background: var(--sel);
    box-shadow: inset var(--list-rule, 2px) 0 0 var(--primary);
}
.dr-table__empty {
    text-align: center;
    color: var(--muted-fg);
    padding: 22px 12px !important;
}

/* tree */
.dr-tree,
.dr-tree ul {
    list-style: none;
    margin: 0;
    padding: 0;
}
.dr-tree {
    font-size: 13px;
    color: var(--fg);
}
.dr-tree__row {
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 26px;
    padding-right: 8px;
    border-radius: var(--radius-sm);
    cursor: default;
}
.dr-tree__row:hover { background: var(--hover); }
.dr-tree__row--selected,
.dr-tree__row--selected:hover {
    background: var(--sel);
    color: var(--primary);
}
.dr-tree__twisty {
    appearance: none;
    border: 0;
    background: none;
    color: var(--muted-fg);
    width: 16px;
    height: 16px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex: none;
    border-radius: var(--radius-sm);
}
.dr-tree__twisty:hover { color: var(--fg); }
.dr-tree__twisty:focus-visible { outline: none; box-shadow: var(--dr-focus); }
.dr-tree__twisty--leaf { cursor: default; }
.dr-tree__icon { color: var(--muted-fg); flex: none; }
.dr-tree__label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 12.5px;
}
.dr-tree__badge {
    font: 11px var(--mono);
    color: var(--muted-fg);
}

/* key / value */
.dr-kv { display: flex; flex-direction: column; }
.dr-kv__row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    font-size: 13px;
    padding: 6px 0;
    border-bottom: 1px solid var(--hair);
}
.dr-kv__row:last-child { border-bottom: 0; }
.dr-kv__key { color: var(--muted-fg); }
.dr-kv__value {
    color: var(--value-color, var(--fg));
    font-size: 12.5px;
    text-align: right;
    overflow-wrap: anywhere;
}

/* stat */
.dr-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}
.dr-stat__label {
    font: 500 10.5px/1.5 var(--mono);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
    color: var(--muted-fg);
}
:root[data-dr-dark] .dr-stat__label { font: 400 10px/1.5 var(--display); }
.dr-stat__value {
    font: 500 26px/1.15 var(--mono);
    color: var(--value-color, var(--fg));
    font-variant-numeric: tabular-nums;
}
.dr-stat__unit {
    font-size: 13px;
    color: var(--muted-fg);
    margin-left: 4px;
}
.dr-stat--ok .dr-stat__value { color: var(--ok); }
.dr-stat--warn .dr-stat__value { color: var(--warn); }
.dr-stat--danger .dr-stat__value { color: var(--danger); }
.dr-stat--info .dr-stat__value { color: var(--info); }
.dr-stat__delta { font: 12px var(--mono); color: var(--muted-fg); }
.dr-stat__delta--up { color: var(--ok); }
.dr-stat__delta--down { color: var(--danger); }
.dr-stat__hint { font-size: 12px; color: var(--muted-fg); }

/* list */
.dr-list { display: flex; flex-direction: column; }
.dr-list--divided > .dr-list-row + .dr-list-row { border-top: 1px solid var(--hair); }
.dr-list-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    min-height: 40px;
    margin-inline: var(--list-inset, 0); /* a skin's inset rows: a picked one reads as a button, not a stripe */
    color: var(--fg);
    border-radius: var(--list-row-radius, var(--radius-sm));
    outline: none;
}
.dr-list-row--clickable { cursor: pointer; }
.dr-list-row--clickable:hover { background: var(--hover); }
.dr-list-row:focus-visible { box-shadow: var(--dr-focus); }
.dr-list-row--selected,
.dr-list-row--selected:hover {
    background: var(--sel);
    box-shadow: inset var(--list-rule, 2px) 0 0 var(--primary);
}
.dr-list-row--disabled { opacity: 0.5; cursor: not-allowed; }
.dr-list-row__handle {
    color: var(--muted-fg);
    cursor: grab;
    display: inline-flex;
    touch-action: none;
}
.dr-list-row__icon {
    color: var(--muted-fg);
    display: inline-flex;
    flex: none;
}
.dr-list-row--selected .dr-list-row__icon { color: var(--primary); }
.dr-list-row__text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
}
.dr-list-row__title {
    font-size: 13.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dr-list-row__subtitle {
    font-size: 12px;
    color: var(--muted-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dr-list-row__meta {
    font: 12px var(--mono);
    color: var(--muted-fg);
    white-space: nowrap;
}
.dr-list-row__actions {
    display: inline-flex;
    gap: 4px;
    align-items: center;
}

/* log */
.dr-log {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--term-bg, var(--input-bg));
    color: var(--term-fg, var(--fg));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
}
.dr-log__lines {
    flex: 1;
    padding: 8px 0;
    font: 12px/1.55 var(--mono);
    white-space: pre;
}
.dr-log__lines--wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.dr-log__line {
    display: flex;
    gap: 10px;
    padding: 0 12px;
}
.dr-log__line:hover { background: var(--hover); }
.dr-log__ts { color: var(--term-dim, var(--muted-fg)); flex: none; }
.dr-log__line--debug .dr-log__text { color: var(--term-dim, var(--muted-fg)); }
.dr-log__line--warn .dr-log__text { color: var(--warn); }
.dr-log__line--error .dr-log__text { color: var(--danger); }
.dr-log__line--error { background: color-mix(in srgb, var(--danger) 7%, transparent); }
.dr-log__empty { color: var(--term-dim, var(--muted-fg)); padding: 4px 12px; }
.dr-log__jump {
    position: absolute;
    right: 12px;
    bottom: 10px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: 11.5px var(--sans);
    padding: 4px 10px;
    color: var(--primary-fg);
    background: var(--primary);
    border: 1px solid var(--primary);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-lg);
    cursor: pointer;
    animation: dr-rise-in 0.15s ease;
}

/* code */
.dr-code {
    background: var(--code-bg);
    color: var(--code-fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
}
.dr-code__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 8px 5px 12px;
    border-bottom: 1px solid var(--hair);
    font: 11px var(--mono);
    color: var(--muted-fg);
}
.dr-code__copy {
    appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: 11px var(--sans);
    color: var(--muted-fg);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 2px 7px;
    cursor: pointer;
}
.dr-code__copy:hover { color: var(--fg); border-color: var(--border); background: var(--hover); }
.dr-code__pre {
    margin: 0;
    padding: 10px 12px;
    font: 12.5px/1.55 var(--mono);
    overflow: auto;
}
.dr-code__line { display: flex; gap: 14px; white-space: pre; }
.dr-code__line--at { margin: 0 -12px; padding: 0 12px; background: var(--sel); }
.dr-code--fill { flex: 1; min-height: 0; display: flex; flex-direction: column; border: 0; border-radius: 0; }
.dr-code--fill .dr-code__pre { flex: 1; min-height: 0; }
.dr-code__num {
    color: var(--code-line);
    min-width: 2ch;
    text-align: right;
    user-select: none;
    flex: none;
}
.dr-tok-kw { color: var(--code-kw); }
.dr-tok-str { color: var(--code-str); }
.dr-tok-num { color: var(--code-num); }
.dr-tok-com { color: var(--code-com); font-style: italic; }
.dr-tok-func { color: var(--code-func); }

/* attitude indicator: sky in the accent, ground in the muted ink */
.dr-attitude {
    position: relative;
    overflow: hidden;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--primary) 12%, var(--bg));
}
.dr-attitude__sky {
    position: absolute;
    inset: -40%;
    background: linear-gradient(
        color-mix(in srgb, var(--primary) 30%, var(--bg)) 49.6%,
        color-mix(in srgb, var(--muted-fg) 30%, var(--bg)) 50.4%
    );
    transform-origin: center;
    transition: transform 120ms linear;
}
.dr-attitude--unknown .dr-attitude__sky { opacity: 0.4; }
.dr-attitude__cross {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 46px;
    height: 1px;
    background: var(--primary);
    transform: translate(-50%, -50%);
    box-shadow: 0 0 6px var(--primary);
}
.dr-attitude__cross::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 1px;
    height: 14px;
    background: var(--primary);
    transform: translate(-50%, -50%);
}
.dr-attitude__yaw {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 3px;
    text-align: center;
    font: 10px var(--mono);
    color: var(--fg);
}
/* sparkline */
.dr-sparkline { display: inline-block; vertical-align: middle; overflow: visible; }
.dr-sparkline__fill { fill: currentColor; opacity: 0.14; }

/* timeline */
.dr-timeline {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}
.dr-timeline--disabled { opacity: 0.5; }
.dr-timeline__play {
    appearance: none;
    flex: none;
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--primary-fg);
    background: var(--primary);
    border: 1px solid var(--primary);
    border-radius: var(--radius-round);
    cursor: pointer;
}
:root[data-dr-dark] .dr-timeline__play {
    color: var(--primary);
    background: var(--sel);
}
.dr-timeline__play:focus-visible { outline: none; box-shadow: var(--dr-focus); }
.dr-timeline__time {
    font: 12px var(--mono);
    color: var(--muted-fg);
    font-variant-numeric: tabular-nums;
    min-width: 4ch;
}
.dr-timeline__time--end { text-align: right; }
.dr-timeline__track {
    position: relative;
    flex: 1;
    height: 24px;
    cursor: pointer;
    outline: none;
}
.dr-timeline__track:focus-visible .dr-timeline__thumb { box-shadow: var(--dr-focus); }
.dr-timeline__rail,
.dr-timeline__done {
    position: absolute;
    left: 0;
    top: 50%;
    height: 4px;
    margin-top: -2px;
    border-radius: var(--radius-pill);
}
.dr-timeline__rail { right: 0; background: var(--track); border: 1px solid var(--border); }
.dr-timeline__done { background: var(--primary); }
.dr-timeline__marker {
    position: absolute;
    top: 3px;
    width: 2px;
    height: 18px;
    margin-left: -1px;
    background: var(--info);
    border-radius: var(--radius-pill);
    opacity: 0.85;
}
.dr-timeline__marker--ok { background: var(--ok); }
.dr-timeline__marker--warn { background: var(--warn); }
.dr-timeline__marker--danger { background: var(--danger); }
.dr-timeline__thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    margin: -7px 0 0 -7px;
    background: var(--primary);
    border: 2px solid var(--bg);
    border-radius: var(--radius-round);
    box-shadow: var(--shadow-sm, none);
}
:root[data-dr-dark] .dr-timeline__thumb { box-shadow: var(--glow); }

/* media frame: a video stream or an image */
.dr-media {
    position: relative;
    display: block;
    width: 100%;
    overflow: hidden;
    background: var(--input-bg);
    border: 1px solid var(--hair, var(--border));
    border-radius: var(--radius-sm);
}
.dr-media__el {
    display: block;
    width: 100%;
    height: 100%;
    max-height: inherit;
}
.dr-media__placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted-fg);
    font: 500 11px/1.4 var(--mono);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
    pointer-events: none;
}
`
