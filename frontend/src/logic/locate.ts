// The geometry behind locating an object from a box in the camera image (agent.ts): the floor's height and the
// front-most object among the lidar points that fall inside the box.
import type * as THREE from "three"

/** The floor's height near the camera: a low percentile of the points within 5 m (0 without points). */
export function groundLevel(points: THREE.Vector3[], near: THREE.Vector3): number {
    const heights = points.filter((point) => Math.hypot(point.x - near.x, point.y - near.y) < 5).map((point) => point.z).sort((a, b) => a - b)
    if (heights.length < 20) {
        return 0
    }
    return heights[Math.floor(heights.length * 0.02)]
}

/** The hits of the nearest dense depth band (10 cm bins; a band ends at a 30 cm gap), i.e. the front object. */
export function nearestCluster<T extends { depth: number }>(hits: T[]): T[] {
    if (!hits.length) {
        return []
    }
    const sorted = [...hits].sort((a, b) => a.depth - b.depth)
    const needed = Math.max(5, Math.floor(sorted.length * 0.08))
    const bins = new Map<number, number>()
    for (const hit of sorted) {
        const bin = Math.floor(hit.depth / 0.1)
        bins.set(bin, (bins.get(bin) ?? 0) + 1)
    }
    // the first band with enough points, from its first bin until a gap
    const order = [...bins.keys()].sort((a, b) => a - b)
    let start = 0
    while (start < order.length) {
        let end = start
        let count = bins.get(order[start])!
        while (end + 1 < order.length && order[end + 1] - order[end] <= 3) {
            end++
            count += bins.get(order[end])!
        }
        if (count >= needed) {
            const near = order[start] * 0.1
            const far = (order[end] + 1) * 0.1
            return sorted.filter((hit) => hit.depth >= near && hit.depth < far)
        }
        start = end + 1
    }
    return []
}

/** The object the front of the nearest band belongs to: hits connected (within `radius`) to the band's first 25 cm. */
export function frontObject<T extends { depth: number; point: THREE.Vector3 }>(hits: T[], radius = 0.15): T[] {
    const band = nearestCluster(hits)
    if (!band.length) {
        return []
    }
    const front = band[0].depth + 0.25
    const taken = new Set<number>()
    const queue: number[] = []
    hits.forEach((hit, index) => {
        if (band.includes(hit) && hit.depth <= front) {
            taken.add(index)
            queue.push(index)
        }
    })
    while (queue.length) {
        const current = hits[queue.pop()!].point
        hits.forEach((hit, index) => {
            if (!taken.has(index) && hit.point.distanceTo(current) <= radius) {
                taken.add(index)
                queue.push(index)
            }
        })
    }
    return hits.filter((_, index) => taken.has(index))
}
