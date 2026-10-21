// A depth image as a heat map on the GPU, as a three.js material (a camera's 3D projection): the raw depth goes up as a
// one-channel texture and the shader looks each pixel up in a color ramp (near = hot, far = cold); zero / NaN (no
// return) is transparent. The 2D view of the same coloring is ImageView's. Ported from dim-controller
// core/render/depth.ts.
import * as THREE from "three"
import { sampleGradient } from "../colormaps.ts"
import { depthScale } from "../components/media.tsx"

import type { DepthImage, DepthLook } from "./depth_types.ts"
export type { DepthImage, DepthLook, DepthPixels } from "./depth_types.ts"

const DEFAULT_DEPTH_LOOK: DepthLook = { colormap: "turbo", near: null, far: null }

/** Tracks the automatic range (2nd–98th percentile of valid depth, eased) so it doesn't flicker frame to frame. */
export class DepthRange {
    near = 0
    far = 1
    #seen = false
    /** @param look fixed range (meters), null = automatic */
    update(
        image: { width: number; height: number; encoding: string; data: ArrayLike<number> },
        look: { near: number | null; far: number | null },
    ): [number, number] {
        if (look.near !== null && look.near !== undefined && look.far !== null && look.far !== undefined) {
            return [look.near, look.far]
        }
        const scale = depthScale(image.encoding)
        const data = image.data
        const step = Math.max(1, Math.floor(data.length / 4096))
        const samples = []
        for (let index = 0; index < data.length; index += step) {
            const value = data[index]
            if (value > 0 && Number.isFinite(value)) {
                samples.push(value * scale)
            }
        }
        if (samples.length) {
            samples.sort((a, b) => a - b)
            const low = samples[Math.floor(samples.length * 0.02)]
            const high = samples[Math.floor(samples.length * 0.98)]
            if (!this.#seen) {
                this.near = low
                this.far = high
                this.#seen = true
            } else {
                this.near += (low - this.near) * 0.2
                this.far += (high - this.far) * 0.2
            }
        }
        const near = look.near ?? this.near
        return [near, look.far ?? Math.max(near + 0.01, this.far)]
    }
}

const RAMP_GLSL = /* glsl */ `
vec4 depthColor(float meters, vec2 range, sampler2D ramp) {
    if (!(meters > 0.0) || meters > 1e6) return vec4(0.0);
    float t = clamp((meters - range.x) / max(1e-6, range.y - range.x), 0.0, 1.0);
    return vec4(texture(ramp, vec2(1.0 - t, 0.5)).rgb, 1.0);
}
`

function rampPixels(name: string): Uint8Array {
    const pixels = new Uint8Array(256 * 4)
    for (let index = 0; index < 256; index++) {
        pixels.set([...sampleGradient(name, index / 255).map(Math.round), 255], index * 4)
    }
    return pixels
}

const asFloat = (image: DepthImage): Float32Array =>
    image.data instanceof Float32Array
        ? image.data
        : Float32Array.from(image.data.subarray(0, image.width * image.height))

const rampTextures: Map<string, THREE.DataTexture> = new Map()
function rampTexture(name: string): THREE.DataTexture {
    let texture = rampTextures.get(name)
    if (!texture) {
        texture = new THREE.DataTexture(rampPixels(name), 256, 1)
        texture.magFilter = THREE.LinearFilter
        texture.needsUpdate = true
        rampTextures.set(name, texture)
    }
    return texture
}

/** A depth texture colored the same way, as a three.js material (`.material`); `update(image, look)` per image. */
export class DepthMaterial {
    material: THREE.ShaderMaterial
    #texture: THREE.DataTexture | null = null
    #range = new DepthRange()

    constructor() {
        this.material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            transparent: true,
            side: THREE.DoubleSide,
            toneMapped: false,
            uniforms: {
                depth: { value: null },
                ramp: { value: rampTexture("turbo") },
                range: { value: new THREE.Vector2(0, 1) },
                scale: { value: 0.001 },
                opacity: { value: 1 },
            },
            vertexShader:
                /* glsl */ `out vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: /* glsl */ `
                uniform sampler2D depth;
                uniform sampler2D ramp;
                uniform vec2 range;
                uniform float scale;
                uniform float opacity;
                in vec2 vUv;
                ${RAMP_GLSL}
                void main() {
                    vec4 color = depthColor(texture(depth, vec2(vUv.x, 1.0 - vUv.y)).r * scale, range, ramp);
                    if (color.a == 0.0) discard;
                    gl_FragColor = vec4(color.rgb, opacity);
                }`,
        })
    }

    update(image: DepthImage, look: DepthLook = DEFAULT_DEPTH_LOOK) {
        const { width, height } = image
        const data = asFloat(image)
        if (!this.#texture || this.#texture.image.width !== width || this.#texture.image.height !== height) {
            this.#texture?.dispose()
            this.#texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType)
            this.material.uniforms.depth.value = this.#texture
        } else {
            this.#texture.image.data = data
        }
        this.#texture.needsUpdate = true
        const [near, far] = this.#range.update(image, look)
        this.material.uniforms.range.value.set(near, far)
        this.material.uniforms.scale.value = depthScale(image.encoding)
        this.material.uniforms.ramp.value = rampTexture(look.colormap)
    }

    dispose() {
        this.#texture?.dispose()
        this.material.dispose()
    }
}
