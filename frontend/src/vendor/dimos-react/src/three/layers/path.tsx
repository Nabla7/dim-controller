// deno-lint-ignore-file no-explicit-any -- decoded nav_msgs/Path messages of any shape
// nav_msgs.Path (planned paths): a thick line through the poses, placed by its header's frame. Or `poses` as props.
import * as THREE from "three"
import { useStore } from "../store.ts"
import { FatLines } from "../lines.ts"
import { cssColor } from "../robot_model.ts"
import { placeLayer, registerLayer, subscribeDecoded } from "./registry.ts"
import type { LayerContext, LayerSettingsProps, Topic } from "./registry.ts"
import { ColorSetting } from "./pose.tsx"
import { Field, Slider } from "../../components/controls.tsx"
import type { Store } from "../store.ts"
import type { FrameInfo } from "../viewer.ts"

/** `lift`: m above the floor */
export interface PathSettings {
    color: string
    width: number
    lift: number
}

/** One point of a path */
export type PathPoint = [x: number, y: number, z: number]

/** Points of a path (decoded data: any shape): nav_msgs.Path `poses` (PoseStamped), Poses, {x,y,z} or [x,y,z]. */
export function pathPoints(poses: Iterable<any> | null | undefined): PathPoint[] {
    const out: PathPoint[] = []
    for (const item of poses ?? []) {
        const position = Array.isArray(item)
            ? { x: item[0], y: item[1], z: item[2] ?? 0 }
            : (item?.pose?.position ?? item?.position ?? item)
        if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
            out.push([position.x, position.y, position.z ?? 0])
        }
    }
    return out
}

export class PathLayer {
    root = new THREE.Group()
    #lines: FatLines
    #stop: () => void = () => {}
    #unsubscribe: () => void
    #frame: string | null = null
    #points: PathPoint[] = []
    settings: Store<PathSettings>
    context: LayerContext

    /** `topic` null: data comes through setData */
    constructor(context: LayerContext, topic: Topic | null, settings: Store<PathSettings>) {
        this.context = context
        this.settings = settings
        this.#lines = new FatLines(context.viewer.resolution, {
            width: settings.get().width,
            color: 0xffffff,
            capacity: 256,
        })
        this.root.add(this.#lines.object)
        this.#unsubscribe = settings.subscribe(() => this.#restyle())
        this.#restyle()
        if (topic) {
            this.#stop = subscribeDecoded(context, topic, { maxHz: 10 }, (path, timestamp) => {
                this.#set(pathPoints(path.poses ?? path), path.header?.frame_id ?? path.frame ?? "", timestamp)
            })
        }
    }

    #restyle() {
        const settings = this.settings.get()
        this.#lines.material.color.copy(cssColor(settings.color, "white"))
        this.#lines.material.linewidth = settings.width
        this.#draw()
    }

    /** Props data: `{ poses, frame?, timestamp? }` or the poses themselves (any shape pathPoints reads). */
    setData(data: any) {
        this.#set(pathPoints(data?.poses ?? data), data?.frame ?? "", data?.timestamp ?? Date.now())
    }

    #set(points: PathPoint[], frame: string, timestamp: number | undefined) {
        this.#frame = frame
        this.#points = points
        this.#draw()
        this.context.setStatus({ info: `${points.length} poses · ${frame || "no frame"}`, frame })
        this.context.viewer.noteData(timestamp)
    }

    #draw() {
        const lift = this.settings.get().lift ?? 0
        this.#lines.clear()
        for (let index = 1; index < this.#points.length; index++) {
            const a = this.#points[index - 1],
                b = this.#points[index]
            this.#lines.push(a[0], a[1], a[2] + lift, b[0], b[1], b[2] + lift)
        }
        this.#lines.commit()
        this.context.viewer.requestRender()
    }

    update(frame: FrameInfo) {
        if (this.#frame !== null) {
            placeLayer(this.context, this.root, this.#frame, frame.fixedFrame)
        }
    }

    dispose() {
        this.#stop()
        this.#unsubscribe()
        this.#lines.dispose()
    }
}

export function PathSettingsEditor({ settings }: LayerSettingsProps<PathSettings>) {
    const value = useStore(settings)
    return (
        <div className="dr-layer-settings-grid">
            <Field label="Color">
                <ColorSetting value={value.color} onChange={(color) => settings.update({ color })} />
            </Field>
            <Field label="Width">
                <Slider
                    min={1}
                    max={10}
                    step={0.5}
                    value={value.width}
                    format={(width) => `${width}px`}
                    onChange={(width) => settings.update({ width })}
                />
            </Field>
        </div>
    )
}

/** A stable, distinct color per name, as a hex string (paths, arrays, boxes of one class). */
export function colorFor(name: unknown): THREE.Color {
    let hash = 0
    for (const char of String(name)) {
        hash = (hash * 31 + char.charCodeAt(0)) | 0
    }
    return new THREE.Color().setHSL(((hash >>> 0) % 360) / 360, 0.75, 0.6)
}

registerLayer<PathSettings>({
    id: "path",
    label: "Path",
    types: ["nav_msgs.Path"],
    defaults: (topic) => ({ color: `#${colorFor((topic?.name ?? "") + "path").getHexString()}`, width: 4, lift: 0.03 }),
    create: (context, topic, settings) => new PathLayer(context, topic, settings),
    Settings: PathSettingsEditor,
})
