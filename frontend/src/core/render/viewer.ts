// The three.js view: one renderer, a ROS-convention (Z up) scene in the fixed frame, orbit/follow camera, a 2D
// label overlay, and a render loop that only draws when something changed. It also keeps the latency numbers.
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js"
import { Store } from "../store.ts"
import { focusDistance, splatBackground } from "./pointMaterial.ts"
import { themeColors } from "../../dim-app/source/theme.js"
import { FRAME_BUDGET_MS, splatFallback } from "./rendering.ts"
import { CATCH_UP_SECONDS, PanGate, SmoothFollow } from "./follow.ts"

export interface RenderStats {
    fps: number
    /** CPU time of one frame: layer updates + render submit (ms, mean) */
    frameMs: number
    /** bridge timestamp → the frame that drew it (ms, p50 / p95 over the last second) */
    latencyP50: number | null
    latencyP95: number | null
    /** message arrival in the page → the frame that drew it (ms, p50) */
    arrivalToFrameMs: number | null
    drawCalls: number
    points: number
}

export interface FrameInfo {
    /** performance.now() of this frame */
    now: number
    fixedFrame: string
    camera: THREE.PerspectiveCamera
}

export type FrameListener = (frame: FrameInfo) => void

/** The canvas renders at the screen's resolution, up to 2× (beyond that the extra pixels cost more than they show). */
const pixelRatio = () => Math.min(2, devicePixelRatio || 1)

export class Viewer {
    /** null when the browser couldn't start WebGL: the scene still updates but nothing draws (`webglError` says why) */
    readonly renderer: THREE.WebGLRenderer | null
    readonly webglError: string | null
    /** what the view draws into and takes pointer input on: the renderer's canvas, or a blank one without WebGL */
    readonly canvas: HTMLCanvasElement
    readonly labels: CSS2DRenderer
    readonly scene = new THREE.Scene()
    readonly camera = new THREE.PerspectiveCamera(60, 1, 0.05, 10000)
    readonly controls: OrbitControls
    readonly stats = new Store<RenderStats>({ fps: 0, frameMs: 0, latencyP50: null, latencyP95: null, arrivalToFrameMs: null, drawCalls: 0, points: 0 })
    /** world units → pixels at 1 m depth; point shaders size by it */
    readonly pixelsPerMeter = { value: 1 }
    /** view size in CSS pixels; thick-line materials share it (their widths are CSS pixels) */
    readonly resolution = new THREE.Vector2(1, 1)
    fixedFrame = "world"
    /** where the camera follows (a TF frame); set by the app each frame */
    followTarget: THREE.Vector3 | null = null
    /** this page stopped following because the user panned away (or the agent looked elsewhere); `resumeFollow()` ends it */
    readonly followPaused = new Store<{ paused: boolean }>({ paused: false })

    #host: HTMLElement
    #dirty = true
    #listeners = new Set<FrameListener>()
    #grid: THREE.GridHelper
    #frameTimes: number[] = []
    #cpuTimes: number[] = []
    #pendingData: { bridgeTs: number; arrival: number }[] = []
    #latencies: number[] = []
    #arrivals: number[] = []
    #lastStats = 0
    #lastDeclutter = 0
    #slowSeconds = 0
    #bridgeNow: () => number
    #follow = new SmoothFollow()
    #lastFollow = new THREE.Vector3()
    #following = false
    #followDelta = new THREE.Vector3()
    /** after a resume: the target glides onto the followed point, keeping the angle and zoom */
    #catchingUp = false
    #panGate = new PanGate()
    #beforeControls = new THREE.Vector3()
    #pan = new THREE.Vector3()
    #reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null
    #lastFrame = 0

