// nav_msgs.OccupancyGrid (costmaps, 2D maps): one textured plane at the grid's origin. A costmap is drawn like a floor
// plan: the floor where it's free, costs from the floor color toward the wall color, lethal cells as a bright rim
// around a dimmer body; unknown is clear. A map is gray. Colors come from the theme (--scene-floor, --scene-wall,
// --scene-wall-rim, falling back to --surface / --primary). The texture is rebuilt in place for a same-size grid.
import * as THREE from "three"
import { type Store, useStore } from "../store.ts"
import { themeColors } from "../../theme/theme.ts"
import { cssColor } from "../robot_model.ts"
import {
    type LayerContext,
    type LayerSettingsProps,
    placeLayer,
    registerLayer,
    subscribeDecoded,
    type Topic,
} from "./registry.ts"
import type { FrameInfo } from "../viewer.ts"
import { poseMatrix } from "./pose.tsx"
import { Field, Select, Slider } from "../../components/controls.tsx"

export interface GridSettings {
    opacity: number
    style: "costmap" | "map"
    lift: number
}

/** A decoded nav_msgs.OccupancyGrid (the fields the layer reads); `data` is int8 cells, -1 = unknown. */
export interface OccupancyGridMessage {
    header?: { frame_id?: string }
    info?: { width: number; height: number; resolution: number; origin?: Parameters<typeof poseMatrix>[0] }
    data?: ArrayBufferView & ArrayLike<number>
}

type Rgb = number[]

/** a costmap's lethal value (dimos marks obstacles 100) */
const LETHAL = 100

const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((value, index) => value + (b[index] - value) * t)
const rgb255 = (value: string | undefined, fallback: string): Rgb => {
    const color = cssColor(value, fallback)
    color.convertLinearToSRGB?.()
    return [Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255)]
}

/** The floor-plan colors from the theme. */
function planColors(): { floor: Rgb; body: Rgb; rim: Rgb; fg: Rgb } {
    const theme = themeColors()
    const floor = rgb255(theme.sceneFloor || theme.surface, "#152132")
    const rim = rgb255(theme.sceneWallRim || theme.primary, "#82d4ff")
    const body = theme.sceneWall ? rgb255(theme.sceneWall, "#264e7a") : mix(floor, rim, 0.35)
    const fg = rgb255(theme.fg, "#ffffff")
    return { floor, body, rim, fg }
}

export class GridLayer {
    root = new THREE.Group()
    #mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
    #texture: THREE.DataTexture | null = null
    #stop: () => void
    #unsubscribe: () => void
    #frame: string | null = null
    #lut = new Uint8Array(256 * 4)
    #colors = planColors()
    #last: { grid: OccupancyGridMessage; timestamp: number | undefined } | null = null
    settings: Store<GridSettings>
    context: LayerContext

    constructor(context: LayerContext, topic: Topic, settings: Store<GridSettings>) {
        this.context = context
        this.settings = settings
        this.#mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }),
        )
        this.#mesh.matrixAutoUpdate = false
        this.root.add(this.#mesh)
        this.#unsubscribe = settings.subscribe(() => this.#restyle())
        addEventListener("dimos-react-theme", this.#onTheme)
        this.#restyle()
        this.#stop = subscribeDecoded(
            context,
            topic,
            { maxHz: 2 },
            (grid: OccupancyGridMessage, timestamp: number | undefined) => this.#onGrid(grid, timestamp),
        )
    }

