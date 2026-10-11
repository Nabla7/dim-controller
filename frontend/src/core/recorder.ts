// Client for this app's own backend recorder (server/src/recorder.rs), at ./api/recorder.
import { Store } from "./store.ts"

export interface RecordingStatus {
    active: boolean
    path: string | null
    messages: number
    bytes: number
    dropped: number
    /** left out by a stream's max rate */
    skipped: number
    seconds: number
}

export type ImageFormat = "raw" | "jpeg" | "png" | "webp" | "jpegxl"
export type Compression = "none" | "lz4" | "zstd"

/** The recorder's saved options (the lv.record.options setting, server/src/recorder.rs `Options`). */
export interface RecorderOptions {
    recordNew: boolean
    compression: Compression
    image_format: ImageFormat
    /** "" = the default folder */
    directory: string
    logs: boolean
    /** topic key → max messages per second */
    rates: Record<string, number>
}

/** One stream on the bus as the backend's meter measures it (GET api/recorder/streams). */
export interface StreamRate {
    key: string
    topic: string
    type: string
    bytesPerSecond: number
    messagesPerSecond: number
    recorded: boolean
    maxRate: number | null
}

export interface RecordingFile {
    name: string
    path: string
    bytes: number
    seconds_old: number
    /** Desktop's id for it in the shared recordings folder (GET /recordings); absent when listed by this backend */
    id?: string
}

export interface RecorderStatus {
    recording: RecordingStatus
    keys: string[]
    /** dimos log dirs being tailed into the recording, and the lines written so far */
    logs: { dirs: string[]; lines: number }
    files: RecordingFile[]
    settings: { compression: Compression; image_format: ImageFormat }
    /** where the next recording goes */
    directory: string
    /** where it goes when no folder is chosen */
    default_directory: string
    /** Desktop's shared recordings folder (what the Recordings app lists), when Desktop said */
    recordings_root: string | null
    options: RecorderOptions
    /** null = the backend answered; else why it didn't */
    unavailable: string | null
}

const base = () => new URL("api/recorder", location.href).href
// Desktop's shared recordings folder API (docs/api.md in dimos-desktop); the page lives at /apps/<name>/
const desktopRecordings = () => new URL("../../recordings", location.href).href

interface DesktopRecording {
    id: string
    name: string
    path: string
    size: number
    modified: number
}

/** Every recording in Desktop's shared folder, or null when this page isn't running inside Desktop. */
async function sharedRecordings(): Promise<RecordingFile[] | null> {
    try {
        const response = await fetch(desktopRecordings())
        if (!response.ok) {
            return null
        }
        const body = (await response.json()) as { recordings: DesktopRecording[] }
        const now = Date.now() / 1000
        return body.recordings.map((recording) => ({
            id: recording.id,
            name: recording.id,
            path: recording.path,
            bytes: recording.size,
            seconds_old: Math.max(0, now - recording.modified),
        }))
    } catch {
        return null
    }
}

async function call(path: string, init?: RequestInit) {
    const response = await fetch(base() + path, { headers: { "content-type": "application/json" }, ...init })
    if (response.status === 204) {
        return null
    }
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
        throw new Error(body.error ?? `${response.status}`)
    }
    return body
}

export const DEFAULT_OPTIONS: RecorderOptions = { recordNew: true, compression: "none", image_format: "raw", directory: "", logs: true, rates: {} }

class RecorderClient {
    readonly status = new Store<RecorderStatus>({
        recording: { active: false, path: null, messages: 0, bytes: 0, dropped: 0, skipped: 0, seconds: 0 },
        keys: [],
        logs: { dirs: [], lines: 0 },
        files: [],
        settings: { compression: "none", image_format: "raw" },
        directory: "",
        default_directory: "",
        recordings_root: null,
        options: DEFAULT_OPTIONS,
        unavailable: "connecting…",
    })
    /** a start or stop on its way (the button waits on it, so a double click can't start two) */
    readonly pending = new Store<{ action: "start" | "stop" | null }>({ action: null })
    /** each stream's live bytes/s, while the options popover is open (`watchStreams`) */
    readonly streams = new Store<{ list: StreamRate[]; seconds: number; error: string | null }>({ list: [], seconds: 0, error: null })
    #watchers = 0
    #streamWatchers = 0

    constructor() {
        this.#poll()
    }

    async refresh() {
        try {
            const [status, shared] = await Promise.all([call(""), sharedRecordings()])
            // the file list is Desktop's shared folder when there is one (it's where this recorder writes)
            this.status.set({ ...status, files: shared ?? status.files, unavailable: null })
        } catch (error) {
            this.status.update({ unavailable: `recorder backend unreachable (${error})` })
        }
    }

    async #poll() {
        for (;;) {
            await this.refresh()
            const fast = this.status.get().recording.active || this.#watchers > 0
            await new Promise((resolve) => setTimeout(resolve, fast ? 1000 : 5000))
        }
    }

    /** A panel showing live numbers asks for 1 s updates while it's open. */
    watch(): () => void {
        this.#watchers++
        return () => this.#watchers--
    }

    /**
     * Starts recording `keys`, or (null) every topic on the bus except rpc ones and the ones unticked in the panel,
     * with new topics joining: the backend picks them, and the running dimos's logs (server/src/recorder.rs).
     */
    async start(keys: string[] | null) {
        await this.#act("start", () => call("/start", { method: "POST", body: JSON.stringify(keys ? { keys } : {}) }))
    }

    async stop() {
        await this.#act("stop", () => call("/stop", { method: "POST" }))
    }

    /** One start or stop at a time; whatever happens the status is read again (another page may have started one). */
    async #act(action: "start" | "stop", work: () => Promise<unknown>) {
        if (this.pending.get().action) {
            return
        }
        this.pending.set({ action })
        try {
            await work()
        } finally {
            await this.refresh()
            this.pending.set({ action: null })
        }
    }

    /** Changes saved options (PUT api/recorder/settings); the format and folder can't change while recording. */
    async settings(patch: Partial<Omit<RecorderOptions, "rates">> & { rates?: Record<string, number | null> }) {
        this.status.set({ ...(await call("/settings", { method: "PUT", body: JSON.stringify(patch) })), unavailable: null })
    }

    /** The options popover asks for live stream rates (every 1.5 s) while it's open. */
    watchStreams(): () => void {
        this.#streamWatchers++
        if (this.#streamWatchers === 1) {
            this.#pollStreams()
        }
        return () => this.#streamWatchers--
    }

    async #pollStreams() {
        while (this.#streamWatchers > 0) {
            try {
                const body = await call("/streams")
                this.streams.set({ list: body.streams, seconds: body.seconds, error: null })
            } catch (error) {
                this.streams.update({ error: String((error as Error).message ?? error) })
            }
            await new Promise((resolve) => setTimeout(resolve, 1500))
        }
    }

    async remove(file: RecordingFile) {
        if (file.id) {
            const response = await fetch(`${desktopRecordings()}/${file.id.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" })
            if (!response.ok) {
                throw new Error((await response.json().catch(() => ({}))).error ?? `${response.status}`)
            }
        } else {
            await call(`/files/${encodeURIComponent(file.name)}`, { method: "DELETE" })
        }
        await this.refresh()
    }

    downloadUrl(file: RecordingFile) {
        if (file.id) {
            return `${desktopRecordings()}/${file.id.split("/").map(encodeURIComponent).join("/")}/file`
        }
        return `${base()}/files/${encodeURIComponent(file.name)}`
    }
}

export const recorder = new RecorderClient()
