// The TF tree drawn: an axes gizmo per frame (theme --axis-x/y/z), its name, and a line to its parent. A big tree (an
// arm, a humanoid) names only the robot's frame, the fixed frame and `named` past `maxNames`. Reading tf into the tree
// is TfFeed's job (whether or not this layer is on).
import * as THREE from "three"
import { type Store, useStore } from "../store.ts"
import { themeColors } from "../../theme/theme.ts"
import { FatLines } from "../lines.ts"
import { LabelPool } from "../labels.ts"
import { cssColor } from "../robot_model.ts"
import { type LayerContext, type LayerSettingsProps, registerLayer } from "./registry.ts"
import type { FrameInfo } from "../viewer.ts"
import { Field, Slider, Toggle } from "../../components/controls.tsx"

export interface TfSettings {
    axesSize: number
    names: boolean
    links: boolean
    maxNames?: number
    named?: string[]
    maxFrames?: number
}

export const TF_DEFAULTS: Required<TfSettings> = {
    axesSize: 0.25,
    names: true,
    links: true,
    maxNames: 16,
    named: [],
    maxFrames: 512,
}

export class TfFramesLayer {
    root = new THREE.Group()
    #axes: FatLines
    #links: FatLines
    #labels = new LabelPool("dr-scene-label dr-frame-label")
    #version = -1
    #fixedFrame = ""
    #colors: THREE.Color[] = []
    #unsubscribe: () => void
    settings: Store<TfSettings>
    context: LayerContext

    constructor(context: LayerContext, settings: Store<TfSettings>) {
        this.context = context
        this.settings = settings
        const maxFrames = settings.get().maxFrames ?? 512
        this.#axes = new FatLines(context.viewer.resolution, {
            width: 2.5,
            vertexColors: true,
            capacity: maxFrames * 3,
        })
        this.#links = new FatLines(context.viewer.resolution, { width: 1, color: 0xffffff, opacity: 0.6 })
        this.root.add(this.#axes.object, this.#links.object, this.#labels.group)
        this.#unsubscribe = settings.subscribe(() => {
            this.#version = -1
            context.viewer.requestRender()
        })
        addEventListener("dimos-react-theme", this.#restyle)
        this.#restyle()
    }

    #restyle = () => {
        const theme = themeColors()
        this.#colors = [cssColor(theme.axisX, "red"), cssColor(theme.axisY, "green"), cssColor(theme.axisZ, "blue")]
        this.#links.material.color.copy(cssColor(theme.mutedFg, "gray"))
        this.#version = -1
    }

    update(frame: FrameInfo) {
        const tf = this.context.tf
        if (tf.version === this.#version && frame.fixedFrame === this.#fixedFrame) {
            return
        }
        this.#version = tf.version
        this.#fixedFrame = frame.fixedFrame
        const settings: Required<TfSettings> = { ...TF_DEFAULTS, ...this.settings.get() }
        const snapshot = tf.snapshot()
        const unit = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
        this.#axes.clear()
        this.#links.clear()
        this.#labels.begin()
        const origin = new THREE.Vector3(),
            tip = new THREE.Vector3(),
            parent = new THREE.Vector3()
        const baseFrame = this.context.options?.baseFrame
        let unplaced = 0
        for (const name of snapshot.frames.slice(0, settings.maxFrames)) {
            const matrix = tf.lookup(name, frame.fixedFrame)
            if (!matrix) {
                unplaced++
                continue
            }
            origin.setFromMatrixPosition(matrix)
            for (let axis = 0; axis < 3; axis++) {
                tip.copy(unit[axis]).multiplyScalar(settings.axesSize).applyMatrix4(matrix)
                this.#axes.push(origin.x, origin.y, origin.z, tip.x, tip.y, tip.z, this.#colors[axis])
            }
            const nameIt = snapshot.frames.length <= settings.maxNames ||
                name === frame.fixedFrame ||
                name === baseFrame ||
                settings.named.includes(name)
            if (settings.names && nameIt) {
                this.#labels.place(name, origin)
            }
            const parentName = tf.parentOf(name)
            const parentMatrix = parentName && tf.lookup(parentName, frame.fixedFrame)
            if (settings.links && parentMatrix) {
                parent.setFromMatrixPosition(parentMatrix)
                this.#links.push(origin.x, origin.y, origin.z, parent.x, parent.y, parent.z)
            }
        }
        this.#axes.commit()
        this.#links.commit()
        this.#labels.end()
        this.context.setStatus({
            info: `${snapshot.frames.length} frames`,
            problem: unplaced ? `${unplaced} frames not connected to "${frame.fixedFrame}"` : null,
        })
        this.context.viewer.requestRender()
    }

    dispose() {
        this.#unsubscribe()
        removeEventListener("dimos-react-theme", this.#restyle)
        this.#axes.dispose()
        this.#links.dispose()
        this.#labels.dispose()
    }
}

export type TfSettingsEditorProps = LayerSettingsProps<TfSettings>

export function TfSettingsEditor({ settings }: TfSettingsEditorProps) {
    const value = useStore(settings)
    return (
        <div className="dr-layer-settings-grid">
            <Field label="Axes">
                <Slider
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={value.axesSize}
                    format={(size: number) => `${size} m`}
                    onChange={(axesSize: number) => settings.update({ axesSize })}
                />
            </Field>
            <Field label="Names">
                <Toggle value={value.names} onChange={(names: boolean) => settings.update({ names })} />
            </Field>
            <Field label="Links">
                <Toggle value={value.links} onChange={(links: boolean) => settings.update({ links })} />
            </Field>
        </div>
    )
}

registerLayer<TfSettings>({
    id: "tf",
    label: "TF frames",
    types: ["tf2_msgs.TFMessage"],
    defaults: { axesSize: 0.25, names: true, links: true },
    // one tf topic drawing is enough: the others are the same tree
    enabledByDefault: (topic) => topic.name === "/tf",
    create: (context, _topic, settings) => new TfFramesLayer(context, settings),
    Settings: TfSettingsEditor,
})
