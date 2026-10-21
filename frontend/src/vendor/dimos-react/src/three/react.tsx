// deno-lint-ignore-file no-explicit-any -- transforms and poses as apps hand them in, any shape
// The 3D view as React components. <Scene3D> owns a Viewer (three.js renderer, orbit/pan/zoom, follow camera) and a
// TfTree; layers inside it add themselves to its scene and take data from a topic (through the data source: live
// zenoh-gateway, a replay, a test source) or from props. <TopicLayers> draws every discovered topic with its layer
// type (the Controller's layer list); <LayersPanel> (panels.js) switches them and edits their settings.
//
//     h(Scene3D, { followFrame: "base_link", style: { height: 480 } },
//         h(TfFeed),                                                   // every tf2_msgs.TFMessage topic → the TF tree
//         h(TfFrames),
//         h(PointCloud, { topic: "dimos/lidar/sensor_msgs.PointCloud2" }),
//         h(Path, { topic: "dimos/path/nav_msgs.Path" }),
//         h(Pose, { topic: "dimos/odom/nav_msgs.Odometry", trail: true }),
//         h(RobotModel, { kind: "dog", frame: "base_link" }))
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { DependencyList, HTMLAttributes, MutableRefObject, ReactNode } from "react"
import * as THREE from "three"
import { cx } from "../cx.ts"
import { decodeMessage, parseKey, useDataSource, useTopicList } from "../data.ts"
import { cameraStreamsFor } from "../components/camera.tsx"
import { Viewer } from "./viewer.ts"
import { ViewCube } from "./view_cube.ts"
import type { ViewCubeCorner } from "./view_cube.ts"
import { ChaseHeading, headingOf, turnAbout } from "./follow_heading.ts"
import { TfTree } from "./tf.ts"
import { cssColor, disposeTree, robotModel } from "./robot_model.ts"
import { Store, useStore } from "./store.ts"
import { IconButton, Select } from "../components/controls.tsx"
import "./layers/index.ts"
import { defaultSettings, followOnTop, layerTypeById, RobotPose } from "./layers/registry.ts"
import { CLOUD_DEFAULTS, CloudLayer } from "./layers/pointcloud.tsx"
import { POSE_DEFAULTS, PoseLayer } from "./layers/pose.tsx"
import { PathLayer } from "./layers/path.tsx"
import { PoseArrayLayer } from "./layers/pose_array.tsx"
import { TF_DEFAULTS, TfFramesLayer } from "./layers/tf_frames.tsx"
import { checkTf, confirmedIssues } from "./tf_check.ts"
import { FrameHighlighter } from "./frame_highlight.ts"
import { poseMatrix as poseMatrixOf } from "./layers/pose.tsx"
import type { CameraStreams } from "../components/camera.tsx"
import type { SelectProps } from "../components/controls.tsx"
import type { FrameInfo, RenderStats } from "./viewer.ts"
import type { LayerContext, LayerInstance, LayerStatus, LayerType, Topic } from "./layers/registry.ts"
import type { CheckTfInput } from "./tf_check.ts"
import type { LayerEntry, LayerManager } from "./layers/manager.ts"
import type { TfIssue } from "./tf_check.ts"

export { pointCloud2ToPositions } from "./layers/pointcloud.tsx"
export { poseMatrix, poseOf } from "./layers/pose.tsx"
export { colorFor } from "./layers/path.tsx"

/** Where the robot and the followed frame were found, last frame (a Scene3D's `frameInfo` Store). */
export interface SceneFrameInfo {
    fixedFrame: string
    robotFound: boolean
    followFound: boolean
    following: boolean
}

/** A Scene3D's camera actions. */
export interface SceneActions {
    recenter(): void
    topDown(): void
}

/** A mounted Scene3D, as its layers see it. */
export interface Scene {
    viewer: Viewer
    tf: TfTree
    fixedFrame: string
    source: LayerContext["source"]
    video: CameraStreams
    robotPose: RobotPose
    options: LayerContext["options"]
    topics: () => Topic[]
    frameInfo: Store<SceneFrameInfo>
    actions: SceneActions
}

/** What useScene gives: a mounted Scene, or (outside a Scene3D, or before its viewer mounts) no viewer yet. */
export type SceneContextValue =
    | Scene
    | ({ viewer: null; tf: TfTree | null; fixedFrame: string } & Partial<Omit<Scene, "viewer" | "tf" | "fixedFrame">>)

/** What a custom layer's `create` (useLayer) returns. */
export interface SceneLayer {
    root?: THREE.Object3D
    update?(frame: FrameInfo): void
    reset?(): void
    dispose?(): void
}

const SceneContext = createContext<SceneContextValue>({ viewer: null, tf: null, fixedFrame: "world" })

/**
 * The enclosing Scene3D: `{ viewer, tf, fixedFrame, source, video, robotPose, options, frameInfo, actions }` (viewer
 * is null until it has mounted). `frameInfo`: a Store of `{ fixedFrame, robotFound, followFound, following }`;
 * `actions`: `{ recenter(), topDown() }`.
 */
export function useScene(): SceneContextValue {
    return useContext(SceneContext)
}

/** The enclosing Scene3D's Viewer (null until mounted). */
export function useViewer() {
    return useContext(SceneContext).viewer
}

/** The enclosing Scene3D's TfTree. */
export function useTf() {
    return useContext(SceneContext).tf
}

/** The fixed frame the enclosing Scene3D draws in. */
export function useFixedFrame() {
    return useContext(SceneContext).fixedFrame
}

/** The enclosing Scene3D's camera actions: `{ recenter(), topDown() }`. */
export function useSceneActions() {
    return useContext(SceneContext).actions
}

/** Calls `callback(frame)` every animation frame of the enclosing scene (frame: { now, dataNow, fixedFrame, camera }). */
export function useSceneFrame(callback: (frame: FrameInfo) => void) {
    const viewer = useViewer()
    const ref = useRef(callback)
    ref.current = callback
    useEffect(() => {
        const off = viewer?.onFrame((frame) => ref.current(frame))
        return () => {
            off?.()
        }
    }, [viewer])
}

