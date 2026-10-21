// ViewPanel (float / dock / main panel chrome), ThumbStick, KeyPad, camera views. Tokens only (see base.js).
export const VIEW_PANEL_CSS = /* css */ `
.dr-view-panel {
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    container-type: inline-size;
    background: var(--scene-bg, var(--bg));
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
    box-sizing: border-box;
}
.dr-view-panel--float { position: absolute; z-index: 3; min-width: 180px; min-height: 60px; }
.dr-view-panel--main { position: absolute; inset: 0; border-radius: 0; border: 0; box-shadow: none; z-index: 1; }
.dr-view-panel--dock { position: absolute; z-index: 2; }
.dr-view-panel--hidden { inset: 0; visibility: hidden; pointer-events: none; }
.dr-view-panel--maximized { z-index: 4; }
.dr-view-panel--drop { outline: 2px solid var(--primary); outline-offset: -2px; }
body.dr-tile-dragging, body.dr-tile-dragging * { cursor: grabbing !important; user-select: none; }
.dr-view-panel-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 33px;
    padding: 3px 6px;
    flex: none;
    box-sizing: border-box;
    background: var(--card);
    border-bottom: 1px solid var(--hair);
    user-select: none;
    min-width: 0;
}
.dr-view-panel-head:empty { display: none; }
.dr-view-panel--float > .dr-view-panel-head { cursor: move; }
.dr-view-panel--tile > .dr-view-panel-head { cursor: grab; }
.dr-view-panel--tile.dr-view-panel--maximized > .dr-view-panel-head { cursor: default; }
.dr-view-panel-head .dr-select { width: auto; flex: 0 1 auto; min-width: 64px; max-width: 60%; }
.dr-view-panel-head--wrap { flex-wrap: wrap; row-gap: 4px; }
.dr-view-panel-head--wrap .dr-select { max-width: 100%; flex: 0 0 auto; }
.dr-view-panel-head > .dr-btn--icon, .dr-view-panel-head > .dr-btn-group { flex: none; }
.dr-view-panel-maximize { margin-left: auto; }
.dr-view-panel-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    font: 500 10.5px/1.5 var(--mono);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
    color: var(--fg);
    white-space: nowrap;
}
:root[data-dr-dark] .dr-view-panel-title { font: 400 10px/1.5 var(--display); }
.dr-view-panel-info {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 11px var(--mono);
    color: var(--muted-fg);
}
.dr-view-panel-body { position: relative; flex: 1; min-height: 0; min-width: 0; }
.dr-view-panel-resize { position: absolute; bottom: 0; width: 22px; height: 22px; z-index: 3; touch-action: none; }
.dr-view-panel-resize--left { left: 0; cursor: nesw-resize; }
.dr-view-panel-resize--right { right: 0; cursor: nwse-resize; }
.dr-view-panel-resize::before {
    content: "";
    position: absolute;
    bottom: 4px;
    width: 11px;
    height: 11px;
    border-bottom: 2px solid var(--fg);
    opacity: 0.5;
}
.dr-view-panel-resize--left::before { left: 4px; border-left: 2px solid var(--fg); }
.dr-view-panel-resize--right::before { right: 4px; border-right: 2px solid var(--fg); }
.dr-view-panel:hover .dr-view-panel-resize::before { opacity: 0.85; }

/* ThumbStick: a zone that takes the thumb; the stick centers where it lands */
.dr-thumbstick { position: relative; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; min-width: 0; --dr-stick: clamp(112px, min(33vw, 26vh), 160px); }
.dr-thumbstick-base {
    position: absolute;
    left: 50%;
    top: 55%;
    width: var(--dr-stick);
    height: var(--dr-stick);
    transform: translate(-50%, -50%);
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--fg) 40%, transparent);
    background: radial-gradient(circle, color-mix(in srgb, var(--card) 35%, transparent), color-mix(in srgb, var(--card) 70%, transparent));
    transition: left 0.12s ease, top 0.12s ease;
    pointer-events: none;
}
.dr-thumbstick--active .dr-thumbstick-base {
    border-color: var(--fg);
    box-shadow: 0 0 14px color-mix(in srgb, var(--bg) 60%, transparent), inset 0 0 10px color-mix(in srgb, var(--fg) 12%, transparent);
    transition: none;
}
.dr-thumbstick-knob {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 44%;
    height: 44%;
    margin: -22% 0 0 -22%;
    border-radius: 50%;
    pointer-events: none;
    background: color-mix(in srgb, var(--fg) 30%, transparent);
    border: 1px solid color-mix(in srgb, var(--fg) 50%, transparent);
}
.dr-thumbstick--active .dr-thumbstick-knob { background: var(--primary); border-color: var(--fg); }
.dr-thumbstick-guide { position: absolute; inset: 18%; pointer-events: none; opacity: 0.35; }
.dr-thumbstick-guide::before, .dr-thumbstick-guide::after { content: ""; position: absolute; background: var(--fg); }
.dr-thumbstick-guide--xy::before, .dr-thumbstick-guide--y::before { left: 50%; top: 0; bottom: 0; width: 1px; }
.dr-thumbstick-guide--xy::after, .dr-thumbstick-guide--x::after { top: 50%; left: 0; right: 0; height: 1px; }
.dr-thumbstick-label {
    position: absolute;
    left: -20px;
    right: -20px;
    bottom: calc(100% + 6px);
    text-align: center;
    font: 600 10px var(--sans);
    color: var(--fg);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.8;
}

/* KeyPad: keyboard keys in rows, lit while held */
.dr-keypad { display: grid; gap: 3px; }
.dr-keypad-row { display: flex; gap: 3px; justify-content: center; }
.dr-keycap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 26px;
    height: 26px;
    padding: 0 4px;
    box-sizing: border-box;
    border-radius: var(--radius-sm);
    font: 700 11px var(--mono);
    color: var(--fg);
    background: var(--input-bg, var(--card));
    border: 1px solid var(--border);
}
.dr-keycap--empty { visibility: hidden; }
.dr-keycap--wide { min-width: 56px; }
.dr-keycap--down { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }

/* Map2D */
.dr-map2d { position: absolute; inset: 0; overflow: hidden; background: var(--scene-bg, var(--bg)); }
.dr-map2d-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
.dr-map2d-canvas:active { cursor: grabbing; }

/* camera views */
.dr-camera { position: absolute; inset: 0; background: var(--scene-bg, var(--bg)); overflow: hidden; }
.dr-camera-media, .dr-camera-overlay, .dr-camera > canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
}
.dr-camera-overlay { pointer-events: none; }
.dr-camera--fill .dr-camera-media, .dr-camera--fill .dr-camera-overlay, .dr-camera--fill > canvas { object-fit: cover; }
.dr-camera-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted-fg); font-size: 12px; }
.dr-camera-tabs { display: flex; gap: 2px; min-width: 0; flex: 0 1 auto; overflow-x: auto; scrollbar-width: none; }
.dr-camera-tabs::-webkit-scrollbar { display: none; }
.dr-camera-tab {
    flex: none;
    padding: 2px 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted-fg);
    font: 11px var(--mono);
    cursor: pointer;
    white-space: nowrap;
}
.dr-camera-tab:hover { color: var(--fg); background: var(--hover); }
.dr-camera-tab[aria-selected="true"] { color: var(--fg); border-color: var(--border); background: var(--input-bg, var(--card)); }
.dr-camera-tab--gone { color: var(--muted-fg); font-style: italic; cursor: default; }
.dr-camera-tab--depth::after { content: " · depth"; color: var(--muted-fg); }
`
