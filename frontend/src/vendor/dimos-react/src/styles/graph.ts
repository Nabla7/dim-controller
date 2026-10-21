// The graph view (dimos-react/graph): a dotted grid that pans and zooms with the drawing, edges in the muted ink
// (or --dr-graph-edge, set per edge), a focused node's neighbourhood lit and the rest dimmed, and its controls.
export const GRAPH_CSS = /* css */ `
.dr-graph {
    position: relative;
    overflow: hidden;
    background-color: var(--bg);
    background-image: radial-gradient(circle, color-mix(in srgb, var(--muted-fg) 35%, transparent) 1.1px, transparent 1.4px);
}
.dr-graph > svg.graph { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; user-select: none; }
.dr-graph > svg.graph.panning { cursor: grabbing; }
.dr-graph .edge {
    fill: none;
    stroke: color-mix(in srgb, var(--muted-fg) 88%, var(--fg));
    stroke-width: 1.6;
    opacity: 0.8;
}
.dr-graph .edge.lit, .dr-graph .edge.flow {
    opacity: 1;
    stroke: color-mix(in srgb, var(--dr-graph-edge, var(--muted-fg)) 70%, var(--muted-fg));
}
.dr-graph .edge.lit { stroke-width: 2.2; }
/* an edge with data moving along it */
.dr-graph .edge.flow { stroke-width: 2.6; stroke-dasharray: 7 5; animation: dr-graph-flow 0.8s linear infinite; }
@keyframes dr-graph-flow { to { stroke-dashoffset: -12; } }
.dr-graph .node:focus-visible { outline: none; }
.dr-graph--focus .node:not(.lit), .dr-graph--focus .edge:not(.lit) { opacity: 0.5; }
.dr-graph__zoom, .dr-graph__layouts { position: absolute; bottom: 12px; }
.dr-graph__zoom { left: 12px; }
.dr-graph__layouts { right: 12px; flex-wrap: wrap; max-width: calc(100% - 160px); }
/* <BlueprintGraph>: module and topic nodes, the fullscreen button, and the graph filling the window */
.dr-bpgraph { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: var(--bg); touch-action: pan-x pan-y; }
.dr-bpgraph > .dr-graph { position: absolute; inset: 0; }
.dr-bpgraph--overlay { position: fixed; inset: 0; z-index: 2147483000; }
.dr-bpgraph:fullscreen { width: 100vw; height: 100vh; }
.dr-bpgraph__fullscreen { position: absolute; top: 10px; right: 10px; }
.dr-bpgraph__empty { display: grid; place-items: center; height: 100%; min-height: 80px; color: var(--muted-fg); font: 13px var(--sans); }
.dr-bpgraph .node text { dominant-baseline: central; }
.dr-bpgraph .node.module { cursor: pointer; }
.dr-bpgraph .node.module .box { fill: var(--surface); stroke: var(--border-strong); stroke-width: 1.5; }
.dr-bpgraph .node.module:is(:hover, :focus-visible, .lit) .box { stroke: var(--primary); }
.dr-bpgraph .node.module :is(.bar, .tag) { fill: var(--primary); stroke: none; }
.dr-bpgraph .node.module .tag { font: 600 9.5px var(--sans); letter-spacing: 0.18em; }
.dr-bpgraph .node.module .name { fill: var(--fg); font: 600 15px var(--sans); }
.dr-bpgraph .node.module .more { fill: var(--muted-fg); font: 16px var(--sans); text-anchor: middle; }
.dr-bpgraph .node.topic .box { fill: var(--bg); stroke: color-mix(in srgb, var(--dr-bpgraph-type, var(--muted-fg)) 60%, transparent); stroke-width: 1.3; }
.dr-bpgraph .node.topic:is(.loose, .extra):not(:hover) .box { stroke: var(--border-strong); stroke-dasharray: 4 3; }
.dr-bpgraph .node.topic.live .box { stroke: var(--dr-bpgraph-type, var(--muted-fg)); }
.dr-bpgraph__view--running .node.topic:not(.live) { opacity: 0.85; }
.dr-bpgraph .node.topic .name { fill: var(--fg); font: 500 12px var(--mono); }
.dr-bpgraph .node.topic .rate { fill: var(--dr-bpgraph-type, var(--muted-fg)); font: 10px var(--mono); }
.dr-bpgraph .node .port { fill: var(--bg); stroke: var(--muted-fg); }
`
