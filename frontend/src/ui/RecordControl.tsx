// Recording, floating at the top left of the view (a panel opens below it): a red Record button (while recording: "Stop recording", its time, size and stream count) and "…", which opens
// the options: the folder, the biggest streams by live bandwidth (each can be left out), See recordings, and an
// Advanced section (image format, chunk compression, new topics, dimos logs, every stream with its rate and a max
// rate). Every topic is recorded unless turned off; the options are saved in the backend (lv.record.options).
import { useEffect, useRef, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { persistentStore, useStore } from "../core/store.ts"
import { recorder, type Compression, type ImageFormat, type StreamRate } from "../core/recorder.ts"
import { biggestStreams, formatBytes, formatClock, formatRate, inRecordingsFolder, isRecorded, isRpcTopic, TOP_STREAMS } from "../core/recordFormat.ts"
import type { Topic } from "../core/transport.ts"
import { Field, Select, Toggle } from "./controls.tsx"
import { Icon } from "./icons.tsx"
import { appInstalled, openApp, underDesktop } from "../dim-app/source/desktop.js"

/** topic key → recorded or not; a topic not in it is recorded (so new ones are too) */
export const recordedTopics = persistentStore<Record<string, boolean>>("lv.record.topics", {})
export function RecordControl({ app }: { app: ViewerApp }) {
    const status = useStore(recorder.status)
    const pending = useStore(recorder.pending)
    const { topics } = useStore(app.connection.status)
    const chosen = useStore(recordedTopics)
    const [open, setOpen] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const active = status.recording.active
    const selected = topics.filter((topic) => isRecorded(topic.key, chosen))
    const busy = pending.action !== null

    // a hash link (#record, as other apps open it with) opens the options
    useEffect(() => {
        if (location.hash === "#record") {
            setOpen(true)
        }
    }, [])

    const toggle = () => {
        setError(null)
        const work = active ? recorder.stop() : recorder.start(status.options.recordNew ? null : selected.map((topic) => topic.key))
        work.catch((problem) => setError(String(problem.message ?? problem)))
    }
    const label = busy
        ? (pending.action === "start" ? "Starting…" : "Stopping…")
        : active
        ? `Stop recording (${formatClock(status.recording.seconds)}, ${formatBytes(status.recording.bytes)}, ${status.keys.length} streams)`
        : status.options.recordNew
        ? `Record every stream${topics.length - selected.length ? ` but ${topics.length - selected.length} turned off` : ""}; new ones join`
        : `Record ${selected.length} streams`

    // the options are the button's sibling, not its child: the button's frosted glass would pin a fixed child to itself
    return (
        <>
            <div className={`dim-panel glass record-control ${active ? "recording" : ""}`} data-testid="record-control">
                {/* one split button: Record │ … */}
                <div className="record-split">
                    <button
                        type="button"
                        className={`dim-btn sm record-toggle ${active ? "danger recording" : ""}`}
                        aria-pressed={active}
                        title={status.unavailable ?? (error ? `${label}: ${error}` : label)}
                        aria-label={label}
                        // with new streams joining, a recording can start before anything is on the bus: they join as they appear
                        disabled={busy || !!status.unavailable || (!active && !status.options.recordNew && !selected.length)}
                        onClick={toggle}
                    >
                        <span className="record-dot" />
                        {active
                            ? (
                                <span className="record-live" data-testid="record-live">
                                    <span className="record-label">{busy ? "Stopping…" : "Stop recording"}</span>
                                    <span className="record-clock dim-mono">{formatClock(status.recording.seconds)}</span>
                                    <span className="record-extra dim-mono">· {formatBytes(status.recording.bytes)} · {status.keys.length} streams</span>
                                </span>
                            )
                            : <span className="record-label">{busy ? "Starting…" : "Record"}</span>}
                    </button>
                    <button
                        type="button"
                        className={`dim-btn sm icon record-more ${open ? "on" : ""}`}
                        aria-haspopup="dialog"
                        aria-expanded={open}
                        title="Recording options"
                        aria-label="Recording options"
                        onClick={() => setOpen(!open)}
                    >
                        {/* the shared set's dots are hairline at this size: solid ones */}
                        <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
                            {[5, 12, 19].map((x) => <rect key={x} x={x - 2} y={10} width={4} height={4} rx={2} fill="currentColor" />)}
                        </svg>
                    </button>
                </div>
                {error && !open && <span className="dim-badge danger record-error" title={error}>failed</span>}
            </div>
            {open && <RecordOptions app={app} error={error} onClose={() => setOpen(false)} />}
        </>
    )
}

function RecordOptions({ app, error, onClose }: { app: ViewerApp; error: string | null; onClose: () => void }) {
    const status = useStore(recorder.status)
    const streams = useStore(recorder.streams)
    const { topics } = useStore(app.connection.status)
    const chosen = useStore(recordedTopics)
    const [advanced, setAdvanced] = useState(() => {
        try {
            return localStorage.getItem("controller.record.advanced") === "1"
        } catch {
            return false
        }
    })
    const [problem, setProblem] = useState<string | null>(null)
    const [recordings, setRecordings] = useState<"checking" | "installed" | "missing" | "outside">("checking")
    const panel = useRef<HTMLDivElement>(null)
    useEffect(() => recorder.watch(), [])
    useEffect(() => recorder.watchStreams(), [])
    useEffect(() => {
        if (!underDesktop()) {
            setRecordings("outside")
            return
        }
        appInstalled("dim-recordings").then((installed) => setRecordings(installed ? "installed" : "missing"))
    }, [])
    // clicks outside (but not on the "…" that toggles it) and Escape close it
    useEffect(() => {
        const away = (event: PointerEvent) => {
            const target = event.target as Element
            if (!panel.current?.contains(target) && !target.closest?.(".record-control")) {
                onClose()
            }
        }
        const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose()
        addEventListener("pointerdown", away)
        addEventListener("keydown", escape)
        return () => {
            removeEventListener("pointerdown", away)
            removeEventListener("keydown", escape)
        }
    }, [onClose])

    const active = status.recording.active
    const options = status.options
    const run = (work: Promise<unknown>) => work.then(() => setProblem(null)).catch((failure) => setProblem(String(failure.message ?? failure)))
    const setAdvancedOpen = (value: boolean) => {
        setAdvanced(value)
        try {
            localStorage.setItem("controller.record.advanced", value ? "1" : "0")
        } catch {
            // private window: it just isn't remembered
        }
    }
    const rateOf = new Map(streams.list.map((stream) => [stream.key, stream]))
    // the biggest streams, ranked once and then held in place while this is open, so a switch doesn't move under the
    // pointer as rates change (new ones fill free places; the numbers stay live)
    const [topKeys, setTopKeys] = useState<string[]>([])
    useEffect(() => {
        if (streams.seconds < 2) {
            return
        }
        const ranked = biggestStreams(streams.list).map((stream) => stream.key).filter((key) => !topKeys.includes(key))
        if (topKeys.length < TOP_STREAMS && ranked.length) {
            setTopKeys([...topKeys, ...ranked].slice(0, TOP_STREAMS))
        }
    }, [streams, topKeys])
    const top = topKeys.map((key) => {
        const stream = streams.list.find((other) => other.key === key)
        const topic = topics.find((other) => other.key === key)
        return stream ?? { key, topic: topic?.name ?? key, type: topic?.type ?? "", bytesPerSecond: 0, messagesPerSecond: 0, recorded: true, maxRate: null }
    })
    const recordedRate = streams.list.filter((stream) => isRecorded(stream.key, chosen)).reduce((sum, stream) => sum + stream.bytesPerSecond, 0)
    const known = new Set(topics.map((topic) => topic.key))
    // every stream: the bridge's topics plus anything the meter heard that the bridge hasn't announced
    const all: Topic[] = [
        ...topics,
        ...streams.list.filter((stream) => !known.has(stream.key)).map((stream) => ({ key: stream.key, name: stream.topic, type: stream.type })),
    ].sort((a, b) => (rateOf.get(b.key)?.bytesPerSecond ?? 0) - (rateOf.get(a.key)?.bytesPerSecond ?? 0) || a.name.localeCompare(b.name))
    const recordedCount = all.filter((topic) => isRecorded(topic.key, chosen)).length
    const outside = !inRecordingsFolder(status.directory, status.recordings_root)

    return (
        <div ref={panel} className="dim-panel glass record-options" role="dialog" aria-label="Recording options" data-testid="record-options">
            <div className="record-options-head">
                <h2 className="dim-card-title">Recording</h2>
                <button type="button" className="dim-btn icon icon-button" title="Close" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
            </div>
            {status.unavailable === "connecting…" && <p className="hint">connecting to the recorder…</p>}
            {status.unavailable && status.unavailable !== "connecting…" && (
                <div className="dim-alert warn" data-testid="onboard-recorder-down">
                    <div>
                        <div className="dim-alert-title">Recording isn't available</div>
                        The Controller's server isn't answering. Closing the Controller (✕) and opening it again restarts it.
                        <div className="hint">{status.unavailable}</div>
                        <button type="button" className="dim-btn sm" onClick={() => recorder.refresh()}>Try again</button>
                    </div>
                </div>
            )}
            {!status.unavailable && !all.length && (
                <div className="dim-alert" data-testid="onboard-nothing-to-record">
                    <div>
                        <div className="dim-alert-title">Nothing to record yet</div>
                        Launch a blueprint (or a replay) and its topics show up here to record.
                        <div>
                            <button type="button" className="dim-btn sm" onClick={() => openApp("launcher")}>Open the Launcher</button>
                        </div>
                    </div>
                </div>
            )}
            {active && (
                <div className="record-now" data-testid="record-now">
                    <span className="dim-badge danger solid"><span className="dot" /> REC {formatClock(status.recording.seconds)}</span>
                    <span className="dim-mono">{formatBytes(status.recording.bytes)} · {status.keys.length} streams · {status.recording.messages.toLocaleString()} msgs</span>
                    <span className="hint record-path" title={status.recording.path ?? ""}>{status.recording.path}</span>
                    {status.recording.dropped > 0 && <span className="problem">{status.recording.dropped.toLocaleString()} dropped: the disk can't keep up</span>}
                    {status.recording.skipped > 0 && <span className="hint">{status.recording.skipped.toLocaleString()} left out by max rates</span>}
                    {options.logs && <span className="hint">{status.logs.dirs.length ? `${status.logs.lines.toLocaleString()} dimos log lines` : "no dimos run logs found"}</span>}
                </div>
            )}
            {(error || problem) && <p className="problem">{error ?? problem}</p>}

            <div className="field-block">
                <span className="field-label">Folder</span>
                <div className="record-folder">
                    <input
                        className="dim-input dim-mono"
                        aria-label="Recording folder"
                        defaultValue={status.directory}
                        key={status.directory}
                        disabled={active}
                        title={active ? "The folder can change once this recording ends" : status.directory}
                        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
                        onBlur={(event) => event.target.value.trim() !== status.directory && run(recorder.settings({ directory: event.target.value }))}
                    />
                    {options.directory && (
                        <button type="button" className="dim-btn sm" disabled={active} title={status.default_directory} onClick={() => run(recorder.settings({ directory: "" }))}>Default</button>
                    )}
                </div>
                <p className={`hint ${outside ? "warn-text" : ""}`}>
                    {outside ? "Outside Desktop's recordings folder: the Recordings app won't list these." : options.directory ? "Inside Desktop's recordings folder." : "Desktop's recordings folder (the Recordings app lists it)."}
                </p>
            </div>

            <h3 className="dim-label">Biggest streams</h3>
            <div className="top-streams" data-testid="top-streams">
                {top.map((stream) => (
                    <div key={stream.key} className="stream-row">
                        <Toggle value={isRecorded(stream.key, chosen)} onChange={(value) => recordedTopics.update({ [stream.key]: value })} />
                        <span className="topic-name" title={`${stream.key}`}>{stream.topic}</span>
                        <span className="stream-rate dim-mono">{formatRate(stream.bytesPerSecond)}</span>
                    </div>
                ))}
                {!top.length && <p className="empty">{streams.error ? `can't measure: ${streams.error}` : streams.seconds < 2 ? "measuring…" : "nothing is sending"}</p>}
            </div>
            <p className="hint" data-testid="record-summary">
                Recording {recordedCount} of {all.length} streams{recordedRate > 0 ? ` · about ${formatRate(recordedRate)}` : ""}
                {active && !options.recordNew ? "" : " · new ones join"}
            </p>

            <div className="button-row">
                {recordings === "missing"
                    ? <button type="button" className="dim-btn sm" onClick={() => openApp("appstore")}><Icon name="download" size={14} /> Install Recordings from the App Store</button>
                    : (
                        <button type="button" className="dim-btn sm" disabled={recordings === "outside"} title={recordings === "outside" ? "Open the Controller inside dimOS Desktop to open Recordings" : "Open the Recordings app"} onClick={() => openApp("dim-recordings")}>
                            <Icon name="folder" size={14} /> See recordings
                        </button>
                    )}
            </div>

            <button type="button" className="advanced-toggle" aria-expanded={advanced} onClick={() => setAdvancedOpen(!advanced)}>
                <Icon name="chevron-right" size={14} />
                Advanced
            </button>
            {advanced && (
                <div className="record-advanced" data-testid="record-advanced">
                    <Field label="Images" hint={active ? "can change once this recording ends" : "how camera images are stored"}>
                        <Select
                            value={options.image_format}
                            options={[["raw", "raw (exact)"], ["png", "png (lossless)"], ["jpegxl", "jpeg xl (lossless)"], ["webp", "webp"], ["jpeg", "jpeg"]]}
                            onChange={(image_format) => run(recorder.settings({ image_format: image_format as ImageFormat }))}
                        />
                    </Field>
                    <Field label="Chunks" hint="mcap chunk compression; uncompressed survives a hard kill best">
                        <Select value={options.compression} options={[["none", "uncompressed"], ["lz4", "lz4"], ["zstd", "zstd"]]} onChange={(compression) => run(recorder.settings({ compression: compression as Compression }))} />
                    </Field>
                    <Field label="New topics"><Toggle value={options.recordNew} onChange={(recordNew) => run(recorder.settings({ recordNew }))} label="join a running recording" /></Field>
                    <Field label="dimos logs"><Toggle value={options.logs} onChange={(logs) => run(recorder.settings({ logs }))} label="record the running dimos's logs" /></Field>
                    <div className="all-streams-head">
                        <span className="dim-label">All streams · {recordedCount} of {all.length}</span>
                        <span className="all-streams-actions">
                            <button type="button" className="link" onClick={() => recordedTopics.update(Object.fromEntries(all.map((topic) => [topic.key, true])))}>all</button>
                            <button type="button" className="link" onClick={() => recordedTopics.update(Object.fromEntries(all.map((topic) => [topic.key, false])))}>none</button>
                        </span>
                    </div>
                    <div className="record-topics" data-testid="all-streams">
                        <div className="record-topic legend">
                            <span />
                            <span>topic</span>
                            <span className="stream-rate">now</span>
                            <span className="max-rate" title="At most this many messages per second are recorded; empty = every message">max Hz</span>
                        </div>
                        {all.map((topic) => <StreamRow key={topic.key} topic={topic} rate={rateOf.get(topic.key)} chosen={chosen} maxRate={options.rates[topic.key]} onRate={(hz) => run(recorder.settings({ rates: { [topic.key]: hz } }))} />)}
                    </div>
                </div>
            )}
        </div>
    )
}

function StreamRow({ topic, rate, chosen, maxRate, onRate }: { topic: Topic; rate: StreamRate | undefined; chosen: Record<string, boolean>; maxRate: number | undefined; onRate: (hz: number | null) => void }) {
    const on = isRecorded(topic.key, chosen)
    return (
        <div className={`record-topic ${on ? "" : "off"} ${isRpcTopic(topic) ? "rpc" : ""}`}>
            <input type="checkbox" aria-label={`Record ${topic.name}`} checked={on} onChange={(event) => recordedTopics.update({ [topic.key]: event.target.checked })} />
            <span className="topic-name" title={`${topic.key}`}>
                {topic.name}
                <span className="topic-type"> {topic.type.split(".")[1]}</span>
            </span>
            <span className="stream-rate dim-mono" title={rate ? `${rate.messagesPerSecond} msg/s` : "quiet"}>{rate ? formatRate(rate.bytesPerSecond) : "–"}</span>
            <input
                type="number"
                className="dim-input number max-rate"
                aria-label={`Max messages per second for ${topic.name}`}
                min={0}
                step={1}
                placeholder="all"
                defaultValue={maxRate ?? ""}
                key={maxRate ?? "none"}
                onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
                onBlur={(event) => {
                    const value = event.target.value === "" ? null : Number(event.target.value)
                    if ((value || null) !== (maxRate ?? null)) {
                        onRate(value && value > 0 ? value : null)
                    }
                }}
            />
        </div>
    )
}