/** The TF tree's frame names, re-rendered (at most every `throttleMs`) when the tree changes. */
export function useTfFrames({
    throttleMs = 500,
    tf: given,
}: { throttleMs?: number; tf?: TfTree | null } = {}): string[] {
    const context = useTf()
    const tf = given ?? context
    const [frames, setFrames] = useState(() => tf?.frames() ?? [])
    useEffect(() => {
        if (!tf) {
            return
        }
        let timer: ReturnType<typeof setTimeout> | undefined = undefined
        let last = ""
        const read = () => {
            timer = undefined
            const next = tf.frames()
            const signature = next.join("\n")
            if (signature !== last) {
                last = signature
                setFrames(next)
            }
        }
        read()
        const off = tf.onChange(() => {
            timer ??= setTimeout(read, throttleMs)
        })
        return () => {
            off()
            clearTimeout(timer)
        }
    }, [tf, throttleMs])
    return frames
}

/**
 * Mounts a custom layer in the enclosing scene: `create({ viewer, tf, ... })` returns
 * `{ root?: THREE.Object3D, update?(frame), reset?(), dispose?() }` (or null). `root` is added to the scene and
 * removed on cleanup, `update` runs every frame, `reset` on a replay's seek. Re-created when `deps` change; returns a
 * ref to the live layer (push new data into it from your own effects instead of re-creating it).
 */
export function useLayer<L extends SceneLayer>(
    create: (scene: Scene) => L | null,
    deps: DependencyList = [],
): MutableRefObject<L | null> {
    const scene = useScene()
    const { viewer, tf } = scene
    const ref = useRef<L | null>(null)
    useEffect(() => {
        if (!scene.viewer) {
            return
        }
        const viewer = scene.viewer
        const layer = create(scene)
        if (!layer) {
            return
        }
        if (layer.root) {
            viewer.scene.add(layer.root)
        }
        const offFrame = layer.update ? viewer.onFrame((frame) => layer.update?.(frame)) : null
        const offReset = layer.reset ? viewer.onReset(() => layer.reset?.()) : null
        ref.current = layer
        viewer.requestRender()
        return () => {
            offFrame?.()
            offReset?.()
            layer.root?.removeFromParent()
            layer.dispose?.()
            if (ref.current === layer) {
                ref.current = null
            }
            viewer.requestRender()
        }
    }, [viewer, tf, ...deps])
    return ref
}

/**
 * Sets `object.matrix` to T_fixed_frame and shows it; with no TF path it hides the object. Returns whether it could
 * be placed (and why not, through `onStatus`).
 */
export function placeInFixedFrame(
    viewer: Viewer,
    tf: TfTree,
    object: THREE.Object3D,
    frame: string,
    fixedFrame: string,
    onStatus?: (status: LayerStatus) => void,
): boolean {
    const matrix = tf.lookup(frame, fixedFrame)
    if (!matrix) {
        if (object.visible) {
            object.visible = false
            viewer.requestRender()
        }
        onStatus?.({ problem: `no TF path from "${frame}" to "${fixedFrame}"`, frame })
        return false
    }
    if (!object.visible || !object.matrix.equals(matrix)) {
        object.matrix.copy(matrix)
        object.matrixWorldNeedsUpdate = true
        object.visible = true
        viewer.requestRender()
    }
    return true
}

/** The layer context a layer type's instance gets (registry.js LayerContext). */
function layerContext(
    scene: Scene,
    setStatus: (status: LayerStatus) => void,
    extra: Partial<LayerContext> = {},
): LayerContext {
    return {
        viewer: scene.viewer,
        tf: scene.tf,
        source: scene.source,
        video: scene.video,
        robotPose: scene.robotPose,
        options: scene.options ?? {},
        topics: () => scene.topics?.() ?? [],
        setStatus,
        ...extra,
    }
}

/** A click on the scene: the point under it, what it hit, and the click. */
export interface ScenePick {
    point: THREE.Vector3
    on: string
    object?: THREE.Object3D
    event: MouseEvent
}

export interface Scene3DProps extends HTMLAttributes<HTMLDivElement> {
    fixedFrame?: string
    followFrame?: string | null
    follow?: boolean
    onFollowChange?: (follow: boolean) => void
    /** while following, the camera also turns with the followed frame's heading (yaw only): a chase camera */
    followTurns?: boolean
    robotFrame?: string | null
    viewDistance?: number
    grid?: boolean
    tf?: TfTree
    clock?: () => number
    onPick?: (pick: ScenePick) => void
    onViewer?: (viewer: Viewer) => void
    layerOptions?: { baseFrame?: string; cameraInfo?: Record<string, string> }
    topics?: () => Topic[]
    cameraPosition?: [number, number, number]
    cameraTarget?: [number, number, number]
    near?: number
    far?: number
    fov?: number
    gridSize?: number
    gridDivisions?: number
    freeOrbit?: boolean
    /** a CAD view cube in a corner (default off): true = top right, or the corner */
    viewCube?: boolean | ViewCubeCorner
}

/**
 * The 3D view. Give it a size (style/className); layers go in `children`, and any DOM children (buttons, stats) are
 * laid over it.
 *   `fixedFrame`: the frame everything is drawn in (default: the TF tree's world-ish root). `followFrame`: a TF frame
 *   the camera follows while `follow` (orbit and zoom keep following; a pan pauses it until resumed); `followTurns`
 *   turns it with that frame's heading too, ignoring sway and brief wobbles (default off). `robotFrame`:
 *   the robot's frame (default `followFrame`): the camera frames it once when it first shows up, and without it in
 *   TF the newest pose from a Pose layer stands in for it. A replay source (memorySource({ clock })) drives the data
 *   clock (fading, staleness, lifetimes) and its seek() resets the layers. `near`, `far`, `fov`, `gridSize`,
 *   `gridDivisions`, `freeOrbit`: the Viewer's options, read once when it mounts. `viewCube`: a CAD view cube in a
 *   corner (click a face / edge / corner to look from there, drag it to orbit); default off.
 */
