// The robot's URDF and its meshes from dimos's UrdfManager, one per page, shared by the robot model layer and the arm
// view: /robot_description's XML (re-sent every 5 s, nothing is latched; an empty /file_request has it sent now, which the page
// sends on subscribing and on every connect) and each mesh asked for on /file_request, its reply on
// /file_info matched by URL (replies come in any order, possibly from more than one publisher). Subscribed only while
// something uses it (acquire). A mesh named with ?hash=<sha256> is kept in IndexedDB (core/meshCache.ts) and asked for
// with `&have=<the cached hash>` only when that isn't the URDF's; one without a hash is asked for each load, uncached.
// Splat files (core/splats.ts) come the same way and are kept apart from the meshes.
import type * as THREE from "three"
import { decode, encode } from "./lcm/lcm.ts"
import { Store } from "./store.ts"
import { type Connection, dimosKey, Priority, type Publisher } from "./transport.ts"
import { decodeMeshFile, meshGeometry, meshUris, parseUrdf } from "dimos-react/three"
import { cachedFile, meshLog, splitHash, storeFile } from "./meshCache.ts"
import { loadSplats, type SplatAsset, splatFileType, StaleBuildError } from "./splats.ts"
import type { RobotDescription } from "./robotDescription.ts"

export const ROBOT_DESCRIPTION = dimosKey("/robot_description", "std_msgs.String")
export const FILE_REQUEST = dimosKey("/file_request", "std_msgs.String")
/** /file_info and anything under it (/file_info/**): zenoh's `**` also matches no chunks */
export const FILE_INFO = dimosKey("/file_info/**", "files.MeshFile")
/** files asked for at once: one reply can be several MB, so two at a time keep the link for driving and video (and a
 * burst of them loses some on the way, each then waiting out MESH_RETRY_MS) */