    constructor(host: HTMLElement, bridgeNow: () => number) {
        this.#host = host
        this.#bridgeNow = bridgeNow
        // no MSAA (as MemWorld): it nearly doubled the cost of blended splats at 2880×1800
        let renderer: THREE.WebGLRenderer | null = null
        try {
            renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" })
            renderer.setPixelRatio(pixelRatio())
            renderer.setClearColor(0x000000, 0)
        } catch (error) {
            console.warn("3D view: WebGL unavailable", error)
        }
        this.renderer = renderer
        this.webglError = renderer ? null : "this browser couldn't start WebGL"
        this.canvas = renderer?.domElement ?? document.createElement("canvas")
        host.appendChild(this.canvas)
        this.labels = new CSS2DRenderer()
        this.labels.domElement.className = "label-layer"
        this.labels.domElement.dataset.sceneLabels = "" // labels pinned to 3D points: they leave the screen with them
        host.appendChild(this.labels.domElement)

        this.camera.up.set(0, 0, 1)
        this.camera.position.set(-6, -6, 5)
        this.controls = new OrbitControls(this.camera, this.canvas)
        this.controls.enableDamping = true
        this.controls.dampingFactor = 0.18
        this.controls.screenSpacePanning = false
        this.controls.maxPolarAngle = Math.PI * 0.495
        this.controls.addEventListener("change", () => this.requestRender())
        this.controls.addEventListener("start", () => this.#panGate.start())

        this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x202830, 1.6))
        const sun = new THREE.DirectionalLight(0xffffff, 1.2)
        sun.position.set(5, 3, 10)
        this.scene.add(sun)
        this.#grid = this.#makeGrid(true)
        this.scene.add(this.#grid)

        new ResizeObserver(() => this.#resize()).observe(host)
        this.#watchPixelRatio()
        this.#resize()
        requestAnimationFrame(this.#loop)
    }

    #makeGrid(dark: boolean): THREE.GridHelper {
        // the theme's --scene-grid-major / --scene-grid (Portal: violet-black lines on the void; Research: warm hairlines on paper)
        const colors = themeColors()
        const grid = new THREE.GridHelper(200, 200, new THREE.Color(colors.sceneGridMajor || (dark ? "#2a2734" : "#c8c6bb")), new THREE.Color(colors.sceneGrid || (dark ? "#1a1822" : "#dcdad0")))
        grid.rotation.x = Math.PI / 2
        const material = grid.material as THREE.Material
        material.transparent = true
        material.opacity = dark ? 0.7 : 0.55
        return grid
    }

    /** Grid, fog and light for a dark or light page (the background itself is CSS behind the transparent canvas). */
    setTheme(dark: boolean) {
        this.scene.remove(this.#grid)
        this.#grid.geometry.dispose()
        ;(this.#grid.material as THREE.Material).dispose()
        this.#grid = this.#makeGrid(dark)
        this.scene.add(this.#grid)
        // light: the far grid fades into the page; dark: no fog, like MemWorld (scene.js)
        const background = themeColors().sceneBg || (dark ? "#05070d" : "#f5f4ef")
        this.scene.fog = dark ? null : new THREE.Fog(new THREE.Color(background), 40, 110)
        splatBackground.setStyle(background, THREE.NoColorSpace)
        this.requestRender()
    }

    /** Hides scene labels that overlap a more important one (frame names give way to data labels, then to the nearer). */
    #declutter() {
        const elements = [...this.labels.domElement.querySelectorAll<HTMLElement>(".scene-label")].filter((element) => element.style.display !== "none")
        const placed: DOMRect[] = []
        const ranked = elements
            .map((element) => ({ element, rect: element.getBoundingClientRect(), minor: element.classList.contains("frame-label") }))
            .sort((a, b) => Number(a.minor) - Number(b.minor))
        for (const { element, rect } of ranked) {
            const hit = placed.some((other) => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top)
            element.classList.toggle("covered", hit)
            if (!hit) {
                placed.push(rect)
            }
        }
    }

    requestRender() {
        this.#dirty = true
    }

    /** Layers call this when a message changed what's drawn; the next frame both draws it and times it. */
    noteData(bridgeTimestampMs: number) {
        this.#pendingData.push({ bridgeTs: bridgeTimestampMs, arrival: performance.now() })
        this.#dirty = true
    }

    onFrame(listener: FrameListener): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    /**
     * The point in the scene (the fixed frame) under a screen point (client px): the nearest drawn cloud point within a
     * few pixels of the ray or the nearest mesh hit (a map plane, a marker), else where the ray meets the ground (z = 0).
     * Null when the ray misses everything and points away from the ground.
     */
    pick(clientX: number, clientY: number): { point: THREE.Vector3; on: "points" | "mesh" | "ground" } | null {
        const rect = this.canvas.getBoundingClientRect()
        const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
        const raycaster = new THREE.Raycaster()
        raycaster.setFromCamera(ndc, this.camera)
        const { origin, direction } = raycaster.ray
        // a cloud point counts within PICK_PX pixels of the ray: that's a cone of this slope
        const PICK_PX = 6
        const slope = (PICK_PX * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 2) / Math.max(1, rect.height)
        type Hit = { distance: number; point: THREE.Vector3; on: "points" | "mesh" }
        // `as`: assigned inside visit(), which TS's narrowing can't see
        let best = null as Hit | null
        const meshes: THREE.Object3D[] = []
        const point = new THREE.Vector3()
        const offset = new THREE.Vector3()
        const visit = (object: THREE.Object3D) => {
            if (!object.visible || object.userData.noPick) {
                return
            }
            if ((object as THREE.Points).isPoints) {
                const geometry = (object as THREE.Points).geometry
                const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined
                if (position) {
                    const end = Math.min(position.count, geometry.drawRange.start + geometry.drawRange.count)
                    const array = position.array as ArrayLike<number>
                    const world = object.matrixWorld
                    for (let index = geometry.drawRange.start; index < end; index++) {
                        point.set(array[index * 3], array[index * 3 + 1], array[index * 3 + 2]).applyMatrix4(world)
                        offset.subVectors(point, origin)
                        const along = offset.dot(direction)
                        if (along <= this.camera.near || (best && along >= best.distance)) {
                            continue
                        }
                        const away = offset.addScaledVector(direction, -along).length()
                        if (away <= along * slope) {
                            best = { distance: along, point: point.clone(), on: "points" }
                        }
                    }
                }
            } else if ((object as THREE.Mesh).isMesh) {
                meshes.push(object)
            }
            for (const child of object.children) {
                visit(child)
            }
        }
        this.scene.updateMatrixWorld()
        visit(this.scene)
        const hit = raycaster.intersectObjects(meshes, false)[0]
        if (hit && (!best || hit.distance < best.distance)) {
            best = { distance: hit.distance, point: hit.point.clone(), on: "mesh" }
        }
        if (best) {
            return { point: best.point, on: best.on }
        }
        const ground = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3())
        return ground ? { point: ground, on: "ground" } : null
    }

    /**
     * Looks at `target` from the current direction, `distance` away; from straight above (after a top-down) it goes
     * back to the default three-quarter view, since keeping that direction would just stay top-down.
     */
    frame(target: THREE.Vector3, distance: number) {
        const direction = this.camera.position.clone().sub(this.controls.target).normalize()
        if (!Number.isFinite(direction.x) || direction.lengthSq() === 0 || direction.z > 0.97) {
            direction.set(-1, -1, 0.9).normalize()
        }
        this.#place(target, target.clone().addScaledVector(direction, distance))
    }

    /** Straight down onto `target` from high enough that `extent` meters fit the shorter side of the view. */
    topDown(target: THREE.Vector3, extent: number) {
        const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2
        const fit = Math.min(1, this.camera.aspect)
        const height = (extent / 2 / Math.tan(halfFov) / fit) * 1.1
        // a hair south of overhead, so "up" on screen is +y (orbit controls can't look exactly along their up axis)
        this.#place(target, new THREE.Vector3(target.x, target.y - height * 0.002, target.z + height))
    }

    /** Puts the camera at `position` looking at `target` now: nothing left over from a drag's damping, no follow glide. */
    #place(target: THREE.Vector3, position: THREE.Vector3) {
        const controls = this.controls as unknown as { _sphericalDelta?: THREE.Spherical; _panOffset?: THREE.Vector3; _scale?: number }
        controls._sphericalDelta?.set(0, 0, 0)
        controls._panOffset?.set(0, 0, 0)
        if (controls._scale !== undefined) {
            controls._scale = 1
        }
        this.controls.target.copy(target)
        this.camera.position.copy(position)
        this.camera.lookAt(target)
        this.controls.update()
        this.#following = false
        this.#follow.reset()
        this.requestRender()
    }

    /** Stops following until `resumeFollow()`: the camera stays where it is. */
    pauseFollow() {
        if (!this.followPaused.get().paused) {
            this.followPaused.set({ paused: true })
        }
    }

    /** Follows again: the followed point glides back to the middle (snaps, with reduced motion), angle and zoom kept. */
    resumeFollow() {
        this.#catchingUp = true
        this.#following = false
        this.#follow.reset()
        if (this.followPaused.get().paused) {
            this.followPaused.set({ paused: false })
        }
        this.requestRender()
    }

    /**
     * Where the drawn data is (point clouds and meshes, not the grid or helpers): the 2nd-98th percentile box of a
     * sample of their points, so a few far-off returns don't stretch it. Null when nothing is drawn.
     */
    dataBounds(): THREE.Box3 | null {
        const xs: number[] = [], ys: number[] = [], zs: number[] = []
        const point = new THREE.Vector3()
        this.scene.updateMatrixWorld()
        this.scene.traverseVisible((object) => {
            // fat lines are meshes of a template quad, not of their points: leave them out
            const fat = (object as { isLineSegments2?: boolean }).isLineSegments2
            const drawn = (object as THREE.Points).isPoints || ((object as THREE.Mesh).isMesh && !fat)
            if (!drawn || object.userData.noPick) {
                return
            }
            const geometry = (object as THREE.Points).geometry
            const position = geometry?.getAttribute("position") as THREE.BufferAttribute | undefined
            if (!position) {
                return
            }
            const start = geometry.drawRange.start
            const end = Math.min(position.count, start + geometry.drawRange.count)
            const stride = Math.max(1, Math.floor((end - start) / 20000))
            for (let index = start; index < end; index += stride) {
                point.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld)
                if (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) {
                    xs.push(point.x)
                    ys.push(point.y)
                    zs.push(point.z)
                }
            }
        })
        if (!xs.length) {
            return null
        }
        const range = (values: number[]) => {
            values.sort((a, b) => a - b)
            return [values[Math.floor(values.length * 0.02)], values[Math.min(values.length - 1, Math.floor(values.length * 0.98))]]
        }
        const [x, y, z] = [range(xs), range(ys), range(zs)]
        return new THREE.Box3(new THREE.Vector3(x[0], y[0], z[0]), new THREE.Vector3(x[1], y[1], z[1]))
    }

