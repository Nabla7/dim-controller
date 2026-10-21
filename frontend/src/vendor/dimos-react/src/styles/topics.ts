// The topic rates table. Tokens only (the per-type colors and heat tints are set inline from tokens).
export const TOPICS_CSS = /* css */ `
.dr-rates { overflow-y: auto; scrollbar-width: none; }
.dr-rates::-webkit-scrollbar { display: none; }
.dr-rates table { width: 100%; border-collapse: separate; border-spacing: 0 2px; font: 11.5px var(--mono); }
.dr-rates td { padding: 2px 5px; line-height: 15px; white-space: nowrap; }
.dr-rates__topic { max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
.dr-rates__num { color: var(--fg); text-align: right; font-variant-numeric: tabular-nums; }
.dr-rates--quiet td { opacity: 0.55; }
.dr-rates__empty { color: var(--muted-fg); }
`
