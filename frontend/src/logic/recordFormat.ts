// The recorder popover's pure parts (ui/RecordControl.tsx): what's recorded, the biggest streams, and how numbers read.
import type { StreamRate } from "./recorder.ts"
import type { Topic } from "./connection.ts"

export const isRecorded = (key: string, chosen: Record<string, boolean>) => chosen[key] ?? true
export const isRpcTopic = (topic: Topic) => /^\/rpc\//.test(topic.name) || /\/(req|res)$/.test(topic.name)

/** how many of the biggest streams the basic options offer to leave out */
export const TOP_STREAMS = 5

export const formatBytes = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} kB`
export const formatRate = (bytesPerSecond: number) =>
    bytesPerSecond >= 1e6 ? `${(bytesPerSecond / 1e6).toFixed(1)} MB/s` : bytesPerSecond >= 1e3 ? `${(bytesPerSecond / 1e3).toFixed(1)} kB/s` : `${Math.round(bytesPerSecond)} B/s`
export const formatClock = (seconds: number) => {
    const whole = Math.floor(seconds)
    const hours = Math.floor(whole / 3600)
    const minutes = Math.floor((whole % 3600) / 60)
    const rest = String(whole % 60).padStart(2, "0")
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}

/** The streams the basic options list: the biggest by measured bytes/s that send anything. */
export function biggestStreams(streams: StreamRate[], count = TOP_STREAMS): StreamRate[] {
    return [...streams].filter((stream) => stream.bytesPerSecond > 0).sort((a, b) => b.bytesPerSecond - a.bytesPerSecond).slice(0, count)
}

/** Whether `directory` is inside Desktop's shared recordings folder (what the Recordings app lists). */
export function inRecordingsFolder(directory: string, root: string | null): boolean {
    if (!root) {
        return true
    }
    const trimmed = root.replace(/\/+$/, "")
    return directory === trimmed || directory.startsWith(`${trimmed}/`)
}