export function Scene3D({
    fixedFrame,
    followFrame = null,
    follow = true,
    onFollowChange,
    followTurns = false,
    robotFrame,
    viewDistance = 7,
    grid = true,
    tf: givenTf,
    clock,
    onPick,
    onViewer,
    layerOptions,
    topics,
    className,
    style,
    children,
    cameraPosition,
    cameraTarget,
    near,
    far,
    fov,
    gridSize,
    gridDivisions,
    freeOrbit,
    viewCube = false,
    ...rest
}: Scene3DProps) {
    const hostRef = useRef<HTMLDivElement>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const source = useDataSource()
    const [viewer, setViewer] = useState<Viewer | null>(null)
    const tf = useMemo(() => givenTf ?? new TfTree(), [givenTf])
    const robotPose = useMemo(() => new RobotPose(), [])
    const frameInfo = useMemo(
        () => new Store<SceneFrameInfo>({ fixedFrame: "", robotFound: false, followFound: false, following: false }),
        [],
    )
    const [autoFixed, setAutoFixed] = useState("world")
    const fixed = fixedFrame || autoFixed
    const robot = robotFrame === undefined ? followFrame : robotFrame
    const current = { follow, followFrame, followTurns, robot, viewDistance, onFollowChange }
    const props = useRef(current)
    props.current = current

    useEffect(() => {
        // the effect runs once the host div below is mounted
        const created = new Viewer(hostRef.current!, {
            clock: clock ?? (() => source.now?.() ?? Date.now()),
            grid,
            near,
            far,
            fov,
            gridSize,
            gridDivisions,
            freeOrbit,
        })
        setViewer(created)
        const onTheme = () => created.setTheme()
        addEventListener("dimos-react-theme", onTheme)
        return () => {
            removeEventListener("dimos-react-theme", onTheme)
            created.dispose()
            setViewer(null)
        }
    }, [])

    // a replay: its playhead is the data clock (TF staleness too), and a seek resets the layers
    useEffect(() => {
        if (!viewer) {
            return
        }
        if (source.replay) {
            viewer.dataClock = () => source.now()
            tf.now = () => source.now()
        }
        const off = source.onSeek?.(() => viewer.reset())
        return () => {
            off?.()
            viewer.dataClock = () => performance.now()
        }
    }, [viewer, source, tf])

    useEffect(() => {
        if (viewer) {
            onViewer?.(viewer)
        }
    }, [viewer])

    useEffect(() => viewer?.setGrid(grid), [viewer, grid])

    // the view cube draws on its own canvas over the view, so its clicks never reach the scene's picking
    const cubeCorner = viewCube === true ? "top-right" : viewCube || null
    useEffect(() => {
        if (!viewer || !cubeCorner || !rootRef.current) {
            return
        }
        const cube = new ViewCube(viewer, rootRef.current, { corner: cubeCorner })
        return () => cube.dispose()
    }, [viewer, cubeCorner])

    useEffect(() => {
        if (!viewer) {
            return
        }
        if (cameraTarget) {
            viewer.controls.target.set(...cameraTarget)
        }
        if (cameraPosition) {
            viewer.camera.position.set(...cameraPosition)
        }
        viewer.controls.update()
        viewer.requestRender()
    }, [viewer, cameraPosition?.join(","), cameraTarget?.join(",")])

    // no fixed frame given: the tree's world-ish root, re-checked as frames arrive
    useEffect(() => {
        if (fixedFrame) {
            return
        }
        const check = () => setAutoFixed(tf.defaultFixedFrame())
        check()
        let timer: ReturnType<typeof setTimeout> | undefined = undefined
        const off = tf.onChange(() => {
            timer ??= setTimeout(() => {
                timer = undefined
                check()
            }, 300)
        })
        return () => {
            off()
            clearTimeout(timer)
        }
    }, [tf, fixedFrame])

    useEffect(() => {
        if (viewer) {
            viewer.fixedFrame = fixed
            viewer.requestRender()
        }
    }, [viewer, fixed])

    // where the robot and the followed frame are, every frame; the camera follows the latter while following
    const positions = useRef<{ robot: THREE.Vector3 | null; follow: THREE.Vector3 | null; framed: boolean }>({
        robot: null,
        follow: null,
        framed: false,
    })
    useEffect(() => {
        if (!viewer) {
            return
        }
        positions.current.framed = false
        const robotAt = new THREE.Vector3()
        const followAt = new THREE.Vector3()
        const chase = new ChaseHeading()
        let lastFrameAt = 0
        const off = viewer.onFrame((frame) => {
            const { follow, followFrame, followTurns, robot, viewDistance } = props.current
            const dt = lastFrameAt ? (frame.now - lastFrameAt) / 1000 : 0
            lastFrameAt = frame.now
            const robotMatrix = robot ? (tf.lookup(robot, frame.fixedFrame) ?? robotPose.matrix) : robotPose.matrix
            const robotPosition = robotMatrix ? robotAt.setFromMatrixPosition(robotMatrix) : null
            if (robotPosition && !positions.current.framed) {
                positions.current.framed = true
                viewer.frame(robotPosition.clone(), viewDistance)
            }
            let followed: THREE.Vector3 | null = null
            const followMatrix = !followFrame
                ? null
                : followFrame === robot
                ? robotMatrix
                : tf.lookup(followFrame, frame.fixedFrame)
            if (followMatrix) {
                followed = followAt.setFromMatrixPosition(followMatrix)
            }
            positions.current.robot = robotPosition
            positions.current.follow = followed
            viewer.followTarget = follow ? followed : null
            const following = !!(follow && followFrame) && !viewer.followPaused.get().paused
            if (following && followTurns && followMatrix && followFrame) {
                const turn = chase.step(headingOf(followMatrix, followFrame), dt)
                if (Math.abs(turn) > 1e-6) {
                    turnAbout(viewer.camera, viewer.controls.target, turn)
                    viewer.requestRender()
                }
            } else {
                chase.reset()
            }
            const info = frameInfo.get()
            if (
                info.fixedFrame !== frame.fixedFrame ||
                info.robotFound !== !!robotPosition ||
                info.followFound !== !!followed ||
                info.following !== following
            ) {
                frameInfo.set({
                    fixedFrame: frame.fixedFrame,
                    robotFound: !!robotPosition,
                    followFound: !!followed,
                    following,
                })
            }
        })
        return () => {
            off()
            viewer.followTarget = null
        }
    }, [viewer, tf, robotPose])

    useEffect(() => {
        viewer?.resumeFollow()
    }, [viewer, followFrame])

    const actions = useMemo<SceneActions>(
        () => ({
            /**
             * Not following (paused by a pan, or off): follows again, gliding the followed frame back to the middle with
             * the angle and zoom kept. Already following: frames it afresh. Without it in TF, frames the data that's
             * drawn, or else the origin.
             */
            recenter() {
                if (!viewer) {
                    return
                }
                const { follow, followFrame, viewDistance, onFollowChange } = props.current
                const wasFollowing = follow && !!followFrame && !viewer.followPaused.get().paused
                if (!follow) {
                    onFollowChange?.(true)
                }
                viewer.resumeFollow()
                const followed = positions.current.follow
                if (wasFollowing && followed) {
                    viewer.frame(followed.clone(), viewDistance)
                    return
                }
                if (followed) {
                    return
                }
                const bounds = viewer.dataBounds()
                if (bounds) {
                    const size = bounds.getSize(new THREE.Vector3())
                    viewer.frame(
                        bounds.getCenter(new THREE.Vector3()),
                        THREE.MathUtils.clamp(Math.max(size.x, size.y, size.z) * 1.2, 4, 300),
                    )
                    return
                }
                viewer.frame(new THREE.Vector3(), viewDistance)
            },
            /** Straight down on the area around the robot (or on everything drawn without one). */
            topDown() {
                viewer?.topDownAround(positions.current.robot)
            },
        }),
        [viewer],
    )

    // a click (not the end of a drag) picks the point under it
    const pickRef = useRef(onPick)
    pickRef.current = onPick
    useEffect(() => {
        if (!viewer) {
            return
        }
        const canvas = viewer.canvas
        let down: { x: number; y: number } | null = null
        const onDown = (event: PointerEvent) => {
            down = { x: event.clientX, y: event.clientY }
        }
        const onUp = (event: PointerEvent) => {
            if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5 || !pickRef.current) {
                return
            }
            const picked = viewer.pick(event.clientX, event.clientY)
            if (picked) {
                pickRef.current({ ...picked, event })
            }
        }
        canvas.addEventListener("pointerdown", onDown)
        canvas.addEventListener("pointerup", onUp)
        return () => {
            canvas.removeEventListener("pointerdown", onDown)
            canvas.removeEventListener("pointerup", onUp)
        }
    }, [viewer])

    const topicsRef = useRef(topics)
    topicsRef.current = topics
    const optionsSignature = JSON.stringify(layerOptions ?? {})
    const value = useMemo<SceneContextValue>(
        () => ({
            viewer,
            tf,
            fixedFrame: fixed,
            source,
            video: cameraStreamsFor(source),
            robotPose,
            options: { baseFrame: robot ?? undefined, ...layerOptions },
            topics: () => topicsRef.current?.() ?? [],
            frameInfo,
            actions,
        }),
        [viewer, tf, fixed, source, robotPose, robot, optionsSignature, frameInfo, actions],
    )
    return (
        <div className={cx("dr-scene", className)} style={style} ref={rootRef} {...rest}>
            <div className="dr-scene-host" ref={hostRef} />
            <SceneContext.Provider value={value}>{viewer ? children : null}</SceneContext.Provider>
        </div>
    )
}

