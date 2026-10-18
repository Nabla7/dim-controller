// The robot's URDF and its meshes from dimos's UrdfManager, one per page, shared by the robot model layer and the arm
// view: /urdf_info's XML (re-sent every 5 s, nothing is latched) and each mesh asked for on /mesh_request, its reply on
// /mesh_info matched by URL (replies come in any order, possibly from more than one publisher). Subscribed only while
// something uses it (acquire). A mesh named with ?hash=<sha256> is kept in IndexedDB (core/meshCache.ts) and asked for
// with `&have=<the cached hash>` only when that isn't the URDF's; one without a hash is asked for each load, uncached.
// Splat files (core/splats.ts) come the same way and are kept apart from the meshes.
import type * as THREE from "three"
import { decode, encode } from "./lcm/lcm.ts"
import { Store } from "./store.ts"
import { type Connection, dimosKey, Priority, type Publisher } from "./transport.ts"
import { decodeMeshFile, meshGeometry, meshUris, parseUrdf } from "./urdf.ts"
import { cachedFile, splitHash, storeFile } from "./meshCache.ts"
import { loadSplats, type SplatAsset, splatFileType } from "./splats.ts"
import type { RobotDescription } from "./robotDescription.ts"

export const URDF_INFO = dimosKey("/urdf_info", "std_msgs.String")
export const MESH_REQUEST = dimosKey("/mesh_request", "std_msgs.String")
export const MESH_INFO = dimosKey("/mesh_info", "shape_msgs.MeshFile")
/** meshes asked for at once: one reply can be several MB, so two at a time keep the link for driving and video */
const MESHES_IN_FLIGHT = 2
/** a mesh asked for this long ago without a reply is asked for again (an 8 MB STL over a 2 Mbit/s link takes ~30 s) */
const MESH_RETRY_MS = 60000
/** a splat file is tens of MB (a 1.2M-splat home's SPZ is ~27 MB, ~2 min at 2 Mbit/s): asking again sooner would send it twice */
const SPLAT_RETRY_MS = 600000

export interface UrdfState {
    description: RobotDescription | null
    /** meshes loaded / meshes the URDF uses */
    meshesLoaded: number
    meshesWanted: number
    /** bumped whenever a mesh arrives, for models filling in */
    meshVersion: number
    problem: string | null
    /** robot model layers drawing it now (the stand-in model hides meanwhile) */
    drawing: number
    /** the arm view draws the robot itself: the layer steps aside */
    armDraws: boolean
}

export class UrdfSource {
    readonly state = new Store<UrdfState>({ description: null, meshesLoaded: 0, meshesWanted: 0, meshVersion: 0, problem: null, drawing: 0, armDraws: false })
    /** loaded meshes by URI (as the URDF names them), shared by every model built from the description (never disposed by a model) */
    readonly geometries = new Map<string, THREE.BufferGeometry>()
    /** loaded splat files by URI, likewise */
    readonly splats = new Map<string, SplatAsset>()
    #xml = ""
    #users = 0
    #stops: (() => void)[] = []
    #requests: Publisher | null = null
    /** URI → when it was last asked for */
    #asked = new Map<string, number>()
    /** URI → the hash of the copy in the cache that isn't current (sent as &have=) */
    #have = new Map<string, string>()
    #failed = new Set<string>()
    /** URIs being decoded (a splat file decodes in a worker) */
    #decoding = new Set<string>()
    #timer: ReturnType<typeof setInterval> | null = null
    /** set once the cache has been looked at for this URDF's meshes (asking waits for that) */
    #cacheChecked = false

    constructor(readonly connection: Connection) {}

    /** Starts listening (first user); the returned function lets go (the last one stops it, keeping what's loaded). */
    acquire(): () => void {
        if (this.#users++ === 0) {
            this.#stops.push(this.connection.subscribe(URDF_INFO, { delivery: "latest" }, (message) => this.#onUrdf(message.bytes)))
            // the model loads once, behind everything live
            this.#stops.push(this.connection.subscribe(MESH_INFO, { delivery: "reliable", compress: "zstd", priority: Priority.BACKGROUND, bandwidthPriority: 0.2 }, (message) => this.#onMesh(message.bytes)))
            this.#timer = setInterval(() => this.#askForMeshes(), 1000)
        }
        let released = false
        return () => {
            if (released) {
                return
            }
            released = true
            if (--this.#users === 0) {
                this.#stops.splice(0).forEach((stop) => stop())
                clearInterval(this.#timer!)
                this.#requests?.close()
                this.#requests = null
                this.#asked.clear()
            }
        }
    }

    #onUrdf(bytes: Uint8Array) {
        let xml: string
        try {
            xml = String(decode("std_msgs.String", bytes).data)
        } catch (error) {
            this.state.update({ problem: `/urdf_info isn't a std_msgs.String: ${error}` })
            return
        }
        if (xml === this.#xml) {
            return
        }
        try {
            const description = parseUrdf(xml)
            this.#xml = xml
            this.#asked.clear()
            this.#have.clear()
            this.#failed.clear()
            this.#cacheChecked = false
            this.state.update({ description, meshesWanted: meshUris(description).length, problem: null })
            this.#count()
            this.#loadCached(description)
        } catch (error) {
            this.state.update({ problem: `/urdf_info: ${error}` })
        }
    }

