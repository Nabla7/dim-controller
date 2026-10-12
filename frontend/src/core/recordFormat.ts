// The recorder popover's pure parts (ui/RecordControl.tsx): what's recorded, the biggest streams, and how numbers read.
import type { StreamRate } from "./recorder.ts"
import type { Topic } from "./transport.ts"

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


/**
 * The Record toggle's state, the bar's and the phone HUD's alike: recording (and for how long), the short text, and
 * whether it can be pressed (not while starting / stopping, not with the recorder down, not with nothing to record).
 */
export function recordToggleState(input: {
    active: boolean
    pending: "start" | "stop" | null
    unavailable: string | null | undefined
    recordNew: boolean
    selected: number
    seconds: number
}): { recording: boolean; text: string; disabled: boolean } {
    const { active, pending, unavailable, recordNew, selected, seconds } = input
    const text = pending === "start" ? "Starting…" : pending === "stop" ? "Stopping…" : active ? formatClock(seconds) : "REC"
    return { recording: active, text, disabled: pending !== null || !!unavailable || (!active && !recordNew && selected === 0) }
}