/**
 * Feeds the scene's TF tree: every tf2_msgs.TFMessage topic on the bus (or `topics`), and/or `transforms` given as
 * props. A topic named like tf_static is static (exempt from staleness). `transforms`: a decoded TFMessage, an array
 * of TransformStamped, or `[{ parent, child, translation, rotation }]`.
 */
export function TfFeed({ topics, transforms, staticTransforms, tf: given }: TfFeedProps) {
    const context = useScene()
    const tf = given ?? context.tf
    const viewer = context.viewer
    const source = useDataSource()
    const listed = useTopicList({ types: ["tf2_msgs.TFMessage"], intervalMs: topics ? 3_600_000 : 2000 })
    const keys = topics ?? listed.map((topic) => topic.key)
    const keysSignature = keys.join("\n")
    useEffect(() => {
        if (!tf) {
            return
        }
        const stops = keys.map((key) =>
            // reliable: one tf topic often carries different edges from different publishers, so none may be dropped
            source.subscribe(key, { delivery: "reliable" }, (message) => {
                let decoded
                try {
                    decoded = decodeMessage(message, "auto", parseKey(key)?.type ?? "tf2_msgs.TFMessage")
                } catch {
                    return
                }
                tf.setMessage(decoded, /static/i.test(key), message.timestamp)
                viewer?.noteData(message.timestamp)
            })
        )
        return () => stops.forEach((stop) => stop())
    }, [source, tf, viewer, keysSignature])
    useEffect(() => {
        applyTransforms(tf, staticTransforms, true)
        viewer?.requestRender()
    }, [tf, staticTransforms])
    useEffect(() => {
        applyTransforms(tf, transforms, false)
        viewer?.requestRender()
    }, [tf, transforms])
    return null
}

export interface TfFeedProps {
    topics?: string[]
    /** decoded message data (a TFMessage or TransformStamped[]) or plain transforms: any shape of those */
    transforms?: any
    staticTransforms?: any
    tf?: TfTree
}

/** Same as TfFeed (the name the component inventory uses). */
export const TfProvider = TfFeed

// `transforms`: decoded message data, any shape TfFeed takes
function applyTransforms(tf: TfTree | null, transforms: any, isStatic: boolean) {
    if (!tf || !transforms) {
        return
    }
    const list = Array.isArray(transforms) ? transforms : (transforms.transforms ?? [])
    for (const item of list) {
        if (item?.child !== undefined) {
            tf.set(
                item.parent,
                item.child,
                item.translation ?? [0, 0, 0],
                item.rotation ?? [0, 0, 0, 1],
                item.static ?? isStatic,
            )
        } else {
            tf.setMessage([item], isStatic)
        }
    }
}

export interface LayerProps {
    type: string | LayerType
    topic?: string | Topic | null
    settings?: object
    /** props data handed to the instance's setData: its shape is up to the layer type */
    data?: unknown
    onStatus?: (status: LayerStatus) => void
    onPose?: (matrix: THREE.Matrix4) => void
}

/**
 * One layer of a registered type (layers/registry.js) in the scene: from a topic, or from `data` (types that take
 * props data: pointcloud, pose, path, posearray, labeled-points `[{ label, position, frame, color }]`, boxes3d
 * `[{ center, size, yaw, frame, label, color, fill }]`). `settings` override the type's defaults (live: a change restyles,
 * it doesn't re-create); every type also takes `onTop` (LayerCommonSettings: drawn over everything else).
 */
