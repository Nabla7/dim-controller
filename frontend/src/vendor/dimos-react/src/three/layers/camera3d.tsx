// sensor_msgs.Image / CompressedImage in 3D: the camera's frustum, with the picture on its far plane, placed at the
// camera's TF frame. Intrinsics come from the matching CameraInfo topic (or a 70° guess without one). The picture is
// the shared camera stream (CameraStreams): a live H.264 track as a video texture, a replay's frames (an ImageBitmap /
// ImageData) drawn into a canvas texture, depth as a GPU heat map.
import * as THREE from "three"
import { type Store, useStore } from "../store.ts"
import { headerFrameId } from "../../lcm.ts"
import { themeColors } from "../../theme/theme.ts"
import { cameraInfoFor, type CameraStreams, isDepthTopic } from "../../components/camera.tsx"
import { DEPTH_COLORMAPS } from "../../components/media.tsx"
import { FatLines } from "../lines.ts"
import { cssColor } from "../robot_model.ts"
import { type DepthLook, DepthMaterial } from "../../camera/depth.ts"
import {
    type LayerContext,
    type LayerSettingsProps,
    placeLayer,
    registerLayer,
    subscribeDecoded,
    type Topic,
} from "./registry.ts"
import type { FrameInfo } from "../viewer.ts"
import { RangeInput } from "../look_editor.tsx"
import { Field, Select, Slider, Toggle } from "../../components/controls.tsx"

/**
 * `distance`: meters from the camera to the picture; `convention` "optical": z forward, x right, y down (ROS
 * *_optical_frame), "body": x forward, y left, z up
 */
export interface Camera3dSettings {
    distance: number
    opacity: number
    image: boolean
    frustum: boolean
    convention: "auto" | "optical" | "body"
    depth: DepthLook
}

export const DEFAULT_DEPTH_LOOK: DepthLook = { colormap: "turbo", near: null, far: null }

/** Pinhole intrinsics in pixels. */
interface Intrinsics {
    width: number
    height: number
    fx: number
    fy: number
    cx: number
    cy: number
}

/** A decoded sensor_msgs.CameraInfo (the fields the layer reads; older messages spell `K`). */
interface CameraInfoMessage {
    header?: { frame_id?: string }
    width: number
    height: number
    K?: number[]
    k?: number[]
}

type CameraHandle = ReturnType<CameraStreams["acquire"]>

// optical (x right, y down, z forward) → body (x forward, y left, z up)
const OPTICAL_TO_BODY = new THREE.Matrix4().set(0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1)

function guess(width: number, height: number): Intrinsics {
    const fx = width / 2 / Math.tan(THREE.MathUtils.degToRad(70) / 2)
    return { width, height, fx, fy: fx, cx: width / 2, cy: height / 2 }
}

export class Camera3dLayer {
    root = new THREE.Group()
    #content = new THREE.Group()
    #plane: THREE.Mesh<THREE.BufferGeometry, THREE.Material>
    #picture: THREE.MeshBasicMaterial | null = null
    #depth: DepthMaterial | null = null
    #depthSize: [number, number] = [0, 0]
    #frustum: FatLines
    #texture: THREE.Texture | null = null
    /** what the texture shows: the live stream, or a replay canvas's "WxH" */
    #textureOf: unknown = null
    #canvas: HTMLCanvasElement | null = null
    #frame: string | null = null
    #intrinsics: Intrinsics | null = null
    #infoKey = ""
    #stopInfo: (() => void) | null = null
    #stopFrame: (() => void) | null = null
    #stops: (() => void)[] = []
    #camera: CameraHandle
    #element: HTMLVideoElement | null = null
    #videoCallback = 0
    #lastShape = ""
    #checkedInfoAt = 0
    settings: Store<Camera3dSettings>
    topic: Topic
    context: LayerContext

