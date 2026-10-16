// The arm target's gizmo: one thick arrow per axis (moves along it), a square between each pair of arrows (moves in
// their plane) and a short arc between each pair of arrow heads (rotates about the third axis), in the handle's own axes. Each arrow points whichever way faces the camera, so the
// shown one is the visible one; the arcs follow the arrows. Drawn on top of the scene at a constant size on screen.
import * as THREE from "three"

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
const COLORS = [0xe5484d, 0x30a46c, 0x3e63dd]
const HOVER = 0xffd60a
/** the arrow's length on screen (CSS px) */
const SCREEN_PX = 110
const ARC_RADIUS = 0.72
const ARC_SPAN = THREE.MathUtils.degToRad(40)
/** an arrow flips only once the camera is clearly on the other side (no flicker when it's edge-on) */
const FLIP_MARGIN = 0.08

type Part = { kind: "move" | "plane" | "rotate"; axis: number; visible: THREE.Mesh[]; pick: THREE.Mesh }

export class PoseGizmo {
    readonly object = new THREE.Group()
    enabled = true
    #parts: Part[] = []
    #arrows: THREE.Group[] = []
    #arcs: THREE.Group[] = []
    #squares: THREE.Group[] = []
    #signs = [1, 1, 1]
    #hovered: Part | null = null
    #drag: { part: Part; pointerId: number; startWorld: THREE.Vector3; startQuat: THREE.Quaternion; axis: THREE.Vector3; startAlong: number; startVector: THREE.Vector3 | null; startX: number } | null = null
    #raycaster = new THREE.Raycaster()

