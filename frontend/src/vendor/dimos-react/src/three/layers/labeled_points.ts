// Labeled points: visualization_msgs.EntityMarkers (dimos's people/objects/places, JSON after a u32 length, no
// fingerprint) and geometry_msgs.PointStamped (a clicked point, a goal). A sphere and a text label each, colored by
// kind from the theme (--entity-person / --entity-object / --entity-location, else --danger / --ok / --info).
import * as THREE from "three"
import { LabelPool } from "../labels.ts"
import { cssColor } from "../robot_model.ts"
import { type LayerContext, placeLayer, registerLayer, subscribeDecoded, type Topic } from "./registry.ts"
import type { FrameInfo } from "../viewer.ts"
import { colorFor } from "./path.tsx"

/** One entity in an EntityMarkers message (dimos's JSON). */
export interface EntityMarker {
    id: string | number
    type: string
    label: unknown
    x: number
    y: number
    z: number
}

/** A point as drawn: a sphere and a label at `position`, colored by `color` (any CSS color or token). */
export interface LabeledPoint {
    label: string
    color: string
    position: THREE.Vector3
}

/** A point from props, placed through TF from `frame` (the fixed frame when absent). */
export interface LabeledPointData {
    label?: string
    position?: [number, number, number]
    frame?: string
    color?: string
}

const ENTITY_COLORS: Record<string, string> = {
    person: "var(--entity-person, var(--danger))",
    object: "var(--entity-object, var(--ok))",
    location: "var(--entity-location, var(--info, var(--primary)))",
}
const OTHER = "var(--muted-fg)"

/** EntityMarkers bytes (u32 big-endian length + JSON) → `{ label, color, position }[]`. */
export function entitiesOf(bytes: Uint8Array): LabeledPoint[] {
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
    const list: EntityMarker[] = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)))
    return list.map((entity) => ({
        label: `${entity.id}: ${String(entity.label).slice(0, 40)}`,
        color: ENTITY_COLORS[entity.type] ?? OTHER,
        position: new THREE.Vector3(entity.x, entity.y, entity.z),
    }))
}

const sphere = new THREE.SphereGeometry(1, 16, 12)

/** A decoded geometry_msgs.PointStamped (the fields the layer reads). */
interface PointStampedMessage {
    header?: { frame_id?: string }
    point?: { x?: number; y?: number; z?: number }
}

export class LabeledPoints {
    root = new THREE.Group()
    #labels = new LabelPool()
    #spheres: THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshLambertMaterial>
    #stop: () => void = () => {}
    #frame: string | null = null
    #show: (entities: LabeledPoint[], frame: string, timestamp: number | undefined) => void
    /** props data: `[{ label, position: [x, y, z], frame, color }]`, each placed through TF every frame */
    #data: LabeledPointData[] | null = null
    #placed = ""
    context: LayerContext

    constructor(context: LayerContext, topic: Topic | null) {
        this.context = context
        this.#spheres = new THREE.InstancedMesh(sphere, new THREE.MeshLambertMaterial(), 256)
        this.#spheres.count = 0
        this.#spheres.frustumCulled = false
        this.root.add(this.#spheres, this.#labels.group)
        const show = (this.#show = (entities: LabeledPoint[], frame: string, timestamp: number | undefined) => {
            this.#frame = frame
            this.#labels.begin()
            const matrix = new THREE.Matrix4()
            const count = Math.min(entities.length, 256)
            for (let index = 0; index < count; index++) {
                const entity = entities[index]
                this.#spheres.setMatrixAt(index, matrix.makeScale(0.12, 0.12, 0.12).setPosition(entity.position))
                this.#spheres.setColorAt(index, cssColor(entity.color, "gray"))
                this.#labels.place(entity.label, entity.position.clone().setZ(entity.position.z + 0.25), entity.color)
            }
            this.#spheres.count = count
            this.#spheres.instanceMatrix.needsUpdate = true
            if (this.#spheres.instanceColor) {
                this.#spheres.instanceColor.needsUpdate = true
            }
            this.#labels.end()
            context.setStatus({ info: `${entities.length} points` })
            if (timestamp !== undefined) {
                context.viewer.noteData(timestamp)
            }
            context.viewer.requestRender()
        })
        if (!topic) {
            return
        }
        if (topic.type === "visualization_msgs.EntityMarkers") {
            // world coordinates by definition (dimos draws them in rerun's world)
            this.#stop = context.source.subscribe(topic.key, { delivery: "latest", maxHz: 5 }, (message) => {
                try {
                    show(
                        Array.isArray(message.value)
                            ? message.value.map((entity: EntityMarker) => ({
                                label: `${entity.id}: ${String(entity.label).slice(0, 40)}`,
                                color: ENTITY_COLORS[entity.type] ?? OTHER,
                                position: new THREE.Vector3(entity.x, entity.y, entity.z),
                            }))
                            : entitiesOf(message.bytes),
                        "",
                        message.timestamp,
                    )
                } catch (error) {
                    context.setStatus({ problem: `cannot decode: ${(error as Error | undefined)?.message ?? error}` })
                }
            })
        } else {
            this.#stop = subscribeDecoded(
                context,
                topic,
                { maxHz: 10 },
                (message: PointStampedMessage, timestamp: number | undefined) => {
                    const point = message.point ?? {}
                    show(
                        [
                            {
                                label: topic.name,
                                color: `#${colorFor(topic.name).getHexString()}`,
                                position: new THREE.Vector3(point.x, point.y, point.z),
                            },
                        ],
                        message.header?.frame_id ?? "",
                        timestamp,
                    )
                },
            )
        }
    }

    /** Points from props (no topic): `[{ label, position: [x, y, z], frame, color }]`. */
    setData(data: unknown) {
        this.#data = Array.isArray(data) ? (data as LabeledPointData[]) : []
        this.#placed = ""
    }

    update(frame: FrameInfo) {
        if (this.#data) {
            // each point through its own frame; redrawn only when where they land changed
            const entities: LabeledPoint[] = []
            for (const item of this.#data) {
                const position = new THREE.Vector3(...(item.position ?? [0, 0, 0]))
                const matrix = !item.frame || item.frame === frame.fixedFrame
                    ? null
                    : this.context.tf.lookup(item.frame, frame.fixedFrame)
                if (item.frame && item.frame !== frame.fixedFrame && !matrix) {
                    continue
                }
                if (matrix) {
                    position.applyMatrix4(matrix)
                }
                entities.push({ label: item.label ?? "", color: item.color ?? "var(--warn)", position })
            }
            const signature = entities
                .map(
                    (entity) => `${entity.label}|${entity.color}|${entity.position.toArray().map((v) => v.toFixed(3))}`,
                )
                .join("\n")
            if (signature !== this.#placed) {
                this.#placed = signature
                this.#show(entities, "", undefined)
            }
            return
        }
        if (this.#frame !== null) {
            placeLayer(this.context, this.root, this.#frame, frame.fixedFrame)
        }
    }

    dispose() {
        this.#stop()
        this.#spheres.dispose()
        this.#labels.dispose()
    }
}

registerLayer({
    id: "labeled-points",
    label: "Labeled points",
    types: ["visualization_msgs.EntityMarkers", "geometry_msgs.PointStamped"],
    defaults: {},
    create: (context, topic) => new LabeledPoints(context, topic),
})
