// Markdown and the flashing live value. Tokens only.
export const TEXT_CSS = /* css */ `
/* markdown */
.dr-md { font-size: 13.5px; line-height: 1.6; color: var(--fg); }
.dr-md > :first-child { margin-top: 0; }
.dr-md > :last-child { margin-bottom: 0; }
.dr-md p { margin: 0 0 10px; }
.dr-md ul, .dr-md ol { margin: 0 0 10px; padding-left: 20px; }
.dr-md li { margin: 2px 0; }
.dr-md li.dr-md__sub { margin-left: 18px; }
.dr-md .dr-md__h { margin: 14px 0 6px; color: var(--fg); font-weight: 600; }
.dr-md h4.dr-md__h { font-size: 14px; }
.dr-md h5.dr-md__h { font-size: 13px; color: var(--muted-fg); }
.dr-md__pre {
    margin: 0 0 10px;
    padding: 10px 12px;
    background: var(--code-bg);
    color: var(--code-fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font: 12px/1.5 var(--mono);
    overflow: auto;
    white-space: pre;
}
.dr-md__table { margin: 0 0 10px; }
.dr-md--inline, .dr-md--inline p { display: inline; margin: 0; }

/* server-rendered HTML (SafeHtml): the same prose, for plain tags */
.dr-prose h1, .dr-prose h2, .dr-prose h3, .dr-prose h4 { margin: 16px 0 8px; color: var(--fg); font-weight: 600; line-height: 1.3; }
.dr-prose h1 { font-size: 20px; }
.dr-prose h2 { font-size: 16px; }
.dr-prose h3, .dr-prose h4 { font-size: 14px; }
.dr-prose a { color: var(--primary); }
.dr-prose code { font: 12px var(--mono); padding: 1px 4px; background: var(--code-bg); color: var(--code-fg); border-radius: var(--radius-sm); }
.dr-prose pre {
    margin: 0 0 10px;
    padding: 10px 12px;
    background: var(--code-bg);
    color: var(--code-fg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font: 12px/1.5 var(--mono);
    overflow: auto;
}
.dr-prose pre code { padding: 0; background: none; }
.dr-prose table { border-collapse: collapse; margin: 0 0 10px; }
.dr-prose th, .dr-prose td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.dr-prose img { max-width: 100%; }
.dr-prose blockquote { margin: 0 0 10px; padding-left: 12px; border-left: 2px solid var(--border-strong); color: var(--muted-fg); }

/* live value */
.dr-live-value { font-variant-numeric: tabular-nums; border-radius: 3px; }
.dr-live-value--flash { animation: dr-live-flash 0.9s ease-out; }
@keyframes dr-live-flash {
    from { background: var(--sel); color: var(--primary); }
    to { background: transparent; }
}
`