export function Layer({ type, topic, settings, data, onStatus, onPose }: LayerProps) {
    const scene = useScene()
    const layerType = typeof type === "string" ? layerTypeById(type) : type
    if (!layerType) {
        throw new Error(`[dimos-react] no layer type "${type}"`)
    }
    const topicObject = typeof topic === "string"
        ? (parseKey(topic) ?? { key: topic, name: topic, type: "" })
        : (topic ?? null)
    const store = useMemo(
        () => new Store({ ...defaultSettings(layerType, topicObject), ...settings }),
        [layerType, topicObject?.key],
    )
    const settingsSignature = JSON.stringify(settings ?? {})
    useEffect(() => {
        if (settings) {
            store.update(settings)
        }
    }, [store, settingsSignature])
    const callbacks = useRef({ onStatus, onPose })
    callbacks.current = { onStatus, onPose }
    const instance = useLayer(
        (mounted) => {
            const created = layerType.create(
                layerContext(mounted, (status) => callbacks.current.onStatus?.(status), {
                    onPose: (matrix) => callbacks.current.onPose?.(matrix),
                }),
                topicObject,
                store,
            )
            // registry layers place their root by its matrix
            created.root.matrixAutoUpdate = false
            const offTop = followOnTop(mounted.viewer!, created.root, store)
            const dispose = created.dispose.bind(created)
            created.dispose = () => {
                offTop()
                dispose()
            }
            return created
        },
        [layerType, topicObject?.key, store],
    )
    useEffect(() => {
        if (data !== undefined && instance.current?.setData) {
            instance.current.setData(data)
        }
    }, [scene.viewer, data, instance.current])
    return null
}

/**
 * Every topic a LayerManager lists, drawn by its layer type while switched on (unsubscribed while off or paused).
 * The manager (panels.js useLayerManager) is shared with a LayersPanel outside the scene.
 */
export function TopicLayers({ manager }: { manager: LayerManager }) {
    const scene = useScene()
    const { list } = useStore(manager.entries)
    const { paused } = useStore(manager.paused)
    const instances = useRef(
        new Map<
            string,
            {
                instance: LayerInstance
                type: LayerType
                offFrame: (() => void) | null
                offReset: (() => void) | null
                offTop: () => void
            }
        >(),
    )
    const sceneRef = useRef(scene)
    sceneRef.current = scene
    useEffect(() => {
        // the scene this render saw (sceneRef.current is set to it above)
        const mounted = sceneRef.current
        if (!mounted.viewer) {
            return
        }
        const viewer = mounted.viewer
        const wanted = new Map<string, LayerEntry>(
            paused ? [] : list.filter((entry) => entry.enabled).map((entry) => [entry.topic.key, entry]),
        )
        for (const [key, running] of instances.current) {
            if (!wanted.has(key) || wanted.get(key)?.type !== running.type) {
                stop(key)
            }
        }
        for (const [key, entry] of wanted) {
            if (instances.current.has(key)) {
                continue
            }
            const context = layerContext(mounted, (status) => manager.setStatus(key, status), {
                topics: () => manager.topics.get().list,
            })
            try {
                const instance = entry.type.create(context, entry.topic, entry.settings)
                instance.root.matrixAutoUpdate = false
                viewer.scene.add(instance.root)
                const offFrame = instance.update ? viewer.onFrame((frame) => instance.update?.(frame)) : null
                const offReset = instance.reset ? viewer.onReset(() => instance.reset?.()) : null
                const offTop = followOnTop(viewer, instance.root, entry.settings)
                instances.current.set(key, { instance, type: entry.type, offFrame, offReset, offTop })
            } catch (error) {
                manager.setStatus(key, {
                    problem: `failed to start: ${error instanceof Error ? error.message : error}`,
                })
            }
        }
        viewer.requestRender()
        // only called for keys in instances.current
        function stop(key: string) {
            const running = instances.current.get(key)!
            instances.current.delete(key)
            running.offFrame?.()
            running.offReset?.()
            running.offTop()
            running.instance.root.removeFromParent()
            running.instance.dispose()
            manager.clearStatus(key)
        }
    }, [scene.viewer, list, paused, manager])
    // the scene went away: everything stops
    useEffect(
        () => () => {
            for (const [key, running] of instances.current) {
                running.offFrame?.()
                running.offReset?.()
                running.offTop()
                running.instance.root.removeFromParent()
                running.instance.dispose()
                manager.clearStatus(key)
            }
            instances.current.clear()
        },
        [scene.viewer, manager],
    )
    return null
}

/**
 * The TF tree drawn: an axes gizmo per frame (theme --axis-x/y/z), its name, and a line to its parent. A big tree
 * names only `named` frames (and the fixed frame) past `maxNames`.
 */
export function TfFrames({
    axesSize = 0.25,
    names = true,
    links = true,
    maxNames = 16,
    named = [],
    maxFrames = 512,
    onTop = false,
    onStatus,
}: TfFramesProps) {
    const settings = { axesSize, names, links, maxNames, named, maxFrames, onTop }
    return <Layer type={tfType} settings={settings} onStatus={onStatus} />
}
export interface TfFramesProps {
    axesSize?: number
    names?: boolean
    links?: boolean
    maxNames?: number
    named?: string[]
    maxFrames?: number
    /** drawn over the clouds instead of depth-tested among them (default off; live) */
    onTop?: boolean
    onStatus?: (status: LayerStatus) => void
}

// the props components' layer types (not registered): label and types are unused
const tfType: LayerType = {
    id: "tf-frames",
    label: "TF frames",
    types: [],
    defaults: TF_DEFAULTS,
    create: (context, _topic, settings) => new TfFramesLayer(context, settings),
}

const cloudType: LayerType = {
    id: "pointcloud-props",
    label: "Point cloud",
    types: [],
    defaults: {},
    create: (context, topic, settings) => new CloudLayer(context, topic, settings),
}

export interface PointCloudProps {
    topic?: string
    points?: Float32Array | number[]
    intensity?: Uint8Array
    frame?: string
    mode?: "latest" | "accumulate"
    windowSeconds?: number
    maxPoints?: number
    maxHz?: number
    quality?: number
    style?: "default" | "voxel" | "splat" | "disc" | "square"
    size?: number
    colorMode?: "height" | "intensity" | "range" | "solid"
    gradient?: string
    axis?: 0 | 1 | 2
    period?: number
    rangeMin?: number | null
    rangeMax?: number | null
    color?: string
    opacity?: number
    cubeShade?: string
    /** drawn over other clouds instead of depth-tested among them (default off; live) */
    onTop?: boolean
    onStatus?: (status: LayerStatus) => void
}

/**
 * A point cloud: from a topic (sensor_msgs.PointCloud2 through the gateway's dimos_lcm_pointcloud2 encoding at this
 * viewer's bandwidth preset, or any source publishing `{ positions, intensity?, frame? }` or a decoded PointCloud2) or
 * from `points` props. `color`: the solid color (CSS or a token like "var(--primary)"; colorMode "solid"); `maxHz` /
 * `quality` pin the subscription instead of the viewer's preset.
 */
