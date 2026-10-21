// Colors a point layer's voxels with a live camera picture: each voxel center goes into the camera frame (TF, latest),
// through the camera's lens model (CameraInfo K and D: plumb_bob, rational_polynomial or equidistant) to a pixel, and
// takes that pixel's color if nothing nearer covers it. "Nearer" comes from a depth pre-pass: the same points drawn from
// the camera into a small float target, each splatted over the pixels its voxel covers, nearest distance kept.
import * as THREE from "three"

/** A camera's projection, from its CameraInfo. */
export interface CameraModel {
    width: number
    height: number
    /** fx, fy, cx, cy */
    K: [number, number, number, number]
    /** k1 k2 p1 p2 k3 k4 k5 k6 (plumb_bob / rational_polynomial) or k1 k2 k3 k4 (equidistant), zero-padded */
    D: number[]
    equidistant: boolean
}

export function cameraModel(
    info: { width?: number; height?: number; K?: number[]; D?: number[]; distortion_model?: string },
): CameraModel | null {
    const K = info.K ?? []
    if (!info.width || !info.height || !K[0]) {
        return null
    }
    const D = [...(info.D ?? [])].slice(0, 8)
    while (D.length < 8) {
        D.push(0)
    }
    return {
        width: info.width,
        height: info.height,
        K: [K[0], K[4], K[2], K[5]],
        D,
        equidistant: info.distortion_model === "equidistant",
    }
}

/** The camera-color uniforms, shared by the point material and the depth pre-pass. */
export function cameraUniforms() {
    return {
        uCamColor: { value: 0 },
        uCamFromWorld: { value: new THREE.Matrix4() },
        uCamK: { value: new THREE.Vector4(1, 1, 0, 0) },
        uCamD: { value: new Array(8).fill(0) },
        uCamEquidistant: { value: 0 },
        uCamSize: { value: new THREE.Vector2(1, 1) },
        uCamImage: { value: null as THREE.Texture | null },
        uCamDepth: { value: null as THREE.Texture | null },
        uCamTolerance: { value: 0.08 },
        uCamMaxRadius: { value: 0 },
        uCamNear: { value: 0.3 },
        uCamFar: { value: 30 },
    }
}

export type CameraUniforms = ReturnType<typeof cameraUniforms>

const projectGlsl = /* glsl */ `
uniform mat4 uCamFromWorld;
uniform vec4 uCamK;
uniform float uCamD[8];
uniform int uCamEquidistant;
uniform vec2 uCamSize;
uniform float uCamMaxRadius;
uniform float uCamNear;
uniform float uCamFar;

// the pixel a camera-frame point (optical: z forward) lands on, through the lens model; false when it doesn't land
bool camPixel(vec3 c, out vec2 px) {
    if (c.z < uCamNear || c.z > uCamFar) return false;
    vec2 n = c.xy / c.z;
    vec2 d;
    if (uCamEquidistant == 1) {
        float r = length(n);
        float th = atan(r);
        float t2 = th * th;
        float thd = th * (1.0 + t2 * (uCamD[0] + t2 * (uCamD[1] + t2 * (uCamD[2] + t2 * uCamD[3]))));
        d = r > 1e-8 ? n * (thd / r) : n;
    } else {
        float r2 = dot(n, n);
        float radial = (1.0 + r2 * (uCamD[0] + r2 * (uCamD[1] + r2 * uCamD[4]))) / (1.0 + r2 * (uCamD[5] + r2 * (uCamD[6] + r2 * uCamD[7])));
        d = n * radial + vec2(2.0 * uCamD[2] * n.x * n.y + uCamD[3] * (r2 + 2.0 * n.x * n.x), uCamD[2] * (r2 + 2.0 * n.y * n.y) + 2.0 * uCamD[3] * n.x * n.y);
    }
    px = vec2(uCamK.x * d.x + uCamK.z, uCamK.y * d.y + uCamK.w);
    if (any(lessThan(px, vec2(0.0))) || any(greaterThanEqual(px, uCamSize))) return false;
    // past the lens' good circle (a fisheye's dark rim) a pixel isn't trusted
    if (uCamMaxRadius > 0.0 && distance(px, uCamK.zw) > uCamMaxRadius) return false;
    return true;
}
`

