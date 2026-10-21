// geometry_msgs.PoseArray (candidate poses, particle clouds, waypoints): an arrow per pose along its +x.
import * as THREE from "three"
import { useStore } from "../store.ts"
import { FatLines } from "../lines.ts"
import { cssColor } from "../robot_model.ts"
import { placeLayer, registerLayer, subscribeDecoded } from "./registry.ts"
import type { LayerContext, LayerSettingsProps, Topic } from "./registry.ts"
import { ColorSetting, poseMatrix } from "./pose.tsx"
import type { PoseLike } from "./pose.tsx"
import { colorFor } from "./path.tsx"
import { Field, Slider } from "../../components/controls.tsx"
import type { Store } from "../store.ts"
import type { FrameInfo } from "../viewer.ts"

export interface ArrowSettings {
    length: number
    color: string
    width?: number
}

/** A pose of the array: a geometry_msgs Pose, or anything with one in `.pose` (decoded data). */
type ArrayPose = (PoseLike & { pose?: PoseLike }) | null | undefined

export class PoseArrayLayer {
    root = new THREE.Group()
    #lines: FatLines
    #stop: () => void = () => {}
    #unsubscribe: () => void
    #frame: string | null = null
    #poses: ArrayPose[] | null | undefined = null
    settings: Store<ArrowSettings>
    context: LayerContext

    /** `topic` null: data comes through setData */
    constructor(context: LayerContext, topic: Topic | null, settings: Store<ArrowSettings>) {
        this.context = context
        this.settings = settings
        this.#lines = new FatLines(context.viewer.resolution, { width: settings.get().width ?? 2.5, color: 0xffffff })
        this.root.add(this.#lines.object)
        this.#unsubscribe = settings.subscribe(() => this.#draw())
        if (topic) {
            this.#stop = subscribeDecoded(context, topic, { maxHz: 10 }, (message, timestamp) => {
                this.#set(message.poses ?? message, message.header?.frame_id ?? "", timestamp)
            })
        }
        this.#draw()
    }

    /** Props data: `{ poses, frame?, timestamp? }` or the poses themselves (any shape). */
    // deno-lint-ignore no-explicit-any -- decoded PoseArray messages of any shape
    setData(data: any) {
        this.#set(data?.poses ?? data, data?.frame ?? "", data?.timestamp ?? Date.now())
    }

    #set(poses: ArrayPose[] | null | undefined, frame: string, timestamp: number | undefined) {
        this.#frame = frame
        this.#poses = poses
        this.#draw()
        this.context.setStatus({ info: `${poses?.length ?? 0} poses · ${frame || "no frame"}`, frame })
        this.context.viewer.noteData(timestamp)
    }

    #draw() {
        const { length, color, width } = this.settings.get()
        this.#lines.material.color.copy(cssColor(color, "white"))
        this.#lines.material.linewidth = width ?? 2.5
        this.#lines.clear()
        const matrix = new THREE.Matrix4()
        const points = [
            new THREE.Vector3(),
            new THREE.Vector3(length, 0, 0),
            new THREE.Vector3(length * 0.7, length * 0.2, 0),
            new THREE.Vector3(length * 0.7, -length * 0.2, 0),
        ]
        const placed = points.map(() => new THREE.Vector3())
        for (const pose of this.#poses ?? []) {
            poseMatrix(pose?.pose ?? pose, matrix)
            points.forEach((point, index) => placed[index].copy(point).applyMatrix4(matrix))
            const [tail, tip, left, right] = placed
            this.#lines.push(tail.x, tail.y, tail.z, tip.x, tip.y, tip.z)
            this.#lines.push(tip.x, tip.y, tip.z, left.x, left.y, left.z)
            this.#lines.push(tip.x, tip.y, tip.z, right.x, right.y, right.z)
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

export function ArrowSettingsEditor({ settings }: LayerSettingsProps<ArrowSettings>) {
    const value = useStore(settings)
    return (
        <div className="dr-layer-settings-grid">
            <Field label="Length">
                <Slider
                    min={0.05}
                    max={2}
                    step={0.05}
                    value={value.length}
                    format={(length) => `${length} m`}
                    onChange={(length) => settings.update({ length })}
                />
            </Field>
            <Field label="Color">
                <ColorSetting value={value.color} onChange={(color) => settings.update({ color })} />
            </Field>
        </div>
    )
}

registerLayer<ArrowSettings>({
    id: "posearray",
    label: "Pose array",
    types: ["geometry_msgs.PoseArray"],
    defaults: (topic) => ({ length: 0.4, color: `#${colorFor(topic?.name ?? "").getHexString()}` }),
    create: (context, topic, settings) => new PoseArrayLayer(context, topic, settings),
    Settings: ArrowSettingsEditor,
})