export function PointCloud({
    topic,
    points,
    intensity,
    frame,
    mode = "latest",
    windowSeconds = 10,
    maxPoints = 2_000_000,
    maxHz,
    quality,
    style,
    size,
    colorMode,
    gradient,
    period,
    axis,
    rangeMin,
    rangeMax,
    color,
    opacity,
    cubeShade,
    onTop = false,
    onStatus,
}: PointCloudProps) {
    const look: Record<string, unknown> = { ...CLOUD_DEFAULTS.look, style: "voxel", size: 0.05 }
    for (
        const [name, value] of Object.entries({
            style,
            size,
            colorMode,
            gradient,
            period,
            axis,
            rangeMin,
            rangeMax,
            opacity,
            cubeShade,
        })
    ) {
        if (value !== undefined) {
            look[name] = value
        }
    }
    if (color !== undefined) {
        look.solid = `#${cssColor(color, "white").getHexString()}`
    }
    const settings = { look, mode, windowSeconds, maxPoints, maxHz, quality, frame, onTop }
    const data = useMemo(
        () => (points ? { positions: points, intensity, frame } : undefined),
        [points, intensity, frame],
    )
    return <Layer type={cloudType} topic={topic} settings={settings} data={data} onStatus={onStatus} />
}

const pathType: LayerType = {
    id: "path-props",
    label: "Path",
    types: [],
    defaults: {},
    create: (context, topic, settings) => new PathLayer(context, topic, settings),
}

export interface PathProps {
    topic?: string
    /** decoded geometry_msgs poses (PoseStamped or Pose), any of those shapes */
    poses?: any[]
    frame?: string
    color?: string
    width?: number
    lift?: number
    /** drawn over the clouds instead of depth-tested among them (default off; live) */
    onTop?: boolean
    onStatus?: (status: LayerStatus) => void
}

/** A path as a thick line: a nav_msgs.Path topic, or `poses` (+ `frame`) as props. `color`: CSS or token (default var(--primary)). */
export function Path({
    topic,
    poses,
    frame = "",
    color = "var(--primary)",
    width = 4,
    lift = 0.03,
    onTop = false,
    onStatus,
}: PathProps) {
    const data = useMemo(() => (poses ? { poses, frame } : undefined), [poses, frame])
    return (
        <Layer type={pathType} topic={topic} settings={{ color, width, lift, onTop }} data={data} onStatus={onStatus} />
    )
}

const poseType: LayerType = {
    id: "pose-props",
    label: "Pose",
    types: [],
    defaults: POSE_DEFAULTS,
    create: (context, topic, settings) => new PoseLayer(context, topic, settings),
}

export interface PoseProps {
    topic?: string
    /** a decoded pose (Pose, PoseStamped, Odometry, ...): any of those shapes */
    pose?: any
    frame?: string
    axesSize?: number
    trail?: boolean
    trailLength?: number
    jumpMeters?: number
    color?: string
    width?: number
    /** axes, trail and route drawn over the clouds instead of depth-tested among them (default off; live) */
    onTop?: boolean
    route?: boolean
    onPose?: (matrix: THREE.Matrix4) => void
    onStatus?: (status: LayerStatus) => void
}

/**
 * A pose as axes (theme axis colors), with an optional trail of where it has been (kept in the fixed frame; a jump
 * leaves a gap) and, when the source knows it (a recording), the whole route faint ahead. From a topic
 * (nav_msgs.Odometry, geometry_msgs.PoseStamped / PoseWithCovarianceStamped) or `pose` (+ `frame`) as props.
 * `onPose`: the pose in the fixed frame.
 */
export function Pose({
    topic,
    pose,
    frame = "",
    axesSize = 0.6,
    trail = false,
    trailLength = 20000,
    jumpMeters = 2.5,
    color = "var(--primary)",
    width = 4,
    onTop = false,
    route = true,
    onPose,
    onStatus,
}: PoseProps) {
    const data = useMemo(() => (pose ? { pose, frame } : undefined), [pose, frame])
    return (
        <Layer
            type={poseType}
            topic={topic}
            settings={{ axesSize, trail, trailLength, jumpMeters, color, width, onTop, route }}
            data={data}
            onPose={onPose}
            onStatus={onStatus}
        />
    )
}

const poseArrayType: LayerType = {
    id: "posearray-props",
    label: "Pose array",
    types: [],
    defaults: {},
    create: (context, topic, settings) => new PoseArrayLayer(context, topic, settings),
}

export interface PoseArrayProps {
    topic?: string
    /** decoded geometry_msgs poses, any of those shapes */
    poses?: any[]
    frame?: string
    color?: string
    length?: number
    width?: number
    /** drawn over the clouds instead of depth-tested among them (default off; live) */
    onTop?: boolean
    onStatus?: (status: LayerStatus) => void
}

/** Many poses as arrows: a geometry_msgs.PoseArray topic, or `poses` (+ `frame`) as props. */
export function PoseArray({
    topic,
    poses,
    frame = "",
    color = "var(--accent-alt)",
    length = 0.4,
    width = 2,
    onTop = false,
    onStatus,
}: PoseArrayProps) {
    const data = useMemo(() => (poses ? { poses, frame } : undefined), [poses, frame])
    return (
        <Layer
            type={poseArrayType}
            topic={topic}
            settings={{ color, length, width, onTop }}
            data={data}
            onStatus={onStatus}
        />
    )
}

export interface RobotModelProps {
    kind?: string
    frame?: string
    /** a decoded pose, any of the shapes poseMatrix takes */
    pose?: any
    poseFrame?: string
    scale?: number
    visible?: boolean
    colors?: { body?: string; dark?: string; nose?: string }
}

/**
 * A stand-in robot model (ROBOT_KINDS: dog, humanoid, wheeled, drone, arrow) at a TF frame (`frame`, default the
 * scene's robotFrame, else base_link) or at `pose` (in `poseFrame`). Without its frame in TF it stands at the newest
 * pose a Pose layer reported. Colors follow the theme unless `colors` says otherwise.
 */