    constructor(
        readonly camera: THREE.PerspectiveCamera,
        readonly canvas: HTMLCanvasElement,
        readonly handle: THREE.Object3D,
        readonly events: { change: () => void; dragging: (dragging: boolean) => void; render: () => void },
    ) {
        this.object.renderOrder = 1000
        for (let axis = 0; axis < 3; axis++) {
            this.#arrows.push(this.#arrow(axis))
            this.#arcs.push(this.#arc(axis))
            this.#squares.push(this.#square(axis))
        }
        // capture: ahead of the orbit controls' own pointerdown on the same canvas
        canvas.addEventListener("pointerdown", this.#down, true)
        canvas.addEventListener("pointermove", this.#move)
        canvas.addEventListener("pointerup", this.#up)
        canvas.addEventListener("pointercancel", this.#up)
    }

    get dragging(): boolean {
        return this.#drag !== null
    }

    #material(color: number): THREE.MeshBasicMaterial {
        return new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, toneMapped: false })
    }

    #pickMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false, colorWrite: false })

    /** along +x, turned onto its axis; its sign is the group's scale */
    #arrow(axis: number): THREE.Group {
        const group = new THREE.Group()
        const material = this.#material(COLORS[axis])
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.78, 12), material)
        shaft.position.y = 0.39
        const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.24, 16), material)
        head.position.y = 0.9
        const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.05, 8), this.#pickMaterial)
        pick.position.y = 0.52
        const along = new THREE.Group()
        along.add(shaft, head, pick)
        // the meshes are built along +y
        along.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), AXES[axis])
        group.add(along)
        this.object.add(group)
        this.#parts.push({ kind: "move", axis, visible: [shaft, head], pick })
        return group
    }

    /** normal to `axis`, in the corner between the other two arrows */
    #square(axis: number): THREE.Group {
        const group = new THREE.Group()
        const material = this.#material(COLORS[axis])
        material.side = THREE.DoubleSide
        material.opacity = 0.55
        const square = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), material)
        square.position.set(0.3, 0.3, 0)
        const pick = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), this.#pickMaterial)
        pick.position.copy(square.position)
        group.add(square, pick)
        group.matrixAutoUpdate = false
        this.object.add(group)
        this.#parts.push({ kind: "plane", axis, visible: [square], pick })
        return group
    }

    /** about `axis`, in the plane of the other two, centered between their arrow heads */
    #arc(axis: number): THREE.Group {
        const group = new THREE.Group()
        const start = Math.PI / 4 - ARC_SPAN / 2
        const tube = new THREE.TorusGeometry(ARC_RADIUS, 0.028, 8, 24, ARC_SPAN)
        tube.rotateZ(start)
        const arc = new THREE.Mesh(tube, this.#material(COLORS[axis]))
        const pickTube = new THREE.TorusGeometry(ARC_RADIUS, 0.1, 6, 16, ARC_SPAN + 0.15)
        pickTube.rotateZ(start - 0.075)
        const pick = new THREE.Mesh(pickTube, this.#pickMaterial)
        // a small arrowhead at each end, along the arc: it turns both ways
        const heads = [[start, -1], [start + ARC_SPAN, 1]].map(([angle, way]) => {
            const head = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.13, 12), arc.material)
            head.position.set(ARC_RADIUS * Math.cos(angle), ARC_RADIUS * Math.sin(angle), 0)
            head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-Math.sin(angle) * way, Math.cos(angle) * way, 0))
            return head
        })
        group.add(arc, ...heads, pick)
        group.matrixAutoUpdate = false
        this.object.add(group)
        this.#parts.push({ kind: "rotate", axis, visible: [arc, ...heads], pick })
        return group
    }

    /** Each frame: at the handle, sized for the screen, each arrow toward the camera (not while dragging). */
    update() {
        this.object.visible = this.enabled
        if (!this.enabled) {
            return
        }
        this.handle.updateWorldMatrix(true, false)
        const origin = new THREE.Vector3()
        const rotation = new THREE.Quaternion()
        this.handle.matrixWorld.decompose(origin, rotation, new THREE.Vector3())
        const distance = this.camera.position.distanceTo(origin)
        const height = Math.max(1, this.canvas.clientHeight)
        const scale = distance * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * SCREEN_PX / height
        this.object.position.copy(origin)
        this.object.quaternion.copy(rotation)
        this.object.scale.setScalar(scale)
        if (!this.#drag) {
            const toCamera = this.camera.position.clone().sub(origin).normalize()
            for (let axis = 0; axis < 3; axis++) {
                const facing = AXES[axis].clone().applyQuaternion(rotation).dot(toCamera)
                if (facing * this.#signs[axis] < -FLIP_MARGIN) {
                    this.#signs[axis] = -this.#signs[axis]
                }
            }
        }
        for (let axis = 0; axis < 3; axis++) {
            this.#arrows[axis].scale.setScalar(1).setComponent(axis, this.#signs[axis])
            const [b, c] = [(axis + 1) % 3, (axis + 2) % 3]
            const u = AXES[b].clone().multiplyScalar(this.#signs[b])
            const v = AXES[c].clone().multiplyScalar(this.#signs[c])
            for (const group of [this.#arcs[axis], this.#squares[axis]]) {
                group.matrix.makeBasis(u, v, u.clone().cross(v))
                group.matrixWorldNeedsUpdate = true
            }
        }
    }

    #ray(event: PointerEvent): THREE.Ray {
        const rect = this.canvas.getBoundingClientRect()
        const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
        this.#raycaster.setFromCamera(ndc, this.camera)
        return this.#raycaster.ray
    }

    #hit(event: PointerEvent): Part | null {
        if (!this.enabled || !this.object.visible) {
            return null
        }
        this.object.updateMatrixWorld(true)
        this.#ray(event)
        const hits = this.#raycaster.intersectObjects(this.#parts.map((part) => part.pick), false)
        // arrows, then squares, then arcs where they overlap
        const rank = (object: THREE.Object3D) => ["move", "plane", "rotate"].indexOf(this.#partOf(object)?.kind ?? "rotate")
        hits.sort((a, b) => rank(a.object) - rank(b.object) || a.distance - b.distance)
        return hits.length ? this.#partOf(hits[0].object) : null
    }

    #partOf(object: THREE.Object3D): Part | null {
        return this.#parts.find((part) => part.pick === object) ?? null
    }

    #highlight(part: Part | null) {
        if (part === this.#hovered) {
            return
        }
        for (const [shown, color] of [[this.#hovered, null], [part, HOVER]] as const) {
            for (const mesh of shown?.visible ?? []) {
                ;(mesh.material as THREE.MeshBasicMaterial).color.setHex(color ?? COLORS[shown!.axis])
            }
        }
        this.#hovered = part
        this.canvas.style.cursor = part ? (part.kind === "rotate" ? "grab" : "move") : ""
        this.events.render()
    }

    /** where the pointer's ray passes closest to the line through `origin` along `axis` (its distance along it) */
    #along(ray: THREE.Ray, origin: THREE.Vector3, axis: THREE.Vector3): number {
        const w = origin.clone().sub(ray.origin)
        const b = axis.dot(ray.direction)
        const denominator = 1 - b * b
        if (denominator < 1e-6) {
            return 0
        }
        return (b * w.dot(ray.direction) - w.dot(axis)) / denominator
    }

    /** the pointer's ray on the plane through `origin` normal to `axis`, from the origin; null when edge-on */
    #onPlane(ray: THREE.Ray, origin: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 | null {
        if (Math.abs(ray.direction.dot(axis)) < 0.15) {
            return null
        }
        const point = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(axis, origin), new THREE.Vector3())
        return point ? point.sub(origin) : null
    }

    #down = (event: PointerEvent) => {
        if (event.button !== 0) {
            return
        }
        const part = this.#hit(event)
        if (!part) {
            return
        }
        event.stopImmediatePropagation()
        event.preventDefault()
        this.canvas.setPointerCapture(event.pointerId)
        const startWorld = new THREE.Vector3()
        const startQuat = new THREE.Quaternion()
        this.handle.matrixWorld.decompose(startWorld, startQuat, new THREE.Vector3())
        const axis = AXES[part.axis].clone().applyQuaternion(startQuat)
        const ray = this.#ray(event)
        this.#drag = {
            part,
            pointerId: event.pointerId,
            startWorld,
            startQuat,
            axis,
            startAlong: this.#along(ray, startWorld, axis),
            startVector: this.#onPlane(ray, startWorld, axis),
            startX: event.clientX,
        }
        this.#highlight(part)
        this.events.dragging(true)
    }

    #move = (event: PointerEvent) => {
        const drag = this.#drag
        if (!drag) {
            this.#highlight(event.buttons ? this.#hovered : this.#hit(event))
            return
        }
        if (event.pointerId !== drag.pointerId) {
            return
        }
        const ray = this.#ray(event)
        const parent = this.handle.parent
        if (drag.part.kind === "move") {
            const world = drag.startWorld.clone().addScaledVector(drag.axis, this.#along(ray, drag.startWorld, drag.axis) - drag.startAlong)
            this.handle.position.copy(parent ? parent.worldToLocal(world) : world)
        } else if (drag.part.kind === "plane") {
            const now = drag.startVector && this.#onPlane(ray, drag.startWorld, drag.axis)
            if (!now) {
                return
            }
            const world = drag.startWorld.clone().add(now).sub(drag.startVector!)
            this.handle.position.copy(parent ? parent.worldToLocal(world) : world)
        } else {
            const now = drag.startVector && this.#onPlane(ray, drag.startWorld, drag.axis)
            // edge-on: sideways pointer travel turns it instead
            const angle = drag.startVector && now
                ? Math.atan2(drag.startVector.clone().cross(now).dot(drag.axis), drag.startVector.dot(now))
                : (event.clientX - drag.startX) * 0.01
            const world = new THREE.Quaternion().setFromAxisAngle(drag.axis, angle).multiply(drag.startQuat)
            const parentQuat = parent ? parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion()
            this.handle.quaternion.copy(parentQuat.invert().multiply(world))
        }
        this.handle.updateMatrixWorld()
        this.events.change()
        this.events.render()
    }

    #up = (event: PointerEvent) => {
        if (!this.#drag || event.pointerId !== this.#drag.pointerId) {
            return
        }
        this.#drag = null
        this.canvas.releasePointerCapture?.(event.pointerId)
        this.#highlight(null)
        this.events.dragging(false)
    }

    dispose() {
        this.canvas.removeEventListener("pointerdown", this.#down, true)
        this.canvas.removeEventListener("pointermove", this.#move)
        this.canvas.removeEventListener("pointerup", this.#up)
        this.canvas.removeEventListener("pointercancel", this.#up)
        this.object.removeFromParent()
        this.object.traverse((object) => {
            const mesh = object as THREE.Mesh
            mesh.geometry?.dispose()
            ;(mesh.material as THREE.Material | undefined)?.dispose?.()
        })
    }
}
