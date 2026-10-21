// <Map2D>: the top-down 2D map as a React component, filling its positioned parent. It reads topics through the data
// source and places everything through a TfTree (pass `tf`, e.g. the one a Scene3D and its TfFeed share).
//
//     h(Map2D, { tf, topic: globalMap, overlay: costmap, path: "dimos/path/nav_msgs.Path", followFrame: "base_link",
//         onPick: ({ x, y, frame }) => sendGoal(x, y, frame), onMap: (map) => (mapRef.current = map) })
//
// `onMap(renderer)` hands over the renderer for buttons outside it: `renderer.recenter()` (follow again), `renderer.fit()`
// (show everything). The renderer lives while the component is mounted; nothing is subscribed once it unmounts.
import { useEffect, useMemo, useRef } from "react"
import type { CSSProperties, ReactNode } from "react"
import { cx } from "../cx.ts"
import { useDataSource } from "../data.ts"
import type { DataSource, Topic } from "../data.ts"
import type { TfTree } from "../three/tf.ts"
import { Map2DRenderer } from "./renderer.ts"
import type { Map2DContext, Map2DFollowState, Map2DPick, Map2DStatus, RetainedMapData } from "./renderer.ts"
import { DEFAULT_FOLLOW_FRAME } from "./math.ts"
import type { MapView } from "./math.ts"

/** each data source's last map data per topic, so a remounted map shows it at once */
const retainedBySource = new WeakMap<DataSource, Map<string, RetainedMapData>>()

export interface Map2DProps {
    tf: TfTree
    /** the base map (OccupancyGrid, or a PointCloud2 drawn as a height heatmap) */
    topic?: Topic | null
    /** a costmap over it */
    overlay?: Topic | null
    /** a nav_msgs.Path topic key */
    path?: string | null
    /** the TF frame it follows (a pan stops following) */
    followFrame?: string
    /** where the robot arrow and trail go (default `followFrame`) */
    robotFrame?: string
    /** default: the TF tree's world-ish root */
    fixedFrame?: string
    /** where to start (a remembered `onView`) */
    view?: MapView | null
    onView?: (view: MapView) => void
    onFollow?: (follow: Map2DFollowState) => void
    onStatus?: (status: Map2DStatus) => void
    onPick?: (pick: Map2DPick) => void
    onMap?: (renderer: Map2DRenderer | null) => void
    className?: string
    style?: CSSProperties
    children?: ReactNode
}

export function Map2D({
    tf,
    topic = null,
    overlay = null,
    path = null,
    followFrame = DEFAULT_FOLLOW_FRAME,
    robotFrame,
    fixedFrame,
    view = null,
    onView,
    onFollow,
    onStatus,
    onPick,
    onMap,
    className,
    style,
    children,
}: Map2DProps) {
    const source = useDataSource()
    const canvas = useRef<HTMLCanvasElement>(null)
    const renderer = useRef<Map2DRenderer | null>(null)
    // the latest callbacks and frames, read by the long-lived renderer
    const latest = { onView, onFollow, onStatus, onPick, onMap, fixedFrame, robotFrame, followFrame }
    const props = useRef(latest)
    props.current = latest
    const map = useMemo((): Map2DContext => {
        let retained = retainedBySource.get(source)
        if (!retained) {
            retainedBySource.set(source, retained = new Map())
        }
        return {
            source,
            tf,
            retained,
            fixedFrame: () => props.current.fixedFrame || tf.defaultFixedFrame(),
            robotFrame: () => props.current.robotFrame || props.current.followFrame,
        }
    }, [source, tf])
    useEffect(() => {
        // effects run after the commit: the canvas is mounted
        const created = new Map2DRenderer(map, canvas.current!, view, followFrame, {
            onView: (next) => props.current.onView?.(next),
            onFollow: (next) => props.current.onFollow?.(next),
            onStatus: (next) => props.current.onStatus?.(next),
            onPick: (pick) => props.current.onPick?.(pick),
        })
        renderer.current = created
        props.current.onMap?.(created)
        return () => {
            props.current.onMap?.(null)
            created.dispose()
            renderer.current = null
        }
    }, [map])
    useEffect(() => renderer.current?.setFollowFrame(followFrame), [map, followFrame])
    useEffect(() => renderer.current?.setTopics(topic, overlay), [map, topic?.key, overlay?.key])
    useEffect(() => renderer.current?.setPath(path), [map, path])
    return (
        <div className={cx("dr-map2d", className)} style={style}>
            <canvas ref={canvas} className="dr-map2d-canvas" aria-label="Top-down map" />
            {children}
        </div>
    )
}
