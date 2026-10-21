// Joystick, D-pad, file drop, color swatch, key hints. Tokens only.
export const INPUT_DEVICES_CSS = /* css */ `
/* stick readout */
.dr-stick-indicator { flex: none; }
.dr-stick-indicator__ring { fill: none; stroke: var(--border-strong, var(--border)); stroke-width: 0.12; }
.dr-stick-indicator__arm { stroke: var(--muted-fg); stroke-width: 0.1; }
.dr-stick-indicator__dot { fill: var(--muted-fg); }
.dr-stick-indicator--live .dr-stick-indicator__dot { fill: var(--primary); }

/* joystick */
.dr-joystick {
    position: relative;
    flex: none;
    border-radius: var(--radius-round);
    background: color-mix(in srgb, var(--surface) 80%, transparent);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow);
    backdrop-filter: var(--blur);
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
}
.dr-joystick--active { cursor: grabbing; border-color: var(--primary); }
.dr-joystick--disabled { opacity: 0.45; cursor: not-allowed; }
.dr-joystick__ring {
    position: absolute;
    inset: 18%;
    border: 1px dashed var(--border);
    border-radius: var(--radius-round);
    pointer-events: none;
}
.dr-joystick__cross {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
        linear-gradient(var(--hair), var(--hair)) center / 1px 70% no-repeat,
        linear-gradient(var(--hair), var(--hair)) center / 70% 1px no-repeat;
}
.dr-joystick__knob {
    position: absolute;
    left: 50%;
    top: 50%;
    border-radius: var(--radius-round);
    background: var(--primary);
    border: 2px solid color-mix(in srgb, var(--bg) 60%, transparent);
    box-shadow: var(--shadow-md, none);
    pointer-events: none;
    transition: transform 0.18s ease;
}
:root[data-dr-dark] .dr-joystick__knob {
    background: var(--sel);
    border: 1px solid var(--primary);
    box-shadow: var(--glow);
}
.dr-joystick--active .dr-joystick__knob { transition: none; }
.dr-joystick__label {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -20px;
    text-align: center;
    font: 500 10px/1.4 var(--mono);
    letter-spacing: var(--track-label);
    text-transform: var(--label-case);
    color: var(--muted-fg);
}

/* d-pad */
.dr-dpad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-template-rows: repeat(3, 1fr);
    grid-template-areas: ". up ." "left center right" ". down .";
    gap: 3px;
    flex: none;
    user-select: none;
    -webkit-user-select: none;
}
.dr-dpad--disabled { opacity: 0.45; }
.dr-dpad__btn,
.dr-dpad__hub {
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius);
}
.dr-dpad__btn {
    appearance: none;
    padding: 0;
    color: var(--fg);
    background: color-mix(in srgb, var(--surface) 85%, transparent);
    border: 1px solid var(--border-strong);
    cursor: pointer;
    font: 500 11px var(--mono);
}
.dr-dpad__btn:hover { background: var(--hover); border-color: var(--primary); }
.dr-dpad__btn:focus-visible { outline: none; box-shadow: var(--dr-focus); }
.dr-dpad__btn[aria-pressed="true"] {
    color: var(--primary-fg);
    background: var(--primary);
    border-color: var(--primary);
}
:root[data-dr-dark] .dr-dpad__btn[aria-pressed="true"] {
    color: var(--primary);
    background: var(--sel);
    box-shadow: var(--glow);
}
.dr-dpad__btn--up { grid-area: up; }
.dr-dpad__btn--down { grid-area: down; }
.dr-dpad__btn--left { grid-area: left; }
.dr-dpad__btn--right { grid-area: right; }
.dr-dpad__btn--center { grid-area: center; }
.dr-dpad__hub { grid-area: center; background: var(--input-bg); border: 1px solid var(--hair); }

/* file drop */
.dr-filedrop {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 120px;
    padding: 20px;
    text-align: center;
    color: var(--muted-fg);
    background: var(--input-bg);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    cursor: pointer;
    outline: none;
    transition: border-color 0.15s ease, background 0.15s ease;
}
.dr-filedrop:hover { border-color: var(--primary); color: var(--fg); }
.dr-filedrop:focus-visible { box-shadow: var(--dr-focus); border-color: var(--ring); }
.dr-filedrop--over {
    border-style: solid;
    border-color: var(--primary);
    background: var(--sel);
    color: var(--primary);
}
.dr-filedrop--disabled { opacity: 0.5; cursor: not-allowed; }
.dr-filedrop__icon { color: var(--primary); }
.dr-filedrop__title { font-size: 14px; color: var(--fg); }
.dr-filedrop__hint { font-size: 12px; }

/* color swatch */
.dr-swatch { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dr-swatch__pick {
    position: relative;
    display: inline-flex;
    padding: 2px;
    background: var(--input-bg);
    border: 1px solid var(--input);
    border-radius: var(--radius-sm);
    cursor: pointer;
}
.dr-swatch__pick:hover { border-color: var(--primary); }
.dr-swatch__pick:focus-within { box-shadow: var(--dr-focus); border-color: var(--ring); }
.dr-swatch__pick--disabled { opacity: 0.5; cursor: not-allowed; }
.dr-swatch__color {
    width: 36px;
    height: 20px;
    border-radius: var(--radius-sm);
    box-shadow: inset 0 0 0 1px var(--hair);
}
.dr-swatch__preset {
    appearance: none;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-round);
    cursor: pointer;
}
.dr-swatch__preset:hover { transform: scale(1.12); }
.dr-swatch__preset[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3px var(--primary); }

/* key hints */
.dr-keyhints {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    font-size: 12px;
    color: var(--muted-fg);
}
.dr-keyhints--vertical { flex-direction: column; gap: 5px; }
.dr-keyhints__item { display: inline-flex; align-items: center; gap: 3px; }
.dr-keyhints__label { margin-left: 4px; }
`
