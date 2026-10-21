// One camera, as a point layer colors from it: its live picture as a texture (the 3D view's small preview stream), its
// lens model from the CameraInfo for its frame, and its frame_id. Several cameras can share one CameraInfo topic, so
// every info topic is read and only messages for this camera's frame count (the name-matched topic when either side
// has no frame_id), as the Camera in 3D layer does.
import * as THREE from "three"
import type { LayerContext } from "../layers/registry.ts"
import { subscribeDecoded } from "../layers/helpers.ts"
import { headerFrameId } from "../lcm/lcm.ts"
import type { Topic } from "../transport.ts"
import { cameraInfoFor } from "../video.ts"
import { type CameraModel, cameraModel } from "dimos-react/three"

export class CameraFeed {
    readonly texture: THREE.VideoTexture
    model: CameraModel | null = null
    frame: string | null = null
    #element: HTMLVideoElement
    #videoCallback = 0
    #stops: (() => void)[] = []
    #stopFrame: (() => void) | null = null
    #infoKeys = new Set<string>()
    #onFrame: () => void

    /** @param onFrame each new picture (the view only redraws on demand) */
    constructor(readonly context: LayerContext, readonly topic: Topic, onFrame: () => void) {
        this.#onFrame = onFrame
        const source = context.video.acquire(topic, "preview")
        this.#element = context.video.element(source)
        this.texture = new THREE.VideoTexture(this.#element)
        // colors go to the points as the bytes are, like their gradient colors
        this.texture.colorSpace = THREE.NoColorSpace
        const onVideoFrame = () => {
            onFrame()
            this.#videoCallback = this.#element.requestVideoFrameCallback(onVideoFrame)
        }
        this.#videoCallback = this.#element.requestVideoFrameCallback(onVideoFrame)
        this.#stopFrame = context.connection.subscribe(topic.key, { delivery: "latest", maxHz: 1 }, (message) => {
            const frame = headerFrameId(topic.type, message.bytes)
            if (frame !== null) {
                this.frame ||= frame
                this.#stopFrame?.()
                this.#stopFrame = null
            }
        })
        this.findInfo()
    }

    /** Listens on every CameraInfo topic not yet listened to (they can come onto the bus after the camera does). */
    findInfo() {
        if (this.model) {
            return
        }
        const infos = this.context.topics().filter((info) => info.type === "sensor_msgs.CameraInfo" && !this.#infoKeys.has(info.key))
        const named = cameraInfoFor(this.topic, this.context.topics().filter((info) => info.type === "sensor_msgs.CameraInfo"), this.context.profile.cameras.cameraInfo)
        for (const info of infos) {
            this.#infoKeys.add(info.key)
            this.#stops.push(
                subscribeDecoded(this.context, info, { maxHz: 30, reliable: true }, (message) => {
                    const infoFrame = message.header?.frame_id ?? ""
                    const mine = infoFrame && this.frame ? infoFrame === this.frame : info.key === named?.key
                    const model = mine ? cameraModel(message) : null
                    if (!model) {
                        return
                    }
                    this.frame ||= infoFrame
                    this.model = model
                    // a camera's model doesn't change: stop listening (a shared port is busy)
                    this.#stops.forEach((stop) => stop())
                    this.#stops = []
                    this.#onFrame()
                })
            )
        }
    }

    /** what's missing before it can color anything, or null */
    get waitingFor(): string | null {
        return this.model ? (this.frame ? null : "the camera's frame_id") : `a CameraInfo for ${this.topic.name}`
    }

    dispose() {
        this.#element.cancelVideoFrameCallback(this.#videoCallback)
        this.#stops.forEach((stop) => stop())
        this.#stopFrame?.()
        this.context.video.release(this.topic, "preview")
        this.texture.dispose()
    }
}
