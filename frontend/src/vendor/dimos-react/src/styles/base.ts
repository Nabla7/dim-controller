// Page basics and typography. Conventions for every styles/*.js file:
// - classes are `dr-<component>` (modifiers `dr-<component>--<modifier>` or state attributes like [aria-pressed])
// - colors, radii, shadows and fonts come only from Desktop's tokens: var(--fg), var(--primary), color-mix() of
//   tokens; never a hex/rgb/hsl literal
// - light skins get the base rules; dark skins add `:root[data-dr-dark]` rules (the provider sets that attribute
//   from the skin's color-scheme), the way Desktop's own Research (light) and Portal (dark) docs differ
export const BASE_CSS = /* css */ `
.dr-body {
    margin: 0;
    color: var(--fg);
    background: var(--bg);
    font: 14px/1.55 var(--sans);
    -webkit-font-smoothing: antialiased;
    transition: background-color 0.2s ease, color 0.2s ease;
}
:root {
    --dr-focus: 0 0 0 3px var(--ring-soft);
    --dr-gap: 8px;
    --dr-control-h: 34px;
    --dr-control-h-sm: 26px;
}
:root[data-dr-dark] {
    --dr-focus: 0 0 0 1px var(--primary), 0 0 14px var(--ring-soft);
}
.dr-root,
.dr-root *,
[class^="dr-"],
[class*=" dr-"],
[class^="dr-"]::before,
[class*=" dr-"]::after {
    box-sizing: border-box;
}
.dr-body ::selection {
    background: var(--sel);
}
.dr-body :where(button, input, select, textarea, option) {
    font-family: var(--sans);
}
.dr-body :where(input, textarea)::placeholder {
    color: var(--placeholder);
}
.dr-body :where(input[type="checkbox"], input[type="radio"], input[type="range"], progress) {
    accent-color: var(--primary);
}
.dr-scroll {
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
}

/* typography */
.dr-h1, .dr-h2, .dr-h3, .dr-title {
    margin: 0;
    color: var(--fg);
}
.dr-h1 {
    font: 400 30px/1.1 var(--display);
    letter-spacing: -0.01em;
}
:root[data-dr-dark] .dr-h1 {
    font: 400 18px/1.3 var(--display);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
}
.dr-title {
    font: 400 var(--title-size, 13px)/1.2 var(--title-font, var(--display));
    letter-spacing: var(--title-track, 0.1em);
    text-transform: var(--title-case, none);
    white-space: nowrap;
}
.dr-h2 {
    font: 500 10.5px/1.5 var(--mono);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
    color: var(--head-color, var(--primary));
    display: flex;
    align-items: center;
    gap: 8px;
}
:root[data-dr-dark] .dr-h2 {
    font: 400 12px/1.5 var(--head-font, var(--display));
    text-shadow: var(--head-shadow, none);
}
.dr-h3,
.dr-label {
    font: 500 10.5px/1.5 var(--mono);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
    color: var(--muted-fg);
}
:root[data-dr-dark] .dr-h3,
:root[data-dr-dark] .dr-label {
    font: 400 10px/1.5 var(--display);
}
.dr-text { color: var(--fg); }
.dr-muted { color: var(--muted-fg); }
.dr-mono { font-family: var(--mono); }
.dr-small { font-size: 12px; }
.dr-ok { color: var(--ok); }
.dr-warn { color: var(--warn); }
.dr-danger { color: var(--danger); }
.dr-link {
    color: var(--primary);
    text-decoration: none;
    font-weight: 500;
    border-bottom: 1px solid var(--primary-soft);
    cursor: pointer;
}
.dr-link:hover { border-color: var(--primary); }
.dr-code-inline {
    font: 12.5px var(--mono);
    color: var(--info);
}
.dr-kbd {
    display: inline-block;
    font: 11px/1.6 var(--mono);
    padding: 0 5px;
    min-width: 18px;
    text-align: center;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: var(--radius-sm);
    background: var(--input-bg);
    color: var(--muted-fg);
}
.dr-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
}
@keyframes dr-spin { to { transform: rotate(360deg); } }
@keyframes dr-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes dr-rise-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
    [class^="dr-"], [class*=" dr-"] { animation-duration: 0.01ms !important; transition: none !important; }
}
`
