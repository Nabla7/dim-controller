// Gaussian splats in a URDF: a visual whose mesh is a splat file (.spz, .splat, .ksplat, .sog, or a .ply with Gaussian
// properties) is drawn with Spark (sparkjs.dev), which renders splats on three's WebGLRenderer (three's own GaussianSplat
// is WebGPU-only). Spark (~2.7 MB) is loaded the first time a splat arrives; each viewer gets one SparkRenderer.
import type * as THREE from "three"
import type { Viewer } from "dimos-react/three"
import { Store } from "./store.ts"

type Spark = typeof import("@sparkjsdev/spark")
let spark: Promise<Spark> | null = null
const loadSpark = () => (spark ??= import("@sparkjsdev/spark"))

/** one model's object drawing a splat file */
export type SplatObject = THREE.Object3D & {
    opacity: number
    /** hides the splats above this height (m, in the splat file's own frame: a scene's is the world), so ceilings
     * don't hide the view from above; null shows them all */
    setCutAbove(height: number | null): void
}

/** decoded splats, shared by every model drawing them */
export interface SplatAsset {
    count: number
    /** a new object drawing them (each model has its own; the splats are shared) */
    mesh(): SplatObject
    dispose(): void
}

const SPLAT_TYPES: Record<string, string> = { spz: "spz", splat: "splat", ksplat: "ksplat", sog: "pcsogszip" }

/** Spark's file type for a splat file, else null (a mesh): told by the extension, a .ply by its header's properties. */
export function splatFileType(uri: string, data: Uint8Array): string | null {
    const extension = uri.split("?")[0].split(".").pop()?.toLowerCase() ?? ""
    if (extension === "ply") {
        const header = new TextDecoder().decode(data.subarray(0, 4096)).split("end_header")[0]
        return /property \w+ (f_dc_0|scale_0)\b/.test(header) ? "ply" : null
    }
    return SPLAT_TYPES[extension] ?? null
}

/** splat files decoded on this page (settings show the splat view only when there are some) */
export const splatFiles = new Store({ count: 0 })

/** Decodes a splat file (in Spark's worker). */
export async function loadSplats(data: Uint8Array, fileType: string): Promise<SplatAsset> {
    const { PackedSplats, SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode } = await loadSpark()
    const packed = new PackedSplats({ fileBytes: data.slice(), fileType: fileType as never })
    await packed.initialized
    splatFiles.update({ count: splatFiles.get().count + 1 })
    return {
        count: packed.numSplats,
        mesh: () => {
            const mesh = new SplatMesh({ packedSplats: packed }) as InstanceType<typeof SplatMesh> & SplatObject
            // an edit under the mesh applies to it alone: opacity 0 above a plane (a plane's inside is below it; inverted)
            const above = new SplatEditSdf({ type: SplatEditSdfType.PLANE, invert: true, opacity: 0 })
            const cut = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, sdfs: [above] })
            cut.add(above)
            mesh.setCutAbove = (height: number | null) => {
                above.position.z = height ?? 0
                if (height === null) {
                    mesh.remove(cut)
                } else if (cut.parent !== mesh) {
                    mesh.add(cut)
                }
            }
            return mesh
        },
        dispose: () => packed.dispose(),
    }
}

const renderers = new WeakMap<Viewer, THREE.Object3D>()

/** The viewer's SparkRenderer (made once, in its scene): it sorts and draws every splat mesh, and asks for a frame when a sort lands. */
export async function ensureSparkRenderer(viewer: Viewer) {
    const { SparkRenderer } = await loadSpark()
    if (!viewer.renderer || renderers.has(viewer)) {
        return
    }
    const renderer = new SparkRenderer({ renderer: viewer.renderer, onDirty: () => viewer.requestRender() })
    renderers.set(viewer, renderer)
    viewer.scene.add(renderer)
    viewer.requestRender()
}
