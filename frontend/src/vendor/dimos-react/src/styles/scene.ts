// The 3D view: its box, the label overlay, scene labels pinned to 3D points, camera buttons and the stats pill.
export const SCENE_CSS = /* css */ `
.dr-scene {
    position: relative;
    overflow: hidden;
    min-height: 120px;
    background: var(--scene-bg, var(--bg));
    border-radius: inherit;
    isolation: isolate;
}
.dr-scene-host {
    position: absolute;
    inset: 0;
}
.dr-scene-canvas {
    display: block;
    touch-action: none;
    outline: none;
}
.dr-scene-labels {
    position: absolute;
    inset: 0;
    pointer-events: none;
}
.dr-scene-label {
    font: 600 11px/1.2 var(--sans);
    color: var(--fg);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    background: color-mix(in srgb, var(--raised) 80%, transparent);
    border-left: 3px solid var(--label-color, var(--primary));
    transform: translateY(-14px);
    transition: opacity 0.15s;
}
.dr-scene-label.dr-frame-label {
    font-weight: 500;
    font-size: 10px;
    opacity: 0.8;
    border-left-color: var(--label-color, var(--muted-fg));
}
.dr-scene-label.dr-highlight {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--primary-fg);
    background: var(--primary);
    border-left-color: var(--fg);
    z-index: 2;
}
.dr-scene-label.dr-note {
    white-space: pre;
    text-align: center;
    font-size: 12px;
    color: var(--label-color, var(--warn));
    border-left-color: var(--label-color, var(--warn));
}
.dr-scene-label.dr-covered {
    opacity: 0;
}
.dr-scene-overlay {
    position: absolute;
    z-index: 2;
    pointer-events: auto;
}
.dr-scene-controls {
    position: absolute;
    z-index: 2;
    right: 10px;
    bottom: calc(10px + var(--dim-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.dr-scene-controls--top-right { bottom: auto; top: 10px; }
.dr-scene-controls--top-left { bottom: auto; top: 10px; right: auto; left: 10px; }
.dr-scene-controls--bottom-left { right: auto; left: 10px; }
.dr-scene-btn {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    cursor: pointer;
    color: var(--fg);
    background: var(--glass, var(--surface));
    backdrop-filter: var(--blur);
    -webkit-backdrop-filter: var(--blur);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: background 0.15s ease, border-color 0.15s ease;
}
.dr-scene-btn:hover {
    background: var(--hover);
    border-color: var(--border-strong);
}
.dr-scene-btn:focus-visible {
    outline: none;
    border-color: var(--ring);
    box-shadow: var(--dr-focus);
}
.dr-scene-viewcube {
    position: absolute;
    z-index: 3;
    top: 10px;
    right: 10px;
    touch-action: none;
    filter: drop-shadow(0 1px 3px color-mix(in srgb, var(--bg) 60%, transparent));
}
.dr-scene-viewcube--top-left { right: auto; left: 10px; }
.dr-scene-viewcube--bottom-right { top: auto; bottom: calc(10px + var(--dim-inset-bottom, 0px)); }
.dr-scene-viewcube--bottom-left {
    top: auto;
    right: auto;
    left: 10px;
    bottom: calc(10px + var(--dim-inset-bottom, 0px));
}
.dr-scene-stats {
    position: absolute;
    z-index: 2;
    left: 10px;
    bottom: calc(10px + var(--dim-inset-bottom, 0px));
    font: 11px/1.4 var(--mono);
    color: var(--muted-fg);
    padding: 3px 8px;
    background: var(--glass, var(--surface));
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    pointer-events: none;
}
.dr-scene-stats--detailed {
    border-radius: var(--radius);
    display: grid;
    gap: 1px;
    left: auto;
    right: 10px;
    top: 10px;
    bottom: auto;
}
/* point-style cards (StylePicker) */
.dr-style-picker {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 6px;
}
.dr-style-card {
    appearance: none;
    display: grid;
    grid-template-columns: 22px 1fr;
    grid-template-rows: auto auto;
    column-gap: 8px;
    align-items: center;
    text-align: left;
    padding: 6px 8px;
    cursor: pointer;
    color: var(--fg);
    font: inherit;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}
.dr-style-card:hover {
    background: var(--hover);
}
.dr-style-card--on {
    border-color: var(--primary);
    box-shadow: inset 0 0 0 1px var(--primary);
}
.dr-style-card:focus-visible {
    outline: none;
    box-shadow: var(--dr-focus);
}
.dr-style-swatch {
    grid-row: span 2;
    width: 22px;
    height: 22px;
    border-radius: var(--radius-sm);
    background: radial-gradient(circle at 35% 35%, var(--fg), var(--primary) 45%, transparent 70%);
}
.dr-style-swatch--voxel {
    border-radius: 2px;
    background: linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary) 45%, var(--bg)));
}
.dr-style-swatch--splat {
    background: radial-gradient(circle, var(--primary), transparent 70%);
}
.dr-style-swatch--square {
    border-radius: 0;
    background: var(--primary);
}
.dr-style-swatch--default {
    background: repeating-linear-gradient(45deg, var(--muted-fg) 0 3px, transparent 3px 6px);
}
.dr-style-name {
    font-size: 12.5px;
    font-weight: 600;
}
.dr-style-about {
    font-size: 11px;
    color: var(--muted-fg);
    line-height: 1.3;
}
.dr-range-inputs {
    display: flex;
    gap: 6px;
}
.dr-look-editor,
.dr-layer-settings-grid {
    display: grid;
    gap: 8px;
}
/* LayersPanel */
.dr-layers {
    display: grid;
    gap: 12px;
}
.dr-layer-group {
    display: grid;
    gap: 4px;
}
.dr-layer-group-title {
    margin: 0;
    font: 600 11px/1.3 var(--sans);
    letter-spacing: 0.04em;
    text-transform: var(--label-case, uppercase);
    color: var(--muted-fg);
}
.dr-layer-row {
    border: 1px solid transparent;
    border-radius: var(--radius);
    padding: 4px 6px;
}
.dr-layer-row--on {
    background: color-mix(in srgb, var(--surface) 70%, transparent);
    border-color: var(--border);
}
.dr-layer-line {
    display: flex;
    align-items: center;
    gap: 8px;
}
.dr-layer-name {
    appearance: none;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 0;
    font: inherit;
    color: var(--fg);
    text-align: left;
    background: none;
    border: 0;
    cursor: pointer;
}
.dr-layer-name:disabled {
    cursor: default;
}
.dr-layer-topic {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 12.5px/1.3 var(--mono);
}
.dr-layer-type {
    font-size: 11px;
    color: var(--muted-fg);
}
.dr-layer-chevron {
    margin-left: auto;
    display: inline-flex;
    color: var(--muted-fg);
    transition: transform 0.15s;
}
.dr-layer-chevron--open {
    transform: rotate(90deg);
}
.dr-layer-status {
    margin: 2px 0 0 40px;
    font: 11px/1.35 var(--mono);
    color: var(--muted-fg);
}
.dr-layer-status--problem {
    color: var(--warn);
}
.dr-layer-settings {
    margin: 8px 0 4px;
    padding: 8px;
    border-top: 1px solid var(--border);
}
.dr-layer-other summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--muted-fg);
}
.dr-layer-other-topic {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font: 11.5px/1.5 var(--mono);
}
/* TfPanel */
.dr-tf-panel {
    display: grid;
    gap: 8px;
}
.dr-hint {
    margin: 0;
    font-size: 12px;
    color: var(--muted-fg);
}
.dr-tf-tree {
    font: 12px/1.6 var(--mono);
}
.dr-tf-frame {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    border-radius: var(--radius-sm);
    cursor: default;
}
.dr-tf-frame:hover,
.dr-tf-frame--highlighted {
    background: var(--hover);
}
.dr-tf-frame--stale {
    color: var(--warn);
}
.dr-tf-frame--flagged {
    box-shadow: inset 2px 0 0 var(--warn);
}
.dr-tf-age {
    color: var(--muted-fg);
}
.dr-tf-footnote {
    appearance: none;
    position: absolute;
    z-index: 2;
    left: 10px;
    top: 10px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: calc(100% - 20px);
    padding: 3px 8px;
    font: 11.5px/1.4 var(--sans);
    color: var(--warn);
    cursor: pointer;
    background: var(--glass, var(--surface));
    border: 1px solid var(--warn-line, var(--border));
    border-radius: var(--radius-pill);
}
.dr-tf-footnote span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dr-gradient-picker {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
    gap: 5px;
    width: 100%;
}
.dr-gradient-picker__swatch {
    appearance: none;
    height: 14px;
    padding: 0;
    cursor: pointer;
    border: 2px solid transparent;
    border-radius: var(--radius-sm);
}
.dr-gradient-picker__swatch[aria-checked="true"] {
    border-color: var(--fg);
}
.dr-gradient-picker__swatch:focus-visible {
    outline: none;
    box-shadow: var(--dr-focus);
}
`