const MESHES_IN_FLIGHT = 2
/** a mesh asked for this long ago without a reply is asked for again (an 8 MB STL over a 2 Mbit/s link takes ~30 s) */
const MESH_RETRY_MS = 60000
/** a splat file is tens of MB (a 1.2M-splat home's SPZ is ~27 MB, ~2 min at 2 Mbit/s): asking again sooner would send it twice */
const SPLAT_RETRY_MS = 600000
/** an empty /file_request (asking for /robot_description now) is re-sent this often until it comes: the first can go out before the subscription is open */
const URDF_ASK_MS = 250
/** ...for at most this long: by then the 5 s re-send has come, if anything publishes it */
const URDF_ASK_FOR_MS = 5000

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
    /** the URDF's files in the order they're wanted (fileRanks) */
    #files: string[] = []
    /** for the console: when the URDF came (performance.now()), each file's rank, the ranks logged as drawn */
    #urdfAt = 0
    #ranks = new Map<string, number>()
    #drawnRanks = new Set<number>()
    /** while asking for /robot_description: the re-ask timer, and when asking stops */
    #urdfAsk: { timer: ReturnType<typeof setInterval>; until: number } | null = null

    constructor(readonly connection: Connection) {}

    /** Starts listening (first user); the returned function lets go (the last one stops it, keeping what's loaded). */
    acquire(): () => void {
        if (this.#users++ === 0) {
            this.#stops.push(this.connection.subscribe(ROBOT_DESCRIPTION, { delivery: "latest" }, (message) => this.#onUrdf(message.bytes)))
            // the model loads once, behind everything live
            this.#stops.push(this.connection.subscribe(FILE_INFO, { delivery: "reliable", compress: "zstd", priority: Priority.BACKGROUND, bandwidthPriority: 0.2 }, (message) => this.#onMesh(message.bytes)))
            this.#timer = setInterval(() => this.#askForMeshes(), 1000)
            let state = this.connection.status.get().state
            this.#stops.push(this.connection.status.subscribe(() => {
                const now = this.connection.status.get().state
                if (now === "connected" && state !== "connected" && state !== "degraded") {
                    this.#askForUrdf()
                }
                state = now
            }))
            this.#askForUrdf()
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
                this.#stopAskingForUrdf()
                this.#requests?.close()
                this.#requests = null
                this.#asked.clear()
            }
        }
    }

    /** Asks for /robot_description now (an empty /file_request), again every URDF_ASK_MS until it comes. */
    #askForUrdf() {
        this.#stopAskingForUrdf()
        const ask = () => {
            if (Date.now() > this.#urdfAsk!.until) {
                this.#stopAskingForUrdf()
                return
            }
            try {
                this.#publisher()?.put(encode("std_msgs.String", { data: "" }))
            } catch {
                // not open yet: the next one goes
            }
        }
        this.#urdfAsk = { timer: setInterval(ask, URDF_ASK_MS), until: Date.now() + URDF_ASK_FOR_MS }
        ask()
    }

    #stopAskingForUrdf() {
        clearInterval(this.#urdfAsk?.timer)
        this.#urdfAsk = null
    }

    #publisher(): Publisher | null {
        const client = this.connection.client
        if (client) {
            this.#requests ??= client.publisher(FILE_REQUEST, { delivery: "reliable" })
        }
        return this.#requests
    }

    #onUrdf(bytes: Uint8Array) {
        this.#stopAskingForUrdf()
        let xml: string
        try {
            xml = String(decode("std_msgs.String", bytes).data)
        } catch (error) {
            this.state.update({ problem: `/robot_description isn't a std_msgs.String: ${error}` })
            return
        }
        // nothing yet (or an empty one) isn't a URDF
        if (xml === this.#xml || !xml) {
            return
        }
        try {
            const description = parseUrdf(xml)
            this.#xml = xml
            this.#asked.clear()
            this.#have.clear()
            this.#failed.clear()
            this.#cacheChecked = false
            const ranks = fileRanks(description)
            this.#files = meshUris(description).sort((a, b) => ranks.get(a)! - ranks.get(b)!)
            this.#urdfAt = performance.now()
            this.#ranks = ranks
            this.#drawnRanks.clear()
            meshLog(`URDF: ${this.#files.length} files, ${this.#files.filter((uri) => splitHash(uri).hash).length} with a hash (cacheable)`)
            this.state.update({ description, meshesWanted: meshUris(description).length, problem: null })
            this.#count()
            this.#loadCached(description)
        } catch (error) {
            this.state.update({ problem: `/robot_description: ${error}` })
        }
    }

    #loaded = (uri: string) => this.geometries.has(uri) || this.splats.has(uri)

    #onMesh(bytes: Uint8Array) {
        const description = this.state.get().description
        let file: ReturnType<typeof decodeMeshFile>
        try {
            file = decodeMeshFile(bytes)
        } catch (error) {
            this.state.update({ problem: `/file_info: ${error}` })
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
        meshLog(`got ${file.uri.split("/").pop()?.split("?")[0]} (${(file.data.byteLength / 1e6).toFixed(1)} MB) ${this.#sinceUrdf()}`)
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
        const started = performance.now()
        try {
            if (fileType) {
                this.splats.set(uri, await loadSplats(data, fileType))
            } else {
                this.geometries.set(uri, meshGeometry(uri, data))
            }
            meshLog(`decoded ${uri.split("/").pop()?.split("?")[0]} in ${Math.round(performance.now() - started)} ms, ${this.#sinceUrdf()}`)
        } catch (error) {
            this.#failed.add(uri)
            this.state.update({ problem: error instanceof StaleBuildError ? error.message : `${uri}: ${error}` })
            return false
        } finally {
            this.#decoding.delete(uri)
            this.#count()
        }
        return true
    }

    /** Looks every hashed file up in the cache at once, using each whose hash is the URDF's as soon as it's read (the
     * robot's first); the rest are asked for (an outdated copy's hash as &have=) once every lookup is done. */
    async #loadCached(description: RobotDescription) {
        const loads: Promise<unknown>[] = []
        const counts = { hit: 0, hitBytes: 0, stale: 0, missing: 0 }
        await Promise.all(this.#files.map(async (uri) => {
            const { base, hash } = splitHash(uri)
            if (!hash || this.#loaded(uri)) {
                return
            }
            const cached = await cachedFile(base)
            if (this.state.get().description !== description) {
                return
            }
            if (cached?.hash === hash) {
                counts.hit++
                counts.hitBytes += cached.data.byteLength
                // a copy that won't decode is asked for again
                loads.push(this.#load(uri, cached.data).then((loaded) => loaded || this.#failed.delete(uri)))
            } else if (cached) {
                counts.stale++
                this.#have.set(uri, cached.hash)
            } else {
                counts.missing++
            }
        }))
        if (this.state.get().description !== description) {
            return
        }
        this.#cacheChecked = true
        meshLog(`cache: ${counts.hit} hits (${(counts.hitBytes / 1e6).toFixed(1)} MB), ${counts.stale} outdated, ${counts.missing} not cached; looked up ${this.#sinceUrdf()}`)
        this.#askForMeshes()
        // a cached copy that didn't decode is asked for now
        await Promise.all(loads)
        this.#askForMeshes()
    }

    #count() {
        const description = this.state.get().description
        const loaded = description ? meshUris(description).filter(this.#loaded).length : 0
        this.state.update({ meshesLoaded: loaded, meshVersion: this.state.get().meshVersion + 1 })
        for (const [rank, name] of ["robot", "scene tiles", "splats"].entries()) {
            const files = this.#files.filter((uri) => this.#ranks.get(uri) === rank)
            if (files.length && !this.#drawnRanks.has(rank) && files.every(this.#loaded)) {
                this.#drawnRanks.add(rank)
                meshLog(`${name} ready (${files.length} files) ${this.#sinceUrdf()}`)
            }
        }
    }

    #askForMeshes() {
        const description = this.state.get().description
        if (!description || !this.connection.client || !this.#users || !this.#cacheChecked) {
            return
        }
        const now = Date.now()
        for (const [uri, at] of this.#asked) {
            if (now - at > (isSplatName(uri) ? SPLAT_RETRY_MS : MESH_RETRY_MS)) {
                this.#asked.delete(uri)
            }
        }
        const missing = this.#files.filter((uri) => !this.#loaded(uri) && !this.#decoding.has(uri) && !this.#failed.has(uri) && !this.#asked.has(uri))
        const requests = this.#publisher()!
        for (const uri of missing.slice(0, Math.max(0, MESHES_IN_FLIGHT - this.#asked.size))) {
            const have = this.#have.get(uri)
            try {
                requests.put(encode("std_msgs.String", { data: have ? `${uri}&have=${have}` : uri }))
                meshLog(`asked for ${uri.split("/").pop()?.split("?")[0]}${have ? " (cached copy outdated)" : ""} ${this.#sinceUrdf()}`)
                this.#asked.set(uri, now)
            } catch {
                // not open yet: the next tick asks
                return
            }
        }
    }

    #sinceUrdf = () => `${Math.round(performance.now() - this.#urdfAt)} ms after the URDF`

    /** a layer instance starts or stops drawing the model */
    drawing(change: 1 | -1) {
        this.state.update({ drawing: Math.max(0, this.state.get().drawing + change) })
    }
}

/** a splat file by its name alone (a .ply could be either: treated as a mesh until it arrives) */
const isSplatName = (uri: string) => splatFileType(uri, new Uint8Array()) !== null

/** Each file the URDF names, ranked by when it's wanted: 0 the robot's own, 1 those on links fixed to the root (a
 * scene's big tiles), 2 splat files. */
export function fileRanks(description: RobotDescription): Map<string, number> {
    const children = new Set(description.joints.map((joint) => joint.child))
    const fixed = new Set(description.links.filter((link) => !children.has(link.name)).map((link) => link.name))
    for (let grew = true; grew;) {
        grew = false
        for (const joint of description.joints) {
            if (joint.type === "fixed" && fixed.has(joint.parent) && !fixed.has(joint.child)) {
                fixed.add(joint.child)
                grew = true
            }
        }
    }
    const ranks = new Map<string, number>()
    for (const link of description.links) {
        for (const { mesh } of [...link.visuals, ...link.collisions]) {
            if (mesh) {
                ranks.set(mesh, Math.min(ranks.get(mesh) ?? 2, isSplatName(mesh) ? 2 : fixed.has(link.name) ? 1 : 0))
            }
        }
    }
    return ranks
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
