// The IndexedDB file cache (core/meshCache.ts) and UrdfSource's use of it: a file that came once is drawn from the cache
// on the next load without asking the robot again, and a tab holding the cache's old version open doesn't stall a load.
import { assertEquals } from "jsr:@std/assert@1"
import { DOMParser } from "https://esm.sh/@xmldom/xmldom@0.8.10"
import { IDBFactory } from "https://esm.sh/fake-indexeddb@6.0.0?bundle"
import { encode } from "../src/core/lcm/lcm.ts"
import { Store } from "../src/core/store.ts"
import type { Connection, ConnectionState } from "../src/core/transport.ts"
import { cachedFile, resetCacheConnection, storeFile } from "../src/core/meshCache.ts"
import { FILE_INFO, ROBOT_DESCRIPTION, UrdfSource } from "../src/core/urdfSource.ts"

;(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser
const global = globalThis as { indexedDB?: IDBFactory }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const quietly = async (run: () => Promise<void>) => {
    const info = console.info
    console.info = () => {}
    try {
        await run()
    } finally {
        console.info = info
    }
}

/** a fresh, empty IndexedDB for one test, removed after it */
async function withIndexedDb(run: (factory: IDBFactory) => Promise<void>) {
    const factory = new IDBFactory()
    global.indexedDB = factory
    resetCacheConnection()
    try {
        await quietly(() => run(factory))
    } finally {
        // fake-indexeddb's work runs on timers: let them finish
        await wait(50)
        delete global.indexedDB
        resetCacheConnection()
    }
}

/** a binary STL of one triangle */
function stl(): Uint8Array {
    const bytes = new Uint8Array(84 + 50)
    const view = new DataView(bytes.buffer)
    view.setUint32(80, 1, true)
    ;[0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => view.setFloat32(84 + index * 4, value, true))
    return bytes
}

/** files.MeshFile's wire form: `<f64 ts><u32 uri length><uri><file bytes>` */
function meshInfo(uri: string, data: Uint8Array): Uint8Array {
    const name = new TextEncoder().encode(uri)
    const bytes = new Uint8Array(12 + name.length + data.length)
    new DataView(bytes.buffer).setUint32(8, name.length, true)
    bytes.set(name, 12)
    bytes.set(data, 12 + name.length)
    return bytes
}

const URI = "package://p/body.stl?hash=abc"
const URDF = `<?xml version="1.0"?><robot name="r"><link name="base_link"><visual><geometry><mesh filename="${URI}"/></geometry></visual></link></robot>`

/** a page load: a UrdfSource on a fake connection, the URDF sent, the robot answering each /file_request with the file */
async function load() {
    const requests: string[] = []
    const handlers = new Map<string, (message: { bytes: Uint8Array }) => void>()
    const connection = {
        client: {
            publisher: () => ({
                put(bytes: Uint8Array) {
                    const asked = new TextDecoder().decode(bytes)
                    if (asked.includes("package://")) {
                        requests.push(URI)
                        const meshFile = meshInfo(URI, stl())
                        setTimeout(() => handlers.get(FILE_INFO)?.({ bytes: meshFile }))
                    }
                },
                close() {},
            }),
        },
        status: new Store({ state: "connected" } as ConnectionState),
        subscribe(key: string, _options: unknown, onMessage: (message: { bytes: Uint8Array }) => void) {
            handlers.set(key, onMessage)
            return () => handlers.delete(key)
        },
    } as unknown as Connection
    const source = new UrdfSource(connection)
    const release = source.acquire()
    handlers.get(ROBOT_DESCRIPTION)!({ bytes: encode("std_msgs.String", { data: URDF }) })
    for (let tries = 0; tries < 100 && source.state.get().meshesLoaded < 1; tries++) {
        await wait(20)
    }
    const loaded = source.state.get().meshesLoaded
    release()
    // the store's transaction commits
    await wait(50)
    return { requests, loaded }
}

Deno.test({ name: "a stored file is read back whole, under its hash" }, async () => {
    await withIndexedDb(async () => {
        const backing = new Uint8Array(1000).fill(7)
        await storeFile("package://p/a.stl", "h1", backing.subarray(10, 20))
        await wait(20)
        const cached = await cachedFile("package://p/a.stl")
        assertEquals(cached?.hash, "h1")
        assertEquals(cached?.data.byteLength, 10, "the view's bytes, not its backing buffer")
    })
})

Deno.test({ name: "a file that came on the first load is drawn from the cache on the next, without asking the robot" }, async () => {
    await withIndexedDb(async () => {
        const first = await load()
        assertEquals(first, { requests: [URI], loaded: 1 })
        // a reload: the page's connection to the database is gone, the database isn't
        resetCacheConnection()
        const second = await load()
        assertEquals(second, { requests: [], loaded: 1 })
    })
})

Deno.test({ name: "a tab holding the cache's old version open doesn't stall the load: it goes without a cache" }, async () => {
    await withIndexedDb(async (factory) => {
        const old = await new Promise<IDBDatabase>((resolve) => {
            const request = factory.open("dim-controller-files", 1)
            request.onsuccess = () => resolve(request.result)
        })
        let timer = 0
        const result = await Promise.race([load(), new Promise((resolve) => timer = setTimeout(() => resolve("stalled"), 3000))])
        clearTimeout(timer)
        assertEquals(result, { requests: [URI], loaded: 1 })
        old.close()
    })
})
