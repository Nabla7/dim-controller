// A simulated world (dimos.scene_data.v1): a SceneData module answers a request on /scene_data_request with the
// world's bodies, geoms, meshes, height fields, textures and lights on /scene_data. This layer asks until one answers,
// builds the world once, and moves the bodies that move (the scripted movers) by their TF frames.
import * as THREE from "three"
import { registerLayer, type LayerContext } from "../core/layers/registry.ts"
import { disposeTree } from "../core/layers/helpers.ts"
import { decode, encode } from "../core/lcm/lcm.ts"
import { useStore, type Store } from "../core/store.ts"
import { dimosKey, type Publisher, type Topic } from "../core/transport.ts"
import { Field, Slider, Toggle } from "../ui/controls.tsx"
import { buildScene, type SceneData } from "../core/sceneData.ts"

export const SCENE_DATA = dimosKey("/scene_data", "std_msgs.String")
export const SCENE_DATA_REQUEST = dimosKey("/scene_data_request", "std_msgs.String")
/** how often to ask until a SceneData module answers (the sim may start after the page) */
const ASK_EVERY_MS = 3000

export interface SimSceneSettings {
    opacity: number
    /** geoms that start above this height (m) are left out, so ceilings and upper floors don't hide the robot */
    cutAbove: number
    /** add the world's own lights to the view's */
    lights: boolean
}

/** a geom's lowest point in world coordinates (its body's pose included), to cut ceilings by */
function lowestZ(mesh: THREE.Mesh): number {
    mesh.geometry.computeBoundingBox()
    const body = mesh.parent!
    body.updateMatrix()
    mesh.updateMatrix()
    const inWorld = new THREE.Matrix4().multiplyMatrices(body.matrix, mesh.matrix)
    return new THREE.Box3().copy(mesh.geometry.boundingBox!).applyMatrix4(inWorld).min.z
}

class SimSceneLayer {
    readonly root = new THREE.Group()
    #scene: ReturnType<typeof buildScene> | null = null
    #id: string | null = null
    #stop: () => void
    #asking: ReturnType<typeof setInterval>
    #requests: Publisher | null = null

    constructor(readonly context: LayerContext, readonly topic: Topic, readonly settings: Store<SimSceneSettings>) {
        // scene coordinates are the world frame; the layer root is re-placed in the view's fixed frame every frame
        this.root.matrixAutoUpdate = false
        settings.subscribe(() => this.#applySettings())
        this.#stop = context.connection.subscribe(topic.key, { delivery: "reliable" }, (message) => {
            let data: SceneData
            try {
                data = JSON.parse(String(decode(topic.type, message.bytes).data)) as SceneData
            } catch (error) {
                context.setStatus({ problem: `not a dimos.scene_data.v1 message: ${error}` })
                return
            }
            if (data.format !== "dimos.scene_data.v1" || data.id === this.#id) {
                return
            }
            this.#show(data)
        })
        context.setStatus({ info: "asking for the scene", problem: "no SceneData module has answered yet (asks every 3 s)" })
        this.#ask()
        this.#asking = setInterval(() => this.#ask(), ASK_EVERY_MS)
    }

    #ask() {
        if (this.#scene) {
            return
        }
        const client = this.context.connection.client
        if (!client) {
            return
        }
        this.#requests ??= client.publisher(SCENE_DATA_REQUEST, { delivery: "reliable" })
        try {
            this.#requests.put(encode("std_msgs.String", { data: "dim-controller" }))
        } catch {
            // not open yet: the next tick asks again
        }
    }

    #show(data: SceneData) {
        if (this.#scene) {
            this.root.remove(this.#scene.root)
            disposeTree(this.#scene.root)
        }
        this.#scene = buildScene(data)
        this.#id = data.id
        this.root.add(this.#scene.root)
        this.#applySettings()
        const geoms = data.bodies.reduce((count, body) => count + body.geoms.length, 0)
        const movers = data.bodies.filter((body) => body.mocap).length
        this.context.setStatus({
            info: `${data.id} · ${data.bodies.length} bodies · ${geoms} geoms · ${Object.keys(data.meshes).length} meshes${movers ? ` · ${movers} moving` : ""}`,
            problem: null,
            frame: data.frame,
        })
        this.context.viewer.requestRender()
    }

    #applySettings() {
        const scene = this.#scene
        if (!scene) {
            return
        }
        const { opacity, cutAbove, lights } = this.settings.get()
        scene.root.traverse((object) => {
            const mesh = object as THREE.Mesh
            if (!mesh.isMesh) {
                return
            }
            const material = mesh.material as THREE.MeshStandardMaterial
            const alpha = (mesh.userData.baseOpacity as number) * opacity
            material.opacity = alpha
            material.transparent = alpha < 1
            material.depthWrite = alpha >= 1
            mesh.visible = lowestZ(mesh) <= cutAbove
        })
        for (const light of scene.lights) {
            light.visible = lights
        }
        this.context.viewer.requestRender()
    }

    update(frame: { fixedFrame: string }) {
        const scene = this.#scene
        if (!scene) {
            return
        }
        const world = this.context.tf.lookup("world", frame.fixedFrame)
        if (world) {
            if (!this.root.matrix.equals(world)) {
                this.root.matrix.copy(world)
                this.root.matrixWorldNeedsUpdate = true
                this.context.viewer.requestRender()
            }
        }
        // movers: their TF frame (world -> body) wins over the pose they started at
        for (const [name, group] of scene.bodies) {
            if (!group.userData.mocap) {
                continue
            }
            const pose = this.context.tf.lookup(name, "world")
            if (pose) {
                const before = group.position.clone()
                pose.decompose(group.position, group.quaternion, group.scale)
                if (!before.equals(group.position)) {
                    this.context.viewer.requestRender()
                }
            }
        }
    }

    dispose() {
        clearInterval(this.#asking)
        this.#stop()
        this.#requests?.close()
        if (this.#scene) {
            disposeTree(this.#scene.root)
        }
    }
}

function SimSceneSettingsEditor({ settings }: { settings: Store<SimSceneSettings>; topic: Topic }) {
    const value = useStore(settings)
    return (
        <>
            <Field label="Opacity">
                <Slider min={0.1} max={1} step={0.05} value={value.opacity} format={(opacity) => `${Math.round(opacity * 100)}%`} onChange={(opacity) => settings.update({ opacity })} />
            </Field>
            <Field label="Hide above" hint="leaves out ceilings and upper floors">
                <Slider min={0.5} max={30} step={0.1} value={value.cutAbove} format={(height) => `${height.toFixed(1)} m`} onChange={(cutAbove) => settings.update({ cutAbove })} />
            </Field>
            <Field label="The world's lights">
                <Toggle value={value.lights} onChange={(lights) => settings.update({ lights })} />
            </Field>
        </>
    )
}

registerLayer<SimSceneSettings>({
    id: "sim-scene",
    label: "Simulated world",
    types: ["std_msgs.String"],
    names: ["/scene_data"],
    // scene_data is published only when asked, so discovery never sees it: always list it
    topics: [{ key: SCENE_DATA, name: "/scene_data", type: "std_msgs.String" }],
    defaults: { opacity: 1, cutAbove: 2.5, lights: false },
    create: (context, topic, settings) => new SimSceneLayer(context, topic, settings),
    Settings: SimSceneSettingsEditor,
})
