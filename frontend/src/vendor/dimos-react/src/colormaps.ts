// Data colormaps (scalar → color for depth images, point clouds, heat maps; not UI colors), with no three.js, so 2D
// components can use them. src/three/gradients.js re-exports these and adds the 256×1 textures the shaders sample.

/** A ramp stop: [position 0..1, "#rrggbb"]. */
export type RampStop = [position: number, hex: string]

/** An rgb color, each channel 0..255. */
export type Rgb = [r: number, g: number, b: number]

/** A repeating palette: its menu label and its colors. */
export interface Palette {
    label: string
    colors: string[]
}

/** Stops as [position 0..1, "#rrggbb"]; piecewise-linear in sRGB. */
export const RAMPS: Record<string, RampStop[]> = {
    // MemWorld's height ramp: purple, blue, cyan, mint
    memworld: [
        [0, "#6f15b3"],
        [1 / 3, "#1b54f8"],
        [2 / 3, "#1cd0f2"],
        [1, "#90f690"],
    ],
    // Turbo, starting at its blue (the floor is usually the lowest band)
    turbo: [
        [0, "#3e5fd8"],
        [0.2, "#4675ed"],
        [0.3, "#39a2fc"],
        [0.4, "#1bcfd4"],
        [0.5, "#24eca6"],
        [0.6, "#61fc6c"],
        [0.7, "#a4fc3b"],
        [0.8, "#d1e834"],
        [0.9, "#f3c63a"],
        [1, "#fe9b2d"],
    ],
    viridis: [
        [0, "#440154"],
        [0.25, "#3b528b"],
        [0.5, "#21918c"],
        [0.75, "#5ec962"],
        [1, "#fde725"],
    ],
    magma: [
        [0, "#000004"],
        [0.25, "#51127c"],
        [0.5, "#b73779"],
        [0.75, "#fc8961"],
        [1, "#fcfdbf"],
    ],
    plasma: [
        [0, "#0d0887"],
        [0.25, "#7e03a8"],
        [0.5, "#cc4778"],
        [0.75, "#f89540"],
        [1, "#f0f921"],
    ],
    ice: [
        [0, "#0b1d3a"],
        [0.35, "#1f5f9e"],
        [0.7, "#7fc8f8"],
        [1, "#f4fbff"],
    ],
    sunset: [
        [0, "#1a1046"],
        [0.3, "#7b2d7a"],
        [0.6, "#e0565b"],
        [0.85, "#f6a04d"],
        [1, "#fde39b"],
    ],
    grayscale: [
        [0, "#1a1a1a"],
        [1, "#f2f2f2"],
    ],
}

export const GRADIENTS = Object.keys(RAMPS)
export const DEFAULT_GRADIENT = "memworld"

function hexToRgb(hex: string): Rgb {
    const value = parseInt(hex.slice(1), 16)
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

// ── repeating palettes: the colors run up and back down over every `period` meters (a ping-pong: first → last over half
// a period, then back), so a tall map shows its floors apart without one ramp stretched thin, and the repeat has no
// hue jump. Point clouds take one as `gradient` (+ `period`); its texture wraps.

/** Soft neon palettes (bright enough to glow on a dark scene); linear in sRGB between evenly spaced stops. */
export const PALETTES: Record<string, Palette> = {
    aurora: { label: "Aurora (purple → blue → cyan → green)", colors: ["#a05cf0", "#5a86f2", "#3ed4e0", "#6ee68c"] },
    ember: { label: "Ember (gold → orange → red)", colors: ["#f2c64e", "#f08c4c", "#e8565e"] },
    rose: { label: "Rose (pink → blush → white)", colors: ["#f264b0", "#f2a6cc", "#f6e8ee"] },
}
export const PALETTE_NAMES = Object.keys(PALETTES)
export const DEFAULT_PALETTE = "aurora"
/** meters of height one full up-and-back cycle spans */
export const DEFAULT_PERIOD = 9

/** True for a repeating palette's name (PALETTES), false for a ramp (RAMPS). */
export function isPalette(name: string): boolean {
    return Object.hasOwn(PALETTES, name)
}

/** Where in its cycle a height is, 0 (inclusive) to 1 (exclusive); negative heights wrap the same way. */
export function cyclePhase(height: number, period: number = DEFAULT_PERIOD): number {
    const turns = height / Math.max(1e-6, period)
    return turns - Math.floor(turns)
}

/** A palette's color at a phase (0..1, wrapping) as 0..255 rgb: first color at 0, last at 0.5, first again at 1. */
export function paletteAt(name: string, phase: number): Rgb {
    const colors = (PALETTES[name] ?? PALETTES[DEFAULT_PALETTE]).colors.map(hexToRgb)
    const wrapped = phase - Math.floor(phase)
    const along = (1 - Math.abs(2 * wrapped - 1)) * (colors.length - 1)
    const index = Math.min(colors.length - 2, Math.floor(along))
    const mix = along - index
    const [a, b] = [colors[index], colors[index + 1]]
    return [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix]
}

/** A palette's color for a height. */
export function heightColor(name: string, height: number, period: number = DEFAULT_PERIOD): Rgb {
    return paletteAt(name, cyclePhase(height, period))
}

/** The palette for another cloud beside one drawn in `taken`: the next one, so the two never match. */
export function otherPalette(taken: string): string {
    return PALETTE_NAMES[(PALETTE_NAMES.indexOf(taken) + 1) % PALETTE_NAMES.length]
}

/** The ramp's color at t (0..1) as 0..255 rgb (a palette's: at phase t). */
export function sampleGradient(name: string, t: number): Rgb {
    if (isPalette(name)) {
        return paletteAt(name, t)
    }
    const stops = RAMPS[name] ?? RAMPS[DEFAULT_GRADIENT]
    const clamped = Math.min(1, Math.max(0, t))
    for (let index = 1; index < stops.length; index++) {
        const [position, hex] = stops[index]
        if (clamped <= position) {
            const [lastPosition, lastHex] = stops[index - 1]
            const mix = (clamped - lastPosition) / (position - lastPosition || 1)
            const a = hexToRgb(lastHex)
            const b = hexToRgb(hex)
            return [a[0] + (b[0] - a[0]) * mix, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix]
        }
    }
    return hexToRgb(stops[stops.length - 1][1])
}
