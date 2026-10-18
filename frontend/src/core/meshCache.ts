// Mesh and splat files kept in IndexedDB across reloads, the 200 used most recently. A URDF names each file as a URL
// carrying its content hash (`package://pkg/mesh.stl?hash=<sha256>`): an entry is keyed by the URL without its query
// and used only while its hash is the one the URDF names, so nothing stale is ever drawn. Names without a hash aren't cached.
const DB_NAME = "dim-controller-files"
/** the old per-URDF cache, replaced by this one */
const OLD_DB_NAME = "dim-controller-meshes"
export const MAX_CACHED_FILES = 200

export interface CachedFile {
    hash: string
    data: Uint8Array
    /** when it was last stored or read (Date.now()), for evicting the least recently used */
    used: number
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
            const request = indexedDB.open(DB_NAME, 1)
            request.onupgradeneeded = () => request.result.createObjectStore("files").createIndex("used", "used")
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
            const files = db!.transaction("files", "readwrite").objectStore("files")
            const request = files.get(base)
            request.onsuccess = () => {
                const entry = request.result as CachedFile | undefined
                if (!entry || !(entry.data instanceof Uint8Array)) {
                    resolve(null)
                    return
                }
                files.put({ ...entry, used: Date.now() }, base)
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
        const files = db!.transaction("files", "readwrite").objectStore("files")
        files.put({ hash, data, used: Date.now() } satisfies CachedFile, base)
        const counted = files.count()
        counted.onsuccess = () => {
            let excess = counted.result - MAX_CACHED_FILES
            if (excess <= 0) {
                return
            }
            // oldest first
            files.index("used").openKeyCursor().onsuccess = (event) => {
                const cursor = (event.target as IDBRequest<IDBCursor | null>).result
                if (cursor && excess-- > 0) {
                    files.delete(cursor.primaryKey)
                    cursor.continue()
                }
            }
        }
    } catch {
        // full or unavailable: the next load asks the robot again
    }
}
