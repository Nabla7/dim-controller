// Mesh and splat files kept in IndexedDB across reloads, the 200 used most recently. A URDF names each file as a URL
// carrying its content hash (`package://pkg/mesh.stl?hash=<sha256>`): an entry is keyed by the URL without its query
// and used only while its hash is the one the URDF names, so nothing stale is ever drawn. Names without a hash aren't cached.
// When each was last used is kept apart from the file, so marking a read doesn't rewrite a 30 MB file, and reads are
// read-only transactions, which run side by side.
const DB_NAME = "dim-controller-files"
/** the old per-URDF cache, replaced by this one */
const OLD_DB_NAME = "dim-controller-meshes"
export const MAX_CACHED_FILES = 200

export interface CachedFile {
    hash: string
    data: Uint8Array
}

/** `package://pkg/a.stl?hash=ab12` → { base: "package://pkg/a.stl", hash: "ab12" }; no ?hash= (or an empty one) → hash null. */
export function splitHash(uri: string): { base: string; hash: string | null } {
    const question = uri.indexOf("?")
    if (question < 0) {
        return { base: uri, hash: null }
    }
    const hash = new URLSearchParams(uri.slice(question + 1)).get("hash")
    return { base: uri.slice(0, question), hash: hash || null }
}

let database: Promise<IDBDatabase | null> | null = null
function openCache(): Promise<IDBDatabase | null> {
    database ??= new Promise((resolve) => {
        try {
            indexedDB.deleteDatabase(OLD_DB_NAME)
            // version 2: "used" (URL → Date.now()) apart from "files" (URL → CachedFile); version 1's files kept `used` inside
            const request = indexedDB.open(DB_NAME, 2)
            request.onupgradeneeded = () => {
                const db = request.result
                for (const name of [...db.objectStoreNames]) {
                    db.deleteObjectStore(name)
                }
                db.createObjectStore("files")
                db.createObjectStore("used")
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => resolve(null)
        } catch {
            // no IndexedDB (a private window, tests): no cache
            resolve(null)
        }
    })
    return database
}

/** The cached file for this URL (without its query), marked as just used; null if none. */
export async function cachedFile(base: string): Promise<CachedFile | null> {
    const db = await openCache()
    return new Promise((resolve) => {
        try {
            const request = db!.transaction("files", "readonly").objectStore("files").get(base)
            request.onsuccess = () => {
                const entry = request.result as CachedFile | undefined
                if (!entry || !(entry.data instanceof Uint8Array)) {
                    resolve(null)
                    return
                }
                db!.transaction("used", "readwrite").objectStore("used").put(Date.now(), base)
                resolve(entry)
            }
            request.onerror = () => resolve(null)
        } catch {
            resolve(null)
        }
    })
}

/** Keeps a file under its URL (without its query) and hash, evicting the least recently used past MAX_CACHED_FILES. */
export async function storeFile(base: string, hash: string, data: Uint8Array) {
    const db = await openCache()
    try {
        const transaction = db!.transaction(["files", "used"], "readwrite")
        const [files, used] = [transaction.objectStore("files"), transaction.objectStore("used")]
        files.put({ hash, data } satisfies CachedFile, base)
        used.put(Date.now(), base)
        const keys = used.getAllKeys()
        const times = used.getAll()
        times.onsuccess = () => {
            const oldestFirst = keys.result.map((key, index) => ({ key, at: times.result[index] as number })).sort((a, b) => a.at - b.at)
            for (const { key } of oldestFirst.slice(0, Math.max(0, oldestFirst.length - MAX_CACHED_FILES))) {
                files.delete(key)
                used.delete(key)
            }
        }
    } catch {
        // full or unavailable: the next load asks the robot again
    }
}
