// The structured log, the traceback it draws and the editor note. Tokens only: errors in the window-close red (--close-red), falling
// back to --danger.
export const LOGS_CSS = /* css */ `
/* structured log */
.dr-slog { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.dr-slog__tools { display: flex; align-items: center; gap: 8px; }
.dr-slog__tools .dr-search { flex: 1; }
.dr-slog__level { flex: none; width: 170px; }
.dr-slog__body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 6px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font: 11.5px/1.5 var(--mono);
}
.dr-slog__note { color: var(--muted-fg); font: 12px var(--sans); }
.dr-slog__line { display: flex; gap: 8px; white-space: pre-wrap; word-break: break-word; }
.dr-slog__ts { flex: none; color: var(--muted-fg); }
.dr-slog__lv { flex: none; width: 58px; color: var(--muted-fg); }
.dr-slog__rec--warning .dr-slog__lv { color: var(--warn); }
.dr-slog__rec--error .dr-slog__lv,
.dr-slog__rec--critical .dr-slog__lv { color: var(--close-red, var(--danger)); }
.dr-slog__logger { margin-right: 6px; color: var(--muted-fg); }
.dr-slog__chip {
    display: inline-block;
    margin-left: 6px;
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--muted-fg);
    font-size: 10.5px;
    white-space: normal;
    word-break: break-all;
}
.dr-slog__key { margin-right: 4px; opacity: 0.7; }
.dr-slog__field { margin: 2px 0 4px 66px; color: var(--muted-fg); }
.dr-slog__field .dr-slog__key { font-size: 10.5px; }
.dr-slog__field pre { margin: 0; font: inherit; white-space: pre-wrap; word-break: break-word; }
.dr-slog__tb { margin: 4px 0 8px 66px; }

/* traceback */
.dr-tb {
    padding: 6px 8px;
    border-left: 2px solid var(--close-red, var(--danger));
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    background: color-mix(in srgb, var(--close-red, var(--danger)) 5%, transparent);
    font: 11.5px/1.5 var(--mono);
    overflow-x: auto;
}
.dr-tb__lines { width: max-content; min-width: 100%; }
.dr-tb__row { white-space: pre; color: var(--muted-fg); }
.dr-tb__gutter, .dr-tb__dim, .dr-tb__marker { color: var(--muted-fg); opacity: 0.55; }
.dr-tb__frame--own, .dr-tb__code--own { color: var(--fg); }
.dr-tb__frame--lib { opacity: 0.75; }
.dr-tb__file { padding: 0; border: 0; background: none; color: var(--info); font: inherit; font-weight: 600; }
button.dr-tb__file { cursor: pointer; }
button.dr-tb__file:hover { text-decoration: underline; }
.dr-tb__func { margin-left: 1ch; color: var(--muted-fg); }
.dr-tb__exc { color: var(--close-red, var(--danger)); }
.dr-tb__lib > summary { cursor: pointer; list-style: none; font-style: italic; opacity: 0.6; }
.dr-tb__lib > summary::-webkit-details-marker { display: none; }
.dr-tb__lib > summary::after { content: " ▸"; }
.dr-tb__lib[open] > summary::after { content: " ▾"; }
.dr-tb__raised {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid color-mix(in srgb, var(--close-red, var(--danger)) 35%, transparent);
}
.dr-tb__raised-one {
    padding-left: calc(var(--dr-tb-depth, 0) * 14px);
    color: var(--close-red, var(--danger));
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.75;
}
.dr-tb__raised-one + .dr-tb__raised-one::before { content: "↳ "; }
.dr-tb__raised-one--leaf { font-size: 12.5px; font-weight: 600; opacity: 1; }

/* how opening a file in the editor went (desktop_frame.tsx) */
.dr-editor-note {
    padding: 5px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--raised);
    color: var(--muted-fg);
    font: 11px var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dr-editor-note--failed { color: var(--warn); white-space: normal; }
`
