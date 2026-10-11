import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { Vector3 } from "three"
import { frontObject, groundLevel, nearestCluster } from "../src/logic/locate.ts"

Deno.test("the nearest dense depth band wins over a wall behind it", () => {
    const person = Array.from({ length: 40 }, (_, index) => ({ depth: 2.4 + (index % 4) * 0.08, id: "person" }))
    const wall = Array.from({ length: 200 }, (_, index) => ({ depth: 4.0 + (index % 3) * 0.02, id: "wall" }))
    const speck = [{ depth: 1.0, id: "speck" }]
    const cluster = nearestCluster([...wall, ...speck, ...person])
    assertEquals(cluster.length, 40)
    assertEquals(new Set(cluster.map((hit) => hit.id)), new Set(["person"]))
    assertEquals(nearestCluster([]), [])
})

Deno.test("the floor is a low percentile of the nearby points", () => {
    const floor = Array.from({ length: 100 }, (_, index) => new Vector3(index * 0.03, 0, 0.01))
    const person = Array.from({ length: 50 }, (_, index) => new Vector3(2, 0, index * 0.035))
    const far = [new Vector3(50, 0, -3)]
    assertAlmostEquals(groundLevel([...floor, ...person, ...far], new Vector3()), 0.01)
    assertEquals(groundLevel([], new Vector3()), 0)
})

Deno.test("the front object is what touches the nearest band, not a chair half a metre behind it", () => {
    const person = Array.from({ length: 60 }, (_, index) => {
        const point = new Vector3(0.05 * (index % 4), 0.05 * (index % 3), 0.03 * index)
        return { point, depth: 2.5 + point.x }
    })
    const chair = Array.from({ length: 30 }, (_, index) => {
        const point = new Vector3(0.45 + 0.05 * (index % 3), 0.05 * (index % 2), 0.4 + 0.03 * (index % 10))
        return { point, depth: 2.5 + point.x }
    })
    const found = frontObject([...chair, ...person])
    assertEquals(found.length, 60)
    assert(found.every((hit) => hit.point.x < 0.2))
})