    constructor(context: LayerContext, topic: Topic, settings: Store<Camera3dSettings>) {
        this.context = context
        this.topic = topic
        this.settings = settings
        this.#content.matrixAutoUpdate = false
        // a floating camera picture is not a place: picks go through it
        this.#content.userData.noPick = true
        this.root.add(this.#content)
        this.#frustum = new FatLines(context.viewer.resolution, {
            width: 1.5,
            color: cssColor(themeColors().warn, "yellow"),
        })
        this.#camera = context.video.acquire(topic)
        if (isDepthTopic(topic)) {
            this.#depth = new DepthMaterial()
            this.#plane = new THREE.Mesh(new THREE.BufferGeometry(), this.#depth.material)
            this.#stops.push(
                this.#camera.depth.subscribe(() => {
                    const image = this.#camera.depth.get().image
                    if (image && this.#depth) {
                        this.#depthSize = [image.width, image.height]
                        this.#depth.update(image, this.settings.get().depth ?? DEFAULT_DEPTH_LOOK)
                        this.#reshape(false)
                        context.viewer.requestRender()
                    }
                }),
            )
        } else {
            this.#picture = new THREE.MeshBasicMaterial({
                side: THREE.DoubleSide,
                transparent: true,
                toneMapped: false,
            })
            this.#plane = new THREE.Mesh(new THREE.BufferGeometry(), this.#picture)
            this.#stops.push(this.#camera.video.subscribe(() => this.#onVideo()))
            this.#onVideo()
        }
        // pictures don't write depth and draw in a fixed order (depth over colour), so two in one place pick a winner instead of flickering
        this.#plane.renderOrder = this.#depth ? 2 : 1
        this.#plane.material.depthWrite = false
        this.#content.add(this.#plane, this.#frustum.object)
        this.#stops.push(settings.subscribe(() => this.#reshape(true)))
        this.#findInfo()
    }

    /** a live stream → a video texture (each decoded frame asks for a redraw); a replay canvas → a canvas texture */
    #onVideo() {
        // only a color topic's layer listens to video, and it has a picture material
        const picture = this.#picture
        if (!picture) {
            return
        }
        const state = this.#camera.video.get()
        if (state.stream) {
            if (this.#textureOf !== state.stream) {
                this.#textureOf = state.stream
                this.#texture?.dispose()
                const element: HTMLVideoElement = this.context.video.element(this.#camera)
                this.#element = element
                this.#texture = new THREE.VideoTexture(element)
                this.#texture.colorSpace = THREE.SRGBColorSpace
                picture.map = this.#texture
                picture.needsUpdate = true
                const onVideoFrame = () => {
                    this.context.viewer.requestRender()
                    this.#videoCallback = element.requestVideoFrameCallback(onVideoFrame)
                }
                this.#videoCallback = element.requestVideoFrameCallback?.(onVideoFrame) ?? 0
            }
        } else if (state.image) {
            // a replay's frame: drawn into this layer's canvas, re-uploaded per frame
            const image = state.image
            this.#canvas ??= document.createElement("canvas")
            const canvas = this.#canvas
            const shape = `${image.width}x${image.height}`
            if (canvas.width !== image.width || canvas.height !== image.height) {
                canvas.width = image.width
                canvas.height = image.height
            }
            const context2d = canvas.getContext("2d")!
            if (image instanceof ImageData) {
                context2d.putImageData(image, 0, 0)
            } else {
                context2d.drawImage(image, 0, 0)
            }
            if (this.#textureOf !== shape) {
                // a new size needs a new GPU texture
                this.#textureOf = shape
                this.#texture?.dispose()
                this.#texture = new THREE.CanvasTexture(canvas)
                this.#texture.colorSpace = THREE.SRGBColorSpace
                picture.map = this.#texture
                picture.needsUpdate = true
            }
            // set just above when the shape changed, else kept from the last frame of this shape
            this.#texture!.needsUpdate = true
        } else {
            return
        }
        this.#reshape(false)
        this.context.viewer.requestRender()
    }

    /**
     * The image's own frame comes from one raw image; intrinsics from the CameraInfo whose frame_id is that frame.
     * Several cameras can share one CameraInfo topic (Spot publishes all five on one port), so every info topic is
     * read and only messages for this camera's frame are used; the name-matched topic is the fallback when either
     * side has no frame_id.
     */
    #findInfo() {
        this.#checkedInfoAt = performance.now()
        if (this.#frame === null && !this.#stopFrame) {
            this.#stopFrame = this.context.source.subscribe(
                this.topic.key,
                { delivery: "latest", maxHz: 1 },
                (message) => {
                    let frame: string | null
                    // a source that already decoded it: any shape, maybe a frame_id
                    const value = (message.value ?? message.decoded) as {
                        frame?: string
                        header?: { frame_id?: string }
                    } | undefined
                    if (value) {
                        frame = value.frame ?? value.header?.frame_id ?? null
                    } else {
                        try {
                            frame = headerFrameId(this.topic.type, message.bytes)
                        } catch {
                            frame = null
                        }
                    }
                    if (frame === null) {
                        return
                    }
                    this.#frame = frame
                    this.#stopFrame?.()
                    this.#stopFrame = null
                    this.#reshape(false)
                },
            )
        }
        const infos = this.context.topics().filter((topic) => topic.type === "sensor_msgs.CameraInfo")
        const key = infos.map((topic) => topic.key).join(",")
        if (key === this.#infoKey || this.#intrinsics) {
            return
        }
        this.#stopInfo?.()
        this.#infoKey = key
        const named = cameraInfoFor(this.topic, infos, this.context.options?.cameraInfo ?? {})
        const stops = infos.map((info) =>
            subscribeDecoded(this.context, info, { maxHz: 30, reliable: true }, (message: CameraInfoMessage) => {
                const K = message.K ?? message.k ?? []
                const infoFrame = message.header?.frame_id ?? ""
                // an image without a frame_id (the go2 sim's) is matched by name and placed at its info's frame
                const mine = infoFrame && this.#frame ? infoFrame === this.#frame : info.key === named?.key
                if (!mine || !message.width || !K[0]) {
                    return
                }
                if (!this.#frame) {
                    this.#frame = infoFrame
                }
                this.#intrinsics = {
                    width: message.width,
                    height: message.height,
                    fx: K[0],
                    fy: K[4],
                    cx: K[2],
                    cy: K[5],
                }
                // intrinsics don't change: stop listening (a shared port is busy)
                this.#stopInfo?.()
                this.#stopInfo = null
                this.#reshape(false)
            })
        )
        this.#stopInfo = () => stops.forEach((stop) => stop())
    }

    #reshape(force: boolean) {
        const settings = this.settings.get()
        const video = this.#camera.video.get()
        const [width, height] = this.#depth ? this.#depthSize : [video.width, video.height]
        const intrinsics = this.#intrinsics ?? (width ? guess(width, height) : null)
        if (!intrinsics) {
            return
        }
        const shape = `${JSON.stringify(intrinsics)}/${settings.distance}/${settings.convention}/${this.#frame}`
        if (shape === this.#lastShape && !force) {
            return
        }
        this.#lastShape = shape
        const d = settings.distance
        const corner = (u: number, v: number) =>
            new THREE.Vector3(((u - intrinsics.cx) / intrinsics.fx) * d, ((v - intrinsics.cy) / intrinsics.fy) * d, d)
        const corners = [
            corner(0, 0),
            corner(intrinsics.width, 0),
            corner(intrinsics.width, intrinsics.height),
            corner(0, intrinsics.height),
        ]
        const [topLeft, topRight, bottomRight, bottomLeft] = corners
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(
                corners.flatMap((point) => point.toArray()),
                3,
            ),
        )
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2))
        geometry.setIndex([0, 1, 2, 0, 2, 3])
        this.#plane.geometry.dispose()
        this.#plane.geometry = geometry
        if (this.#picture) {
            this.#picture.opacity = settings.opacity
        } else if (this.#depth) {
            this.#depth.material.uniforms.opacity.value = settings.opacity
        }
        this.#plane.visible = settings.image
        this.#frustum.clear()
        for (const point of corners) {
            this.#frustum.push(0, 0, 0, point.x, point.y, point.z)
        }
        for (
            const [a, b] of [
                [topLeft, topRight],
                [topRight, bottomRight],
                [bottomRight, bottomLeft],
                [bottomLeft, topLeft],
            ]
        ) {
            this.#frustum.push(a.x, a.y, a.z, b.x, b.y, b.z)
        }
        this.#frustum.commit()
        this.#frustum.object.visible = settings.frustum
        // an image's frame_id is optical by ROS convention, so auto means optical unless the frame says it's a body frame
        const optical = settings.convention === "optical" ||
            (settings.convention === "auto" && !/(^|_)body(_|$)/i.test(this.#frame ?? ""))
        this.#content.matrix.copy(optical ? new THREE.Matrix4() : OPTICAL_TO_BODY)
        this.#content.matrixWorldNeedsUpdate = true
        this.context.setStatus({
            info: `${intrinsics.width}×${intrinsics.height}${this.#intrinsics ? "" : " (no CameraInfo: 70° guess)"} · ${
                optical ? "optical" : "body"
            } frame ${this.#frame || "?"}`,
        })
        this.context.viewer.requestRender()
    }

    update(frame: FrameInfo) {
        if (!this.#intrinsics && frame.now - this.#checkedInfoAt > 2000) {
            this.#findInfo()
        }
        if (this.#frame === "" && !this.#intrinsics) {
            // an image with no frame_id is placed by its CameraInfo's frame: it waits for one rather than sit at the origin
            if (this.root.visible) {
                this.root.visible = false
                this.context.viewer.requestRender()
            }
            this.context.setStatus({ problem: "waiting for a CameraInfo (the image has no frame_id)" })
        } else if (this.#frame !== null) {
            if (placeLayer(this.context, this.root, this.#frame, frame.fixedFrame)) {
                this.#reshape(false)
            }
        }
    }

    dispose() {
        this.#element?.cancelVideoFrameCallback?.(this.#videoCallback)
        this.#stops.forEach((stop) => stop())
        this.#depth?.dispose()
        this.#stopInfo?.()
        this.#stopFrame?.()
        this.context.video.release(this.topic)
        this.#texture?.dispose()
        this.#plane.geometry.dispose()
        this.#picture?.dispose()
        this.#frustum.dispose()
    }
}

export type Camera3dSettingsEditorProps = LayerSettingsProps<Camera3dSettings>

export function Camera3dSettingsEditor({ settings, topic }: Camera3dSettingsEditorProps) {
    const value = useStore(settings)
    const depth = value.depth ?? DEFAULT_DEPTH_LOOK
    const slider = (
        label: string,
        key: "distance" | "opacity",
        min: number,
        max: number,
        step: number,
        format: (value: number) => string,
    ) => (
        <Field label={label}>
            <Slider
                min={min}
                max={max}
                step={step}
                value={value[key]}
                format={format}
                onChange={(next: number) => settings.update({ [key]: next })}
            />
        </Field>
    )
    return (
        <div className="dr-layer-settings-grid">
            <Field label="Picture">
                <Toggle value={value.image} onChange={(image: boolean) => settings.update({ image })} />
            </Field>
            <Field label="Frustum">
                <Toggle value={value.frustum} onChange={(frustum: boolean) => settings.update({ frustum })} />
            </Field>
            {slider("Distance", "distance", 0.2, 10, 0.1, (distance: number) => `${distance.toFixed(1)} m`)}
            {slider("Opacity", "opacity", 0.1, 1, 0.05, (opacity: number) => `${Math.round(opacity * 100)}%`)}
            {topic && isDepthTopic(topic)
                ? [
                    <Field label="Colormap" key="colormap">
                        <Select
                            value={depth.colormap}
                            options={DEPTH_COLORMAPS}
                            onChange={(colormap: string) => settings.update({ depth: { ...depth, colormap } })}
                        />
                    </Field>,
                    <Field label="Range" hint="meters; empty = automatic (2nd–98th percentile)" key="range">
                        <span className="dr-range-inputs">
                            <RangeInput
                                value={depth.near}
                                onChange={(near: number | null) => settings.update({ depth: { ...depth, near } })}
                            />
                            <RangeInput
                                value={depth.far}
                                onChange={(far: number | null) => settings.update({ depth: { ...depth, far } })}
                            />
                        </span>
                    </Field>,
                ]
                : null}
            <Field label="Frame">
                <Select
                    value={value.convention}
                    options={[
                        ["auto", "auto (optical unless named body)"],
                        ["optical", "optical (z forward)"],
                        ["body", "body (x forward)"],
                    ]}
                    onChange={(convention: Camera3dSettings["convention"]) => settings.update({ convention })}
                />
            </Field>
        </div>
    )
}

registerLayer<Camera3dSettings>({
    id: "camera3d",
    label: "Camera in 3D",
    types: ["sensor_msgs.Image", "sensor_msgs.CompressedImage"],
    defaults: {
        distance: 1.5,
        opacity: 0.95,
        image: true,
        frustum: true,
        convention: "auto",
        depth: DEFAULT_DEPTH_LOOK,
    },
    // camera panels show images; projecting one into the scene is opt-in
    enabledByDefault: () => false,
    create: (context, topic, settings) => {
        if (!topic) {
            throw new Error("the camera3d layer draws a topic (it has no setData)")
        }
        return new Camera3dLayer(context, topic, settings)
    },
    Settings: Camera3dSettingsEditor,
})
