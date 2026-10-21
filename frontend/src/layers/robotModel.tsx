// The robot's own model from its URDF (dimos's UrdfManager: /robot_description, meshes on /mesh_request → /mesh_info), any
// robot. Each link sits at its TF frame (UrdfManager puts every joint on tf, frames named by link), its visuals at
// their URDF origins; a link with no TF frame follows its parent through the joint's origin. Meshes fill in as they arrive.
// A visual naming a splat file (a scene: a Gaussian-splat home next to its collision meshes) is drawn with Spark. A
// link's <group> (core/urdf.ts) puts it in a row of its own, apart from the robot's.
import * as THREE from "three"
import { registerLayer, type LayerContext } from "../core/layers/registry.ts"
import type { LayerEntry, LayerManager } from "../core/layers/manager.ts"
import { LayerStatusLine, Row } from "../ui/LayersPanel.tsx"
import { useStore, type Store } from "../core/store.ts"
import { Field, Select, Slider } from "dimos-react"
import { type DisplayMode, groupNames, Kinematics, modelPartsOf, RobotModel } from "../core/robotDescription.ts"
import { type UrdfSource, urdfSource } from "../core/urdfSource.ts"
import { ensureSparkRenderer, splatFiles } from "../core/splats.ts"

export interface RobotModelSettings {
    opacity: number
    display: DisplayMode
    /** the links in no group (the robot's own) shown (unset: on) */
    robot?: boolean
    /** each group's links shown, by the group's name (unset: on); unset before groups (`people` is read then) */
    groups?: Record<string, boolean>
    /** splat files shown (unset: on) */
    splats?: boolean
    /** mesh files (not splats) shown (unset: on) */
    meshes?: boolean
    /** before groups, dim-go2-sim's people shown; read only to migrate */
    people?: boolean
    /** before the splats / meshes toggles: "splats", "meshes" or "both"; read only to migrate */
    splatView?: string
    /** visual meshes in their materials, or plain flat grey */
    textures?: boolean
    /** splats above this height (m) are hidden, so ceilings don't hide the view from above */
    splatCutAbove: number
}

class RobotModelLayer {
    readonly root = new THREE.Group()
    #source: UrdfSource
    #release: () => void
    #stopState: () => void
    #model: RobotModel | null = null
    #kinematics: Kinematics | null = null
    #drawing = false
    #fixedFrame = ""
    #tfVersion = -1

    constructor(readonly context: LayerContext, readonly settings: Store<RobotModelSettings>) {
        this.root.matrixAutoUpdate = false
        this.#source = urdfSource(context.connection)
        this.#release = this.#source.acquire()
        this.#stopState = this.#source.state.subscribe(() => this.#sync())
        settings.subscribe(() => this.#rebuild())
        this.#sync()
    }

    #sync() {
        const { description, meshVersion } = this.#source.state.get()
        if (description && this.#kinematics?.description !== description) {
            this.#kinematics = new Kinematics(description)
            this.#rebuild()
        } else if (this.#model && meshVersion && this.#model.fill(this.#source.geometries)) {
            this.#tfVersion = -1
            this.context.viewer.requestRender()
        }
        if (this.#source.splats.size) {
            ensureSparkRenderer(this.context.viewer)
        }
        this.#status()
    }

    #rebuild() {
        if (this.#model) {
            this.root.remove(this.#model.root)
            this.#model.dispose()
            this.#model = null
        }
        if (!this.#kinematics) {
            return
        }
        const { opacity, display, textures, splatCutAbove } = this.settings.get()
        this.#model = new RobotModel(this.#kinematics, this.#source.geometries, { opacity }, this.#source.splats)
        this.#model.setDisplay(display)
        this.#model.setParts(modelPartsOf(this.settings.get()))
        this.#model.setTextures(textures ?? true)
        this.#model.setSplatCutAbove(splatCutAbove ?? 2.5)
        this.root.add(this.#model.root)
        this.#tfVersion = -1
        this.context.viewer.requestRender()
    }

    #problem: string | null = null
    #status() {
        const { description, meshesLoaded, meshesWanted, problem, armDraws } = this.#source.state.get()
        if (!description) {
            this.context.setStatus({ info: "waiting for /robot_description", problem })
            return
        }
        const meshes = meshesWanted ? ` · meshes ${meshesLoaded}/${meshesWanted}` : ""
        const splatCount = [...this.#source.splats.values()].reduce((sum, splats) => sum + splats.count, 0)
        const splats = splatCount ? ` · ${(splatCount / 1e6).toFixed(2)}M splats` : ""
        this.context.setStatus({
            info: `${description.name}: ${description.links.length} links${meshes}${splats}${armDraws ? " · drawn by the arm view" : ""}`,
            problem: this.#problem ?? problem,
            frame: description.base_link,
        })
    }

    #setDrawing(drawing: boolean) {
        if (drawing !== this.#drawing) {
            this.#drawing = drawing
            this.#source.drawing(drawing ? 1 : -1)
        }
    }

