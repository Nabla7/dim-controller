// The robot's URDF and its meshes from dimos's UrdfManager, one per page, shared by the robot model layer and the arm
// view: /urdf_info's XML (re-sent every 5 s, nothing is latched) and each mesh asked for once on /mesh_request, its
// reply on /mesh_info matched by URI (replies come in any order, possibly from more than one publisher). Subscribed
// only while something uses it (acquire). Mesh files are kept in IndexedDB per URDF, so a reload doesn't fetch them again.
import type * as THREE from "three"
import { decode, encode } from "./lcm/lcm.ts"
import { Store } from "./store.ts"
import { type Connection, dimosKey, Priority, type Publisher } from "./transport.ts"
import { decodeMeshFile, meshGeometry, meshUris, parseUrdf } from "./urdf.ts"
import type { RobotDescription } from "./robotDescription.ts"

export const URDF_INFO = dimosKey("/urdf_info", "std_msgs.String")
export const MESH_REQUEST = dimosKey("/mesh_request", "std_msgs.String")
export const MESH_INFO = dimosKey("/mesh_info", "shape_msgs.MeshFile")
/** meshes asked for at once: one reply can be several MB, so two at a time keep the link for driving and video */
const MESHES_IN_FLIGHT = 2
/** a mesh asked for this long ago without a reply is asked for again (an 8 MB STL over a 2 Mbit/s link takes ~30 s) */
const MESH_RETRY_MS = 60000
const CACHE_DB = "dim-controller-meshes"

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
    /** loaded meshes by URI, shared by every model built from the description (never disposed by a model) */
    readonly geometries = new Map<string, THREE.BufferGeometry>()
    #xml = ""
    #users = 0
    #stops: (() => void)[] = []
    #requests: Publisher | null = null
    /** URI → when it was last asked for */
    #asked = new Map<string, number>()
    #failed = new Set<string>()
    #timer: ReturnType<typeof setInterval> | null = null
    /** this URDF's cache key prefix, set once its cached meshes are loaded (asking waits for that) */
    #cacheKey: string | null = null

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
            this.#failed.clear()
            this.#cacheKey = null
            this.state.update({ description, meshesWanted: meshUris(description).length, problem: null })
            this.#count()
            this.#loadCached(description, `${hash(xml)}:`)
        } catch (error) {
            this.state.update({ problem: `/urdf_info: ${error}` })
        }
    }

    #onMesh(bytes: Uint8Array) {
        const description = this.state.get().description
        let file: ReturnType<typeof decodeMeshFile>
        try {
            file = decodeMeshFile(bytes)
        } catch (error) {
            this.state.update({ problem: `/mesh_info: ${error}` })
            return
        }
        // another page's reply, or one already loaded
        if (!description || this.geometries.has(file.uri) || !meshUris(description).includes(file.uri)) {
            return
        }
        this.#asked.delete(file.uri)
        try {
            this.geometries.set(file.uri, meshGeometry(file.uri, file.data))
            if (this.#cacheKey) {
                cachePut(this.#cacheKey + file.uri, file.data.slice())
            }
        } catch (error) {
            this.#failed.add(file.uri)
            this.state.update({ problem: `${file.uri}: ${error}` })
        }
        this.#count()
        this.#askForMeshes()
    }

    /** Meshes this URDF loaded before (any page on this browser), then asks for the rest. */
    async #loadCached(description: RobotDescription, key: string) {
        for (const uri of meshUris(description)) {
            if (this.geometries.has(uri)) {
                continue
            }
            const data = await cacheGet(key + uri)
            if (this.state.get().description !== description) {
                return
            }
            if (data && !this.geometries.has(uri)) {
                try {
                    this.geometries.set(uri, meshGeometry(uri, data))
                } catch {
                    // a bad entry: asked for again
                }
            }
        }
        this.#cacheKey = key
        this.#count()
        this.#askForMeshes()
    }

    #count() {
        const description = this.state.get().description
        const loaded = description ? meshUris(description).filter((uri) => this.geometries.has(uri)).length : 0
        this.state.update({ meshesLoaded: loaded, meshVersion: this.state.get().meshVersion + 1 })
    }

    #askForMeshes() {
        const description = this.state.get().description
        const client = this.connection.client
        if (!description || !client || !this.#users || this.#cacheKey === null) {
            return
        }
        const now = Date.now()
        for (const [uri, at] of this.#asked) {
            if (now - at > MESH_RETRY_MS) {
                this.#asked.delete(uri)
            }
        }
        const missing = meshUris(description).filter((uri) => !this.geometries.has(uri) && !this.#failed.has(uri) && !this.#asked.has(uri))
        this.#requests ??= client.publisher(MESH_REQUEST, { delivery: "reliable" })
        for (const uri of missing.slice(0, Math.max(0, MESHES_IN_FLIGHT - this.#asked.size))) {
            try {
                this.#requests.put(encode("std_msgs.String", { data: uri }))
                this.#asked.set(uri, now)
            } catch {
                // not open yet: the next tick asks
                return
            }
        }
    }

    /** a layer instance starts or stops drawing the model */
    drawing(change: 1 | -1) {
        this.state.update({ drawing: Math.max(0, this.state.get().drawing + change) })
    }
}

/** FNV-1a of the URDF: its meshes are cached under it, so a changed URDF fetches them again */
function hash(text: string): string {
    let value = 0x811c9dc5
    for (let index = 0; index < text.length; index++) {
        value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0
    }
    return value.toString(16)
}

let database: Promise<IDBDatabase | null> | null = null
function openCache(): Promise<IDBDatabase | null> {
    database ??= new Promise((resolve) => {
        try {
            const request = indexedDB.open(CACHE_DB, 1)
            request.onupgradeneeded = () => request.result.createObjectStore("meshes")
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => resolve(null)
        } catch {
            // no IndexedDB (a private window, tests): no cache
            resolve(null)
        }
    })
    return database
}

async function cacheGet(key: string): Promise<Uint8Array | null> {
    const db = await openCache()
    return new Promise((resolve) => {
        try {
            const request = db!.transaction("meshes").objectStore("meshes").get(key)
            request.onsuccess = () => resolve(request.result instanceof Uint8Array ? request.result : null)
            request.onerror = () => resolve(null)
        } catch {
            resolve(null)
        }
    })
}

async function cachePut(key: string, data: Uint8Array) {
    const db = await openCache()
    try {
        db?.transaction("meshes", "readwrite").objectStore("meshes").put(data, key)
    } catch {
        // full or unavailable: the next load asks the robot again
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
