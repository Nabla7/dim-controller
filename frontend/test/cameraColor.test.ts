// Camera colors on points: the patch finds its place in dimos-react's real point shader (a dimos-react upgrade that moves
// those lines fails here, not in the browser), and CameraInfo becomes the lens model the shader takes.
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "jsr:@std/assert@1"
import * as THREE from "three"
import { makePointMaterial } from "dimos-react/three"
import { addCameraColor, cameraModel, distortRay, pixelRay } from "../src/core/render/cameraColor.ts"

Deno.test("the camera color patch lands in dimos-react's point shader", () => {
    const material = makePointMaterial({ value: 100 })
    const uniforms = addCameraColor(material)
    assert(material.vertexShader.includes("bool camPixel(vec3 c, out vec2 px)"))
    // after the gradient color, so a voxel the camera sees overrides it
    assert(material.vertexShader.indexOf("if (uCamColor == 1)") > material.vertexShader.indexOf("vColor = uColorMode == 3"))
    assertEquals(material.uniforms.uCamColor, uniforms.uCamColor)
    assertThrows(() => addCameraColor(new THREE.ShaderMaterial({ vertexShader: "void main() {}" })))
})

Deno.test("CameraInfo becomes a lens model", () => {
    const info = { width: 1920, height: 1536, K: [600, 0, 960, 0, 610, 768, 0, 0, 1], D: [0.3, -0.05, 0.001, -0.002, 0.01], distortion_model: "plumb_bob" }
    assertEquals(cameraModel(info), { width: 1920, height: 1536, K: [600, 610, 960, 768], D: [0.3, -0.05, 0.001, -0.002, 0.01, 0, 0, 0], equidistant: false })
    assertEquals(cameraModel({ ...info, distortion_model: "equidistant" })?.equidistant, true)
    assertEquals(cameraModel({ ...info, K: [] }), null)
})

// cv2.undistortPointsIter / cv2.fisheye.undistortPoints on the same models (scratch script, OpenCV 4.13), away from the rim
const PIXELS = [[960, 768], [500, 1200], [1500, 300]]
const OPENCV = {
    rational: [[0, 0], [-1.1605651932416379, 1.0752868800967716], [1.5372548601721974, -1.3055929256456575]],
    fisheye: [[0, 0], [-1.0679678869286002, 0.9865191599853641], [1.4321428659168196, -1.220843098814338]],
}

Deno.test("a pixel's ray matches OpenCV's undistortion, and goes back to that pixel", () => {
    const base = { width: 1920, height: 1536, K: [600, 0, 960, 0, 610, 768, 0, 0, 1] }
    const rational = cameraModel({ ...base, D: [0.3, -0.05, 0.001, -0.002, 0.01, 0.6, -0.02, 0.005], distortion_model: "rational_polynomial" })!
    const fisheye = cameraModel({ ...base, D: [0.1, -0.02, 0.003, -0.001], distortion_model: "equidistant" })!
    PIXELS.forEach(([u, v], index) => {
        for (const [model, expected] of [[rational, OPENCV.rational[index]], [fisheye, OPENCV.fisheye[index]]] as const) {
            const ray = pixelRay(model, u, v)!
            assertAlmostEquals(ray[0], expected[0], 1e-6)
            assertAlmostEquals(ray[1], expected[1], 1e-6)
        }
    })
    // the corner of a strong lens: either no ray or one that maps back to it
    for (const model of [rational, fisheye]) {
        const ray = pixelRay(model, 100, 100)
        if (ray) {
            const [u, v] = distortRay(model, ray[0], ray[1])
            assertAlmostEquals(u, 100, 0.5)
            assertAlmostEquals(v, 100, 0.5)
        }
    }
})