export function RobotModel({
    kind = "wheeled",
    frame,
    pose,
    poseFrame = "",
    scale = 1,
    visible = true,
    colors,
}: RobotModelProps) {
    const scene = useScene()
    const current = { frame: frame ?? scene.options?.baseFrame ?? "base_link", pose, poseFrame, scale, visible }
    const settings = useRef(current)
    settings.current = current
    const colorsSignature = JSON.stringify(colors ?? {})
    useLayer(
        ({ viewer, tf, robotPose }) => {
            const first = robotModel(kind, colors)
            if (!first) {
                return null
            }
            let model = first
            const root = new THREE.Group()
            root.add(model)
            const rebuild = () => {
                disposeTree(model)
                // the same kind the first model was built from
                model = robotModel(kind, colors)!
                root.add(model)
                viewer.requestRender()
            }
            addEventListener("dimos-react-theme", rebuild)
            const local = new THREE.Matrix4()
            const scaleVector = new THREE.Vector3()
            return {
                root,
                update(frameInfo) {
                    const { frame, pose, poseFrame, scale, visible } = settings.current
                    const base = pose
                        ? tf.lookup(poseFrame, frameInfo.fixedFrame)
                        : (tf.lookup(frame, frameInfo.fixedFrame) ?? robotPose?.matrix ?? null)
                    if (!base || !visible) {
                        if (model.visible) {
                            model.visible = false
                            viewer.requestRender()
                        }
                        return
                    }
                    const matrix = pose ? base.clone().multiply(poseMatrixOf(pose, local)) : base.clone()
                    matrix.scale(scaleVector.setScalar(scale))
                    if (!model.visible || !model.matrix.equals(matrix)) {
                        model.matrix.copy(matrix)
                        model.matrixWorldNeedsUpdate = true
                        model.visible = true
                        viewer.requestRender()
                    }
                },
                dispose() {
                    removeEventListener("dimos-react-theme", rebuild)
                    disposeTree(model)
                },
            }
        },
        [kind, colorsSignature],
    )
    return null
}

export interface FrameHighlightProps {
    frame: string | null
    onPlaced?: (placed: boolean) => void
}

/**
 * One TF frame picked out (e.g. a TF panel's hovered row): big axes drawn over everything with a halo and its name,
 * following the frame as it moves. `onPlaced(placed)` says whether it could be placed in the fixed frame.
 */
export function FrameHighlight({ frame, onPlaced }: FrameHighlightProps) {
    const placedRef = useRef(onPlaced)
    placedRef.current = onPlaced
    const layer = useLayer(
        ({ viewer, tf }) => new FrameHighlighter(viewer, tf, (placed) => placedRef.current?.(placed)),
        [],
    )
    useEffect(() => {
        layer.current?.set(frame ?? null)
    }, [frame, layer.current])
    return null
}

type TfLayerFrames = NonNullable<CheckTfInput["layers"]>

export interface UseTfIssuesOptions {
    layers?: TfLayerFrames | (() => TfLayerFrames)
    tf?: TfTree | null
    fixedFrame?: string
    intervalMs?: number
}

/**
 * What's wrong with the scene's TF tree (tf_check.js), checked every `intervalMs`; a problem shows once two checks in a
 * row see it. `layers`: the drawn layers' frames (a LayerManager's layerFrames()).
 */
export function useTfIssues({
    layers,
    tf: given,
    fixedFrame: givenFixed,
    intervalMs = 2000,
}: UseTfIssuesOptions = {}): TfIssue[] {
    const scene = useScene()
    const tf = given ?? scene.tf
    const fixedRef = useRef(givenFixed ?? scene.fixedFrame)
    fixedRef.current = givenFixed ?? scene.viewer?.fixedFrame ?? scene.fixedFrame
    const layersRef = useRef(layers)
    layersRef.current = layers
    const [issues, setIssues] = useState<TfIssue[]>([])
    useEffect(() => {
        if (!tf) {
            return
        }
        let seen: TfIssue[] = []
        let shown = "[]"
        const check = () => {
            const fixedFrame = fixedRef.current
            const next = checkTf({
                snapshot: tf.snapshot(),
                fixedFrame,
                layers: typeof layersRef.current === "function" ? layersRef.current() : (layersRef.current ?? []),
                placed: (frame) => tf.lookup(frame, fixedFrame) !== null,
            })
            const confirmed = confirmedIssues(seen, next)
            seen = next
            const signature = JSON.stringify(confirmed)
            if (signature !== shown) {
                shown = signature
                setIssues(confirmed)
            }
        }
        const timer = setInterval(check, intervalMs)
        return () => clearInterval(timer)
    }, [tf, intervalMs])
    return issues
}

export interface FramePickerProps extends Omit<Partial<SelectProps>, "value" | "onChange" | "options"> {
    value?: string | null
    onChange: (frame: string | null) => void
    tf?: TfTree
    /** an extra "none" option (null) */
    noneLabel?: string | null
    placeholder?: string
}

/** A Select of the scene's TF frames (inside a Scene3D, or pass `tf`). `noneLabel`: an extra "none" option (null). */
export function FramePicker({
    value,
    onChange,
    tf,
    noneLabel = null,
    placeholder = "frame…",
    ...rest
}: FramePickerProps) {
    const frames = useTfFrames({ tf })
    const none: [null, string][] = noneLabel !== null ? [[null, noneLabel]] : []
    const options: [string | null, string][] = [...none, ...frames.map((name): [string, string] => [name, name])]
    if (value && !frames.includes(value)) {
        options.push([value, `${value} (not seen)`])
    }
    return <Select value={value ?? null} onChange={onChange} options={options} placeholder={placeholder} {...rest} />
}

const emptyStats = new Store<RenderStats>({
    fps: 0,
    frameMs: 0,
    latencyP50: null,
    latencyP95: null,
    arrivalToFrameMs: null,
    drawCalls: 0,
    points: 0,
})

export interface SceneStatsProps {
    className?: string
    detailed?: boolean
    rttMs?: number | null
}

/**
 * The scene's render numbers as a small overlay: fps · points · frame ms · latency, or with `detailed` the full set
 * (CPU per frame, latency p50/p95, arrival→frame, `rttMs` if given, points, draw calls).
 */
export function SceneStats({ className, detailed = false, rttMs }: SceneStatsProps) {
    const viewer = useViewer()
    const stats = useStore(viewer?.stats ?? emptyStats)
    if (detailed) {
        const ms = (value: number | null | undefined) =>
            value === null || value === undefined ? "–" : `${value.toFixed(1)} ms`
        return (
            <div className={cx("dr-scene-stats dr-scene-stats--detailed", className)} data-testid="stats">
                <div>{`${stats.fps} fps · ${stats.frameMs.toFixed(2)} ms/frame CPU`}</div>
                <div>{`latency p50 ${ms(stats.latencyP50)} · p95 ${ms(stats.latencyP95)}`}</div>
                <div>
                    {`arrival→frame ${ms(stats.arrivalToFrameMs)}${rttMs !== undefined ? ` · rtt ${ms(rttMs)}` : ""}`}
                </div>
                <div>{`${stats.points.toLocaleString()} points · ${stats.drawCalls} draws`}</div>
            </div>
        )
    }
    const points = stats.points > 1e6
        ? `${(stats.points / 1e6).toFixed(1)}M`
        : stats.points > 1e3
        ? `${(stats.points / 1e3).toFixed(0)}k`
        : String(stats.points)
    return (
        <div className={cx("dr-scene-stats", className)}>
            {`${stats.fps} fps · ${points} pts · ${stats.frameMs.toFixed(1)} ms`}
            {stats.latencyP50 !== null ? ` · ${Math.round(stats.latencyP50)} ms latency` : ""}
        </div>
    )
}