    /**
     * devicePixelRatio changes when the window moves between a Retina and a 1× display or the page is zoomed; a ratio
     * read once at startup leaves the canvas at the old resolution (blurry, pixelated) until a reload.
     */
    #watchPixelRatio() {
        const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
        query.addEventListener("change", () => {
            this.renderer?.setPixelRatio(pixelRatio())
            this.#resize()
            this.#watchPixelRatio()
        }, { once: true })
    }

    #resize() {
        const width = Math.max(1, this.#host.clientWidth)
        const height = Math.max(1, this.#host.clientHeight)
        if (this.renderer) {
            this.renderer.setSize(width, height)
        } else {
            Object.assign(this.canvas, { width, height })
        }
        this.labels.setSize(width, height)
        this.camera.aspect = width / height
        this.camera.updateProjectionMatrix()
        this.resolution.set(width, height)
        this.pixelsPerMeter.value = (height * (this.renderer?.getPixelRatio() ?? 1)) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2))
        this.requestRender()
    }

    #loop = (now: number) => {
        requestAnimationFrame(this.#loop)
        // following moves camera and target together, so the user's angle and zoom stay put; the followed point glides
        // between poses (follow.ts) rather than jumping with each one
        const dt = this.#lastFrame ? (now - this.#lastFrame) / 1000 : 0
        this.#lastFrame = now
        const reduced = !!this.#reducedMotion?.matches
        const following = !!this.followTarget && !this.followPaused.get().paused
        if (following) {
            const target = this.followTarget!
            if (reduced) {
                this.#follow.reset()
            }
            const [x, y, z] = this.#follow.step([target.x, target.y, target.z], dt)
            if (this.#catchingUp) {
                const gap = this.#followDelta.set(x, y, z).sub(this.controls.target)
                if (!reduced && gap.length() > 1e-3) {
                    gap.multiplyScalar(1 - Math.exp(-dt / CATCH_UP_SECONDS))
                } else {
                    this.#catchingUp = false
                }
                this.camera.position.add(gap)
                this.controls.target.add(gap)
                this.#dirty = true
            } else if (this.#following) {
                const delta = this.#followDelta.set(x, y, z).sub(this.#lastFollow)
                if (delta.lengthSq() > 1e-10) {
                    this.camera.position.add(delta)
                    this.controls.target.add(delta)
                    this.#dirty = true
                }
            }
            this.#lastFollow.set(x, y, z)
            this.#following = true
        } else {
            this.#following = false
            this.#follow.reset()
        }
        focusDistance.value = this.camera.position.distanceTo(this.controls.target)
        this.#beforeControls.copy(this.controls.target)
        if (this.controls.update()) {
            this.#dirty = true
        }
        // orbit and zoom keep following (about the robot); a pan (right-drag, shift-drag, two fingers) stops it
        const pan = this.#pan.copy(this.controls.target).sub(this.#beforeControls)
        if (following && pan.lengthSq() > 0) {
            const verdict = this.#panGate.step([pan.x, pan.y, pan.z], focusDistance.value)
            if (verdict.action === "pause") {
                const [x, y, z] = verdict.restore
                this.controls.target.add(this.#followDelta.set(x, y, z))
                this.camera.position.add(this.#followDelta)
                this.#catchingUp = false
                this.pauseFollow()
            } else {
                this.controls.target.sub(pan)
                this.camera.position.sub(pan)
            }
        }
        const started = performance.now()
        const info: FrameInfo = { now, fixedFrame: this.fixedFrame, camera: this.camera }
        for (const listener of this.#listeners) {
            listener(info)
        }
        if (this.#dirty) {
            this.#dirty = false
            this.renderer?.render(this.scene, this.camera)
            this.labels.render(this.scene, this.camera)
            if (now - this.#lastDeclutter > 150) {
                this.#lastDeclutter = now
                this.#declutter()
            }
            const drawn = performance.now()
            // everything that arrived before this frame is on screen once the GPU picks this frame up
            if (this.#pendingData.length) {
                const bridgeNow = this.#bridgeNow()
                for (const data of this.#pendingData) {
                    this.#latencies.push(bridgeNow - data.bridgeTs)
                    this.#arrivals.push(drawn - data.arrival)
                }
                this.#pendingData.length = 0
            }
            this.#cpuTimes.push(drawn - started)
        }
        this.#frameTimes.push(now)
        if (now - this.#lastStats > 1000) {
            this.#publishStats(now)
        }
    }

    #publishStats(now: number) {
        const percentile = (values: number[], p: number) => {
            if (!values.length) {
                return null
            }
            const sorted = [...values].sort((a, b) => a - b)
            return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
        }
        const span = (now - this.#lastStats) / 1000
        let points = 0
        let splats = false
        this.scene.traverseVisible((object) => {
            if ((object as THREE.Points).isPoints) {
                splats ||= "SPLAT" in (((object as THREE.Points).material as THREE.ShaderMaterial).defines ?? {})
                const geometry = (object as THREE.Points).geometry
                points += Math.min(geometry.drawRange.count, geometry.getAttribute("position")?.count ?? 0)
            }
        })
        this.stats.set({
            fps: Math.round(this.#frameTimes.length / span),
            frameMs: this.#cpuTimes.length ? this.#cpuTimes.reduce((a, b) => a + b, 0) / this.#cpuTimes.length : 0,
            latencyP50: percentile(this.#latencies, 0.5),
            latencyP95: percentile(this.#latencies, 0.95),
            arrivalToFrameMs: percentile(this.#arrivals, 0.5),
            drawCalls: this.renderer?.info.render.calls ?? 0,
            points,
        })
        // splats that can't keep up for 3 s in a row are drawn as cubes instead (the stats pill says so; clicking it retries)
        const frameMs = this.#frameTimes.length > 1 ? (this.#frameTimes[this.#frameTimes.length - 1] - this.#frameTimes[0]) / (this.#frameTimes.length - 1) : 0
        this.#slowSeconds = splats && frameMs > FRAME_BUDGET_MS * 1.25 ? this.#slowSeconds + 1 : 0
        if (this.#slowSeconds >= 3 && !splatFallback.get().active) {
            splatFallback.set({ active: true, frameMs })
        }
        this.#frameTimes.length = 0
        this.#cpuTimes.length = 0
        this.#latencies.length = 0
        this.#arrivals.length = 0
        this.#lastStats = now
    }
}