    #onTheme = () => {
        this.#colors = planColors()
        this.#restyle()
    }

    #restyle() {
        this.#mesh.material.opacity = this.settings.get().opacity
        this.#buildLut()
        if (this.#last) {
            this.#onGrid(this.#last.grid, this.#last.timestamp)
        }
        this.context.viewer.requestRender()
    }

    /** value (-1..100, as the u8 it arrives as) → rgba */
    #buildLut() {
        const style = this.settings.get().style
        const { floor, body, rim, fg } = this.#colors
        for (let byte = 0; byte < 256; byte++) {
            const value = byte > 127 ? byte - 256 : byte
            let rgba: number[]
            if (value < 0) {
                rgba = style === "map" ? [...mix(fg, floor, 0.5), 40] : [0, 0, 0, 0]
            } else if (style === "map") {
                const shade = mix(fg, floor, value / 100)
                rgba = value === 0 ? [...fg, 70] : [...shade, 230]
            } else if (value === 0) {
                rgba = [...floor, 215]
            } else {
                // a cost brightens from the floor through the wall body toward the rim (lethal is drawn per cell)
                const t = Math.sqrt(Math.min(value, LETHAL - 1) / LETHAL)
                rgba = [...(t < 0.6 ? mix(floor, body, t / 0.6) : mix(body, rim, ((t - 0.6) / 0.4) * 0.7)), 235]
            }
            this.#lut.set(rgba.map(Math.round), byte * 4)
        }
    }

    #onGrid(grid: OccupancyGridMessage, timestamp: number | undefined) {
        const info = grid.info
        const data = grid.data
        if (!info || !info.width || !info.height || !data || data.length < info.width * info.height) {
            this.context.setStatus({ problem: "empty or truncated grid" })
            return
        }
        const { width, height, resolution, origin } = info
        this.#last = { grid, timestamp }
        this.#frame = grid.header?.frame_id ?? ""
        if (!this.#texture || this.#texture.image.width !== width || this.#texture.image.height !== height) {
            this.#texture?.dispose()
            this.#texture = new THREE.DataTexture(new Uint8Array(width * height * 4), width, height)
            this.#texture.magFilter = THREE.NearestFilter
            this.#texture.colorSpace = THREE.SRGBColorSpace
            this.#mesh.material.map = this.#texture
            this.#mesh.material.needsUpdate = true
        }
        const pixels = this.#texture.image.data as Uint8Array
        const lut = this.#lut
        const bytes = new Uint8Array(data.buffer, data.byteOffset, width * height)
        const costmap = this.settings.get().style === "costmap"
        const { body, rim } = this.#colors
        const lethal = (column: number, row: number) =>
            column < 0 || row < 0 || column >= width || row >= height || bytes[row * width + column] === LETHAL
        for (let index = 0; index < width * height; index++) {
            if (costmap && bytes[index] === LETHAL) {
                const column = index % width,
                    row = (index - column) / width
                const inside = lethal(column - 1, row) &&
                    lethal(column + 1, row) &&
                    lethal(column, row - 1) &&
                    lethal(column, row + 1)
                pixels.set([...(inside ? body : rim), 255], index * 4)
                continue
            }
            const at = bytes[index] * 4
            pixels[index * 4] = lut[at]
            pixels[index * 4 + 1] = lut[at + 1]
            pixels[index * 4 + 2] = lut[at + 2]
            pixels[index * 4 + 3] = lut[at + 3]
        }
        this.#texture.needsUpdate = true
        // the plane spans the grid, its corner at the origin pose (cell (0,0) is the first row of data)
        const size = new THREE.Vector3(width * resolution, height * resolution, 1)
        const center = new THREE.Matrix4().makeTranslation(size.x / 2, size.y / 2, this.settings.get().lift)
        this.#mesh.matrix
            .copy(poseMatrix(origin))
            .multiply(center)
            .multiply(new THREE.Matrix4().makeScale(size.x, size.y, 1))
        this.context.setStatus({
            info: `${width}×${height} @ ${resolution.toFixed(2)} m · ${this.#frame || "no frame"}`,
        })
        this.context.viewer.noteData(timestamp)
    }

    update(frame: FrameInfo) {
        if (this.#frame !== null) {
            placeLayer(this.context, this.root, this.#frame, frame.fixedFrame)
        }
    }

    dispose() {
        this.#stop()
        this.#unsubscribe()
        removeEventListener("dimos-react-theme", this.#onTheme)
        this.#texture?.dispose()
        this.#mesh.geometry.dispose()
        this.#mesh.material.dispose()
    }
}

export type GridSettingsEditorProps = LayerSettingsProps<GridSettings>

export function GridSettingsEditor({ settings }: GridSettingsEditorProps) {
    const value = useStore(settings)
    return (
        <div className="dr-layer-settings-grid">
            <Field label="Style">
                <Select
                    value={value.style}
                    options={[
                        ["costmap", "costmap (floor plan)"],
                        ["map", "map (gray)"],
                    ]}
                    onChange={(style: GridSettings["style"]) => settings.update({ style })}
                />
            </Field>
            <Field label="Opacity">
                <Slider
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={value.opacity}
                    format={(opacity: number) => `${Math.round(opacity * 100)}%`}
                    onChange={(opacity: number) => settings.update({ opacity })}
                />
            </Field>
        </div>
    )
}

registerLayer<GridSettings>({
    id: "occupancy",
    label: "Occupancy grid",
    types: ["nav_msgs.OccupancyGrid"],
    defaults: (topic): GridSettings => ({
        opacity: 0.85,
        style: /cost/i.test(topic?.name ?? "") ? "costmap" : "map",
        lift: 0.01,
    }),
    create: (context, topic, settings) => {
        if (!topic) {
            throw new Error("the occupancy layer draws a topic (it has no setData)")
        }
        return new GridLayer(context, topic, settings)
    },
    Settings: GridSettingsEditor,
})