/** The lines the point material's vertex shader gets: after its own color, the camera's where the camera sees the voxel. */
const colorGlsl = /* glsl */ `
    if (uCamColor == 1) {
        vec3 cam = (uCamFromWorld * vec4(center, 1.0)).xyz;
        vec2 camPx;
        if (camPixel(cam, camPx)) {
            vec2 camUv = vec2(camPx.x / uCamSize.x, 1.0 - camPx.y / uCamSize.y);
            float nearest = texture2D(uCamDepth, camUv).r;
            if (length(cam) <= nearest + uCamTolerance) {
                vColor = texture2D(uCamImage, camUv).rgb;
            }
        }
    }
`

const COLOR_LINE = "vColor = uColorMode == 3 ? uSolid : texture2D(uGradient, vec2(t, 0.5)).rgb;"
const MAIN_LINE = "void main() {"

/**
 * Adds camera coloring to a dimos-react point material (makePointMaterial): its uniforms, and the projection after the
 * line that sets the gradient color. Off (uCamColor 0) it costs one branch per point.
 */
export function addCameraColor(material: THREE.ShaderMaterial): CameraUniforms {
    const shader = material.vertexShader
    if (!shader.includes(COLOR_LINE) || !shader.includes(MAIN_LINE)) {
        throw new Error("camera color: the point shader changed; addCameraColor's anchors need updating")
    }
    const uniforms = cameraUniforms()
    material.vertexShader = shader
        .replace(
            MAIN_LINE,
            `uniform int uCamColor;\nuniform sampler2D uCamImage;\nuniform sampler2D uCamDepth;\nuniform float uCamTolerance;\n${projectGlsl}\n${MAIN_LINE}`,
        )
        .replace(COLOR_LINE, `${COLOR_LINE}\n${colorGlsl}`)
    Object.assign(material.uniforms, uniforms)
    material.needsUpdate = true
    return uniforms
}

const depthVertex = /* glsl */ `
uniform float uSize;
uniform int uSnap;
uniform float uScale;
varying float vDist;
${projectGlsl}
void main() {
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 center = uSnap == 1 ? (floor(world / uSize) + 0.5) * uSize : world;
    vec3 cam = (uCamFromWorld * vec4(center, 1.0)).xyz;
    vec2 px;
    if (!camPixel(cam, px)) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 0.0;
        return;
    }
    vDist = length(cam);
    // pixel (v down) to clip space (y up); nearer voxels win the depth test
    vec2 ndc = vec2(px.x / uCamSize.x, 1.0 - px.y / uCamSize.y) * 2.0 - 1.0;
    gl_Position = vec4(ndc, clamp(vDist / uCamFar, 0.0, 1.0) * 2.0 - 1.0, 1.0);
    // the voxel's footprint in target pixels, so a near surface hides what's behind it
    gl_PointSize = clamp(uSize * uCamK.x * uScale / cam.z, 1.0, 32.0);
}
`

const depthFragment = /* glsl */ `
varying float vDist;
void main() {
    gl_FragColor = vec4(vDist, 0.0, 0.0, 1.0);
}
`

const NOTHING_NEAR = new THREE.Color(65000, 0, 0)

/**
 * The depth pre-pass: the layer's points drawn from the camera into a float target a quarter of the camera's size,
 * each pixel keeping the nearest voxel's distance. Its texture is the point material's uCamDepth.
 */