export interface SceneControlsProps {
    className?: string
    children?: ReactNode
    frameAll?: boolean
    onFrameAll?: () => void
    onTopDown?: () => void
    position?: "bottom-right" | "top-right" | "top-left" | "bottom-left"
}

/**
 * Camera buttons over the scene: follow (reframes the followed frame, or follows again after a pan), top-down (on the
 * area around the robot), frame everything. `children`: extra buttons.
 * `onFrameAll` / `onTopDown` replace what those buttons do (an app's own idea of "everything"); `position`:
 * "bottom-right" (default) | "top-right" | "top-left" | "bottom-left".
 */
export function SceneControls({
    className,
    children,
    frameAll = true,
    onFrameAll,
    onTopDown,
    position = "bottom-right",
}: SceneControlsProps) {
    const { viewer, frameInfo, actions } = useScene()
    const info = useStore(frameInfo ?? emptyFrameInfo)
    const button = (icon: string, label: string, onClick: () => void, pressed?: boolean) => (
        <IconButton
            icon={icon}
            label={label}
            title={label}
            className="dr-scene-btn"
            aria-pressed={pressed}
            onClick={onClick}
        />
    )
    const followTitle = info.following
        ? `Following${
            info.followFound ? "" : " (waiting for the frame in TF)"
        }: orbit and zoom keep following, a pan looks around. Click to reframe`
        : "Follow again"
    return (
        <div
            className={cx(
                "dr-scene-controls",
                position !== "bottom-right" && `dr-scene-controls--${position}`,
                className,
            )}
            data-testid="view-controls"
        >
            {button("target", followTitle, () => actions?.recenter(), info.following)}
            {button("top", "Top-down", () => (onTopDown ? onTopDown() : actions?.topDown()))}
            {frameAll
                ? button("fit", "Frame everything", () => (onFrameAll ? onFrameAll() : viewer?.frameAll()))
                : null}
            {children}
        </div>
    )
}
const emptyFrameInfo = new Store({ fixedFrame: "", robotFound: false, followFound: false, following: false })

const FLY_KEYS = new Set([..."wasdqeijkl"])

export interface KeyboardFlyProps {
    speed?: number
    lookSpeed?: number
    enabled?: boolean
}

/**
 * Keyboard flying for the enclosing scene, beside the mouse orbit: W/S forward/back and A/D left/right over the ground,
 * Q/E down/up, I/K look up/down and J/L look left/right (the camera stays put, the orbit target swings around it).
 * `speed` (m/s), `lookSpeed` (rad/s). Keys typed into inputs, and chords with ⌘/Ctrl/Alt, are ignored.
 */
export function KeyboardFly({ speed = 2, lookSpeed = 1.5, enabled = true }: KeyboardFlyProps) {
    const viewer = useViewer()
    const settings = useRef({ speed, lookSpeed })
    settings.current = { speed, lookSpeed }
    useEffect(() => {
        if (!viewer || !enabled) {
            return
        }
        const held = new Set<string>()
        const typing = (event: KeyboardEvent) =>
            event.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable]")
        const keydown = (event: KeyboardEvent) => {
            if (typing(event)) {
                return
            }
            // macOS sends no keyup for a letter released while ⌘ is held: a chord would leave the key stuck
            if (event.metaKey || event.ctrlKey || event.altKey) {
                held.clear()
                return
            }
            const key = event.key.toLowerCase()
            if (FLY_KEYS.has(key)) {
                held.add(key)
            }
        }
        const keyup = (event: KeyboardEvent) => held.delete(event.key.toLowerCase())
        const blur = () => held.clear()
        addEventListener("keydown", keydown)
        addEventListener("keyup", keyup)
        addEventListener("blur", blur)
        const { camera, controls } = viewer
        const forward = new THREE.Vector3()
        const right = new THREE.Vector3()
        const offset = new THREE.Vector3()
        const move = new THREE.Vector3()
        let last = 0
        const off = viewer.onFrame(({ now }) => {
            const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
            last = now
            if (held.size === 0 || dt === 0) {
                return
            }
            const step = settings.current.speed * dt
            const turn = settings.current.lookSpeed * dt
            forward.subVectors(controls.target, camera.position).setZ(0)
            if (forward.lengthSq() < 1e-12) {
                forward.set(0, 1, 0)
            }
            forward.normalize()
            right.crossVectors(forward, camera.up).normalize()
            move.set(0, 0, 0)
            if (held.has("w")) {
                move.add(forward)
            }
            if (held.has("s")) {
                move.sub(forward)
            }
            if (held.has("d")) {
                move.add(right)
            }
            if (held.has("a")) {
                move.sub(right)
            }
            if (move.lengthSq() > 0) {
                move.normalize().multiplyScalar(step)
            }
            move.addScaledVector(camera.up, ((held.has("e") ? 1 : 0) - (held.has("q") ? 1 : 0)) * step)
            camera.position.add(move)
            controls.target.add(move)
            offset.subVectors(controls.target, camera.position)
            if (held.has("j")) {
                offset.applyAxisAngle(camera.up, turn)
            }
            if (held.has("l")) {
                offset.applyAxisAngle(camera.up, -turn)
            }
            if (held.has("i") || held.has("k")) {
                const pitched = offset
                    .clone()
                    .applyAxisAngle(right, (held.has("i") ? 1 : 0) * turn - (held.has("k") ? 1 : 0) * turn)
                // never pitch fully vertical (the view would flip)
                if (Math.abs(pitched.clone().normalize().dot(camera.up)) < 0.985) {
                    offset.copy(pitched)
                }
            }
            controls.target.copy(camera.position).add(offset)
            viewer.requestRender()
        })
        return () => {
            off()
            removeEventListener("keydown", keydown)
            removeEventListener("keyup", keyup)
            removeEventListener("blur", blur)
        }
    }, [viewer, enabled])
    return null
}