    #loaded = (uri: string) => this.geometries.has(uri) || this.splats.has(uri)

    #onMesh(bytes: Uint8Array) {
        const description = this.state.get().description
        let file: ReturnType<typeof decodeMeshFile>
        try {
            file = decodeMeshFile(bytes)
        } catch (error) {
            this.state.update({ problem: `/mesh_info: ${error}` })
            return
        }
        if (!description) {
            return
        }
        // the URDF's name for it: the same URL, its ?hash= possibly newer than the URDF's (the file changed since)
        const reply = splitHash(file.uri)
        const uri = meshUris(description).find((each) => each === file.uri || (reply.hash && splitHash(each).base === reply.base))
        // another page's reply, or one already loaded
        if (!uri || this.#loaded(uri) || this.#decoding.has(uri)) {
            return
        }
        this.#asked.delete(uri)
        if (reply.hash && splitHash(uri).hash) {
            storeFile(reply.base, reply.hash, file.data.slice())
        }
        this.#load(uri, file.data)
        this.#askForMeshes()
    }

    /** Turns a file's bytes into a mesh or splats (splats decode off the main thread). */
    async #load(uri: string, data: Uint8Array): Promise<boolean> {
        const fileType = splatFileType(uri, data)
        this.#decoding.add(uri)
        try {
            if (fileType) {
                this.splats.set(uri, await loadSplats(data, fileType))
            } else {
                this.geometries.set(uri, meshGeometry(uri, data))
            }
        } catch (error) {
            this.#failed.add(uri)
            this.state.update({ problem: `${uri}: ${error}` })
            return false
        } finally {
            this.#decoding.delete(uri)
            this.#count()
        }
        return true
    }

    /** Uses each cached file whose hash is the URDF's; the rest are asked for (an outdated copy's hash as &have=). */
    async #loadCached(description: RobotDescription) {
        for (const uri of meshUris(description)) {
            const { base, hash } = splitHash(uri)
            if (!hash || this.#loaded(uri)) {
                continue
            }
            const cached = await cachedFile(base)
            if (this.state.get().description !== description) {
                return
            }
            if (cached?.hash === hash) {
                // a copy that won't decode is asked for again
                if (!await this.#load(uri, cached.data)) {
                    this.#failed.delete(uri)
                }
            } else if (cached) {
                this.#have.set(uri, cached.hash)
            }
        }
        this.#cacheChecked = true
        this.#askForMeshes()
    }

    #count() {
        const description = this.state.get().description
        const loaded = description ? meshUris(description).filter(this.#loaded).length : 0
        this.state.update({ meshesLoaded: loaded, meshVersion: this.state.get().meshVersion + 1 })
    }

    #askForMeshes() {
        const description = this.state.get().description
        const client = this.connection.client
        if (!description || !client || !this.#users || !this.#cacheChecked) {
            return
        }
        const now = Date.now()
        for (const [uri, at] of this.#asked) {
            if (now - at > (this.#isSplatName(uri) ? SPLAT_RETRY_MS : MESH_RETRY_MS)) {
                this.#asked.delete(uri)
            }
        }
        const missing = meshUris(description).filter((uri) => !this.#loaded(uri) && !this.#decoding.has(uri) && !this.#failed.has(uri) && !this.#asked.has(uri))
        this.#requests ??= client.publisher(MESH_REQUEST, { delivery: "reliable" })
        for (const uri of missing.slice(0, Math.max(0, MESHES_IN_FLIGHT - this.#asked.size))) {
            const have = this.#have.get(uri)
            try {
                this.#requests.put(encode("std_msgs.String", { data: have ? `${uri}&have=${have}` : uri }))
                this.#asked.set(uri, now)
            } catch {
                // not open yet: the next tick asks
                return
            }
        }
    }

    /** a splat file by its name alone (a .ply could be either: treated as a mesh until it arrives) */
    #isSplatName = (uri: string) => splatFileType(uri, new Uint8Array()) !== null

    /** a layer instance starts or stops drawing the model */
    drawing(change: 1 | -1) {
        this.state.update({ drawing: Math.max(0, this.state.get().drawing + change) })
    }
}

const sources = new WeakMap<Connection, UrdfSource>()

/** The page's one UrdfSource for its connection. */
export function urdfSource(connection: Connection): UrdfSource {
    let source = sources.get(connection)
    if (!source) {
        source = new UrdfSource(connection)
        sources.set(connection, source)
    }
    return source
}
