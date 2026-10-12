// Grass on a simulated world's height fields: blades sit on the surface, the density sets how many, and a software
// GPU is recognized (so grass starts off there).
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import * as THREE from "three"
import { bladeCount, BLADES_PER_M2, grassFor, heightAt, isSoftwareRenderer, MAX_BLADES, MAX_DENSITY, placeBlades } from "../src/core/grass.ts"

// 3 x 3 samples over 4 x 2 m, top 2 m: a ridge along x = 0 (the middle column), higher toward +y (row 2)
const field = { nrow: 3, ncol: 3, size: [2, 1, 2, 0.1], heights: [0, 0.5, 0, 0, 0.75, 0, 0, 1, 0] }

Deno.test("the surface height: samples at their cells, bilinear between, row 0 at -y and column 0 at -x", () => {
    assertAlmostEquals(heightAt(field, 0, -1), 1, 1e-9) // row 0, middle column: 0.5 * 2
    assertAlmostEquals(heightAt(field, 0, 1), 2, 1e-9) // row 2
    assertAlmostEquals(heightAt(field, 0, 0), 1.5, 1e-9)
    assertAlmostEquals(heightAt(field, -2, 0), 0, 1e-9)
    assertAlmostEquals(heightAt(field, -1, 0), 0.75, 1e-9) // halfway down the ridge
    assertAlmostEquals(heightAt(field, 9, 9), 0, 1e-9) // clamped past the corner
})

Deno.test("every blade's root is on the surface (a centimeter in), inside the field", () => {
    for (const blade of placeBlades(field, 500)) {
        assert(Math.abs(blade.x) <= 2 && Math.abs(blade.y) <= 1)
        assertAlmostEquals(blade.z, heightAt(field, blade.x, blade.y) - 0.01, 1e-9)
        assert(blade.height > 0 && blade.height < 0.36)
    }
})

Deno.test("a lower density draws a prefix of the same blades", () => {
    const many = placeBlades(field, 200)
    assertEquals(placeBlades(field, 50), many.slice(0, 50))
})

Deno.test("blade count follows area and density, capped per field", () => {
    assertEquals(bladeCount(8, 1), 8 * BLADES_PER_M2)
    assertEquals(bladeCount(8, 0.5), 4 * BLADES_PER_M2)
    assertEquals(bladeCount(1e6, 1), MAX_BLADES)
    assertEquals(bladeCount(1e6, 2), 2 * MAX_BLADES)
    assertEquals(bladeCount(8, 0), 0)
})

Deno.test("a field's grass is allocated for the top density and shows the default count", () => {
    const { mesh, area } = grassFor(field, new THREE.Color(0.3, 0.6, 0.2))
    assertEquals(area, 8)
    assertEquals(mesh.instanceMatrix.count, bladeCount(8, MAX_DENSITY))
    assertEquals(mesh.count, bladeCount(8, 1))
    assertEquals(mesh.castShadow, false)
    // never picked: raycasting it finds nothing
    const hits: THREE.Intersection[] = []
    mesh.raycast(new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1)), hits)
    assertEquals(hits.length, 0)
})

Deno.test("software GPUs are recognized; real ones aren't", () => {
    for (const name of [
        "Google SwiftShader",
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
        "llvmpipe (LLVM 15.0.7, 256 bits)",
        "Microsoft Basic Render Driver",
        "Mesa OffScreen",
    ]) {
        assert(isSoftwareRenderer(name), name)
    }
    for (const name of ["Apple M2 Pro", "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)", "NVIDIA GeForce RTX 3080/PCIe/SSE2", "Mali-G78", ""]) {
        assert(!isSoftwareRenderer(name), name)
    }
})