export class CameraDepthPass {
    readonly target = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
    })
    readonly material: THREE.ShaderMaterial
    readonly #points: THREE.Points
    readonly #scene = new THREE.Scene()
    readonly #camera = new THREE.Camera()
    readonly #clear = new THREE.Color()

    /** @param scale the target's size against the camera's (a quarter by default) */
    constructor(uniforms: CameraUniforms, readonly scale = 0.25) {
        this.material = new THREE.ShaderMaterial({
            vertexShader: depthVertex,
            fragmentShader: depthFragment,
            uniforms: { ...uniforms, uSize: { value: 0.05 }, uSnap: { value: 0 }, uScale: { value: scale } },
        })
        this.#points = new THREE.Points(new THREE.BufferGeometry(), this.material)
        this.#points.frustumCulled = false
        this.#points.matrixAutoUpdate = false
        this.#scene.add(this.#points)
    }

    /** Draws `source`'s points (its geometry and placement) into the target and returns the target's texture. */
    render(
        renderer: THREE.WebGLRenderer,
        source: THREE.Points,
        voxelSize: number,
        snap: boolean,
        model: CameraModel,
    ): THREE.Texture {
        const width = Math.max(1, Math.round(model.width * this.scale))
        const height = Math.max(1, Math.round(model.height * this.scale))
        if (this.target.width !== width || this.target.height !== height) {
            this.target.setSize(width, height)
        }
        this.#points.geometry = source.geometry
        this.#points.matrix.copy(source.matrixWorld)
        this.#points.matrixWorldNeedsUpdate = true
        this.material.uniforms.uSize.value = voxelSize
        this.material.uniforms.uSnap.value = snap ? 1 : 0
        const previous = renderer.getRenderTarget()
        const previousAlpha = renderer.getClearAlpha()
        renderer.getClearColor(this.#clear)
        renderer.setRenderTarget(this.target)
        // nothing drawn: no voxel there, so any distance passes
        renderer.setClearColor(NOTHING_NEAR, 1)
        renderer.clear(true, true, false)
        renderer.render(this.#scene, this.#camera)
        renderer.setRenderTarget(previous)
        renderer.setClearColor(this.#clear, previousAlpha)
        return this.target.texture
    }

    dispose() {
        this.target.dispose()
        this.material.dispose()
    }
}

/** Points the uniforms at a camera model. */
export function setCameraModel(uniforms: CameraUniforms, model: CameraModel) {
    uniforms.uCamK.value.set(...model.K)
    uniforms.uCamD.value = model.D
    uniforms.uCamEquidistant.value = model.equidistant ? 1 : 0
    uniforms.uCamSize.value.set(model.width, model.height)
}

/**
 * Where a pixel's ray goes: (x, y) on the camera's z = 1 plane (optical frame), the lens model inverted the way
 * cv2.undistortPoints does it (fixed-point iteration; Newton on the angle for equidistant). Null past where the model
 * stops being invertible (a fisheye's rim).
 */
export function undistortPixel(model: CameraModel, u: number, v: number): [number, number] | null {
    const [fx, fy, cx, cy] = model.K
    const [k1, k2, p1, p2, k3, k4, k5, k6] = model.D
    const xd = (u - cx) / fx
    const yd = (v - cy) / fy
    if (model.equidistant) {
        const thetaD = Math.hypot(xd, yd)
        if (thetaD < 1e-12) {
            return [xd, yd]
        }
        // D is k1..k4 here: theta_d = theta (1 + k1 theta^2 + k2 theta^4 + k3 theta^6 + k4 theta^8)
        const [e1, e2, e3, e4] = [k1, k2, p1, p2]
        // OpenCV's fisheye iteration: theta = theta_d / (1 + k1 theta^2 + ...)
        let theta = Math.min(thetaD, Math.PI / 2)
        for (let step = 0; step < 50; step++) {
            const t2 = theta * theta
            theta = thetaD / (1 + t2 * (e1 + t2 * (e2 + t2 * (e3 + t2 * e4))))
        }
        if (!(theta > 0 && theta < Math.PI / 2)) {
            return null
        }
        const scale = Math.tan(theta) / thetaD
        return [xd * scale, yd * scale]
    }
    let x = xd
    let y = yd
    // fixed-point iteration, as cv2.undistortPointsIter; a strong lens' corners take many rounds
    for (let step = 0; step < 500; step++) {
        const r2 = x * x + y * y
        const inverse = (1 + r2 * (k4 + r2 * (k5 + r2 * k6))) / (1 + r2 * (k1 + r2 * (k2 + r2 * k3)))
        if (!(inverse > 0)) {
            return null
        }
        const dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
        const dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
        x = (xd - dx) * inverse
        y = (yd - dy) * inverse
    }
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}

/** The pixel a camera-frame direction (x, y on the z = 1 plane) lands on: the shader's camPixel, in JS. */
export function distortRay(model: CameraModel, x: number, y: number): [number, number] {
    const [fx, fy, cx, cy] = model.K
    const [k1, k2, p1, p2, k3, k4, k5, k6] = model.D
    if (model.equidistant) {
        const r = Math.hypot(x, y)
        const theta = Math.atan(r)
        const t2 = theta * theta
        const thetaD = theta * (1 + t2 * (k1 + t2 * (k2 + t2 * (p1 + t2 * p2))))
        const scale = r > 1e-12 ? thetaD / r : 1
        return [fx * x * scale + cx, fy * y * scale + cy]
    }
    const r2 = x * x + y * y
    const radial = (1 + r2 * (k1 + r2 * (k2 + r2 * k3))) / (1 + r2 * (k4 + r2 * (k5 + r2 * k6)))
    const dx = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
    const dy = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
    return [fx * dx + cx, fy * dy + cy]
}

/**
 * The pixel's ray if the lens model maps it back to that same pixel (within half a pixel): a strong lens' rim has rays
 * that don't, or several that do, and those pixels are left out.
 */
export function pixelRay(model: CameraModel, u: number, v: number): [number, number] | null {
    const ray = undistortPixel(model, u, v)
    if (!ray) {
        return null
    }
    const [pu, pv] = distortRay(model, ray[0], ray[1])
    return Math.hypot(pu - u, pv - v) < 0.5 ? ray : null
}

/** grid columns of the curved picture (rows follow the aspect) */
const CURVED_COLUMNS = 64
/** rays further out than this on the z = 1 plane (past ~76°) are a fisheye's rim: left out */
const MAX_RAY_SLOPE = 4

/**
 * The picture on a curved surface: a grid over the image, each vertex on its pixel's own ray (the lens model inverted)
 * at `distance` meters, so straight edges in the room stay straight. Grid cells with a corner past the lens' usable
 * rim are left out.
 */
export function curvedPicture(model: CameraModel, distance: number): THREE.BufferGeometry {
    const columns = CURVED_COLUMNS
    const rows = Math.max(2, Math.round((columns * model.height) / model.width))
    const positions: number[] = []
    const uvs: number[] = []
    const valid: boolean[] = []
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            const u = (column / (columns - 1)) * (model.width - 1)
            const v = (row / (rows - 1)) * (model.height - 1)
            const ray = pixelRay(model, u, v)
            const ok = !!ray && Math.abs(ray[0]) < MAX_RAY_SLOPE && Math.abs(ray[1]) < MAX_RAY_SLOPE
            const [x, y] = ok ? ray! : [0, 0]
            const scale = distance / Math.hypot(x, y, 1)
            positions.push(x * scale, y * scale, scale)
            uvs.push(u / (model.width - 1), 1 - v / (model.height - 1))
            valid.push(ok)
        }
    }
    const index: number[] = []
    for (let row = 0; row + 1 < rows; row++) {
        for (let column = 0; column + 1 < columns; column++) {
            const a = row * columns + column
            const [b, c, e] = [a + 1, a + columns, a + columns + 1]
            if (valid[a] && valid[b] && valid[c] && valid[e]) {
                index.push(a, c, b, b, c, e)
            }
        }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(index)
    return geometry
}