    update(frame: { fixedFrame: string }) {
        const model = this.#model
        const kinematics = this.#kinematics
        const root = kinematics?.root
        const placed = root ? this.context.tf.lookup(root, frame.fixedFrame) : null
        const show = !!model && !!placed && !this.#source.state.get().armDraws
        if (this.root.visible !== show) {
            this.root.visible = show
            this.context.viewer.requestRender()
        }
        this.#setDrawing(show)
        const problem = root && !placed ? `no TF from ${root} to ${frame.fixedFrame}` : null
        if (problem !== this.#problem) {
            this.#problem = problem
            this.#status()
        }
        // only when the tree moved
        if (!show || !model || !kinematics || (this.context.tf.version === this.#tfVersion && frame.fixedFrame === this.#fixedFrame)) {
            return
        }
        this.#tfVersion = this.context.tf.version
        this.#fixedFrame = frame.fixedFrame
        // every link at its TF frame; one without a frame at its parent's through the joint's origin (parents come first)
        const poses = new Map<string, THREE.Matrix4>()
        const inFixed = (link: string) => this.context.tf.lookup(link, frame.fixedFrame)
        const relative = (child: string, parent: string) => {
            const childPose = inFixed(child), parentPose = inFixed(parent)
            return childPose && parentPose ? parentPose.clone().invert().multiply(childPose) : null
        }
        const fromJoints = kinematics.linkPoses(kinematics.positionsFrom(relative))
        const rootPose = placed!
        for (const [link, pose] of fromJoints) {
            const fromTf = inFixed(link)
            poses.set(link, fromTf ?? rootPose.clone().multiply(pose))
        }
        for (const [link, group] of model.links) {
            const pose = poses.get(link)
            group.visible = !!pose
            if (pose && !group.matrix.equals(pose)) {
                group.matrix.copy(pose)
                group.matrixWorldNeedsUpdate = true
            }
        }
        this.context.viewer.requestRender()
    }

    dispose() {
        this.#setDrawing(false)
        this.#stopState()
        this.#release()
        this.#model?.dispose()
    }
}

const SPLAT_EXTENSIONS = new Set(["spz", "splat", "ksplat", "sog"])

/** The layer's rows, top level in the list: URDF (the links in no group: the robot), Meshes, Textures, Splats, then a
 * row per group the URDF's links name. URDF and the groups say which links show: one shows while the layer is on, and
 * the layer runs (subscribed) while any is. Meshes, Textures and Splats apply across them, to their files. A row only
 * shows if the model has its part. */
function RobotModelRows({ entry, layers }: { entry: LayerEntry; layers: LayerManager }) {
    const settings = entry.settings as Store<RobotModelSettings>
    const value = useStore(settings)
    const { count: splatFileCount } = useStore(splatFiles)
    const { description } = useStore(urdfSource(layers.connection).state)
    const groups = description ? groupNames(description) : []
    const hasMeshFiles = !!description?.links.some((link) => [...link.visuals, ...link.collisions].some((item) => item.mesh && !SPLAT_EXTENSIONS.has(item.mesh.split("?")[0].split(".").pop()?.toLowerCase() ?? "")))
    const parts = modelPartsOf(value)
    const groupShown = (group: string) => entry.enabled && (parts.groups[group] ?? true)
    /** turning one of URDF or the groups on while the layer is off shows that one alone */
    const show = (which: { robot: boolean } | { group: string; on: boolean }) => {
        const before = entry.enabled ? parts : { ...parts, robot: false, groups: Object.fromEntries(groups.map((group) => [group, false])) }
        const next = "group" in which ? { ...before, groups: { ...before.groups, [which.group]: which.on } } : { ...before, robot: which.robot }
        settings.update({ robot: next.robot, groups: next.groups, meshes: next.meshes, splats: next.splats })
        layers.setEnabled(entry.topic.key, next.robot || groups.some((group) => next.groups[group] ?? true))
    }
    return (
        <>
            <Row value={entry.enabled && parts.robot} onChange={(robot) => show({ robot })} name="URDF" type={entry.topic.name} title="the robot's own links (in no group)" className={entry.status.problem ? "problem" : ""} testKey={entry.topic.key} below={<LayerStatusLine entry={entry} />}>
                <Field inline label="Opacity">
                    <Slider min={0.1} max={1} step={0.05} value={value.opacity} format={(opacity: number) => `${Math.round(opacity * 100)}%`} onChange={(opacity: number) => settings.update({ opacity })} />
                </Field>
                <Field inline label="Show">
                    <Select<string>
                        aria-label="Robot model geometry"
                        value={value.display}
                        options={[["visual", "Visual"], ["collision", "Collision"], ["both", "Both"]]}
                        onChange={(display: string) => settings.update({ display: display as DisplayMode })}
                    />
                </Field>
            </Row>
            {hasMeshFiles && <Row value={parts.meshes} onChange={(meshes) => settings.update({ ...parts, meshes })} name="Meshes" title="mesh files (not splats), in every row's links" />}
            <Row value={value.textures ?? true} onChange={(textures) => settings.update({ textures })} name="Textures" title="off: meshes in plain flat grey, to see their geometry" />
            {splatFileCount > 0 && (
                <Row value={parts.splats} onChange={(splats) => settings.update({ ...parts, splats })} name="Splats" title="Gaussian splat files, in every row's links">
                    <Field inline label="Cut above" title="splats higher than this are hidden, so ceilings and upper floors don't hide the robot">
                        <Slider min={0.5} max={30} step={0.1} value={value.splatCutAbove ?? 2.5} format={(height: number) => `${height.toFixed(1)} m`} onChange={(splatCutAbove: number) => settings.update({ splatCutAbove })} />
                    </Field>
                </Row>
            )}
            {groups.map((group) => <Row key={group} value={groupShown(group)} onChange={(on) => show({ group, on })} name={group} title={`the URDF's links in <group>${group}</group>`} />)}
        </>
    )
}

registerLayer<RobotModelSettings>({
    id: "robot-model",
    label: "Robot model (URDF)",
    types: ["std_msgs.String"],
    names: ["/robot_description"],
    defaults: { opacity: 1, display: "visual", textures: true, splatCutAbove: 2.5 },
    create: (context, _topic, settings) => new RobotModelLayer(context, settings),
    Rows: RobotModelRows,
})
