// SVG paths for edges between placed boxes: flowing curves for the layered layouts, straight lines for the others.
import type { Box, Point } from "./layout.ts"

export type Placed = Box & Point

function side(node: Placed, after: boolean, vertical: boolean, port: number): Point {
    const sign = after ? 1 : -1
    const reach = (vertical ? node.h : node.w) / 2 + port / 2
    return vertical ? { x: node.x, y: node.y + sign * reach } : { x: node.x + sign * reach, y: node.y }
}

/** From the right (bottom, when vertical) of `from` to the left (top) of `to`, along the bends a layered layout gave. */
export function flowPath(from: Placed, to: Placed, bends: Point[], vertical: boolean, port = 0): string {
    const uv = (p: Point) => (vertical ? { u: p.y, v: p.x } : { u: p.x, v: p.y })
    const xy = (u: number, v: number) => (vertical ? `${v} ${u}` : `${u} ${v}`)
    const a = uv(side(from, true, vertical, port))
    const b = uv(side(to, false, vertical, port))
    if (!bends.length) {
        const half = Math.max(Math.abs(b.u - a.u) / 2, 30)
        return `M${xy(a.u, a.v)} C${xy(a.u + half, a.v)} ${xy(b.u - half, b.v)} ${xy(b.u, b.v)}`
    }
    const track = bends.map((p) => uv(p).v).sort((m, n) => m - n)[Math.floor(bends.length / 2)]
    const forward = b.u > a.u
    const r = Math.max(32, Math.min(110, forward ? Math.abs(b.u - a.u) / 3 : 80))
    let d = `M${xy(a.u, a.v)}`
    if (forward) {
        d += ` C${xy(a.u + r / 2, a.v)} ${xy(a.u + r / 2, track)} ${xy(a.u + r, track)}`
        d += ` L${xy(b.u - r, track)}`
        d += ` C${xy(b.u - r / 2, track)} ${xy(b.u - r / 2, b.v)} ${xy(b.u, b.v)}`
    } else {
        d += ` C${xy(a.u + r, a.v)} ${xy(a.u + r, track)} ${xy(a.u, track)}`
        d += ` L${xy(b.u, track)}`
        d += ` C${xy(b.u - r, track)} ${xy(b.u - r, b.v)} ${xy(b.u, b.v)}`
    }
    return d
}

function exit(node: Placed, toward: Point): Point {
    const dx = toward.x - node.x
    const dy = toward.y - node.y
    const scale = 1 / Math.max(Math.abs(dx) / (node.w / 2) || 0, Math.abs(dy) / (node.h / 2) || 0, 1e-6)
    return { x: node.x + dx * Math.min(scale, 1), y: node.y + dy * Math.min(scale, 1) }
}

/** A straight line between the two boxes' borders. */
export function straightPath(from: Placed, to: Placed): string {
    const a = exit(from, to)
    const b = exit(to, from)
    return `M${a.x} ${a.y} L${b.x} ${b.y}`
}

let measurer: CanvasRenderingContext2D | null = null

/** The width `text` takes in a CSS `font`, for sizing boxes before they render. */
export function textWidth(text: string, font: string): number {
    measurer ??= document.createElement("canvas").getContext("2d")!
    measurer.font = font
    return measurer.measureText(text).width
}
