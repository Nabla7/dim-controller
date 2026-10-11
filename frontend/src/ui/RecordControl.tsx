// Recording, floating at the top left of the view (a panel opens below it): a red Record button (while recording: "Stop recording", its time, size and stream count) and "…", which opens
// the options: the folder, the biggest streams by live bandwidth (each can be left out), See recordings, and an
// Advanced section (image format, chunk compression, new topics, dimos logs, every stream with its rate and a max
// rate). Every topic is recorded unless turned off; the options are saved in the backend (lv.record.options).
import { useEffect, useRef, useState } from "react"
import { Alert, Badge, Button, ButtonGroup, Checkbox, Field, Heading, IconButton, NumberInput, Panel, Row, Select, Text, TextInput, Toggle } from "dimos-react"
import type { ControllerApp } from "../logic/controller.ts"
import { persistentStore, useStore } from "../logic/settings.ts"
import { type Compression, type ImageFormat, recorder, type StreamRate } from "../logic/recorder.ts"
import { biggestStreams, formatBytes, formatClock, formatRate, inRecordingsFolder, isRecorded, isRpcTopic, TOP_STREAMS } from "../logic/recordFormat.ts"
import type { Topic } from "../logic/connection.ts"
import { appInstalled, openApp, underDesktop } from "../dim-app/source/desktop.js"

/** topic key → recorded or not; a topic not in it is recorded (so new ones are too) */
export const recordedTopics = persistentStore<Record<string, boolean>>("lv.record.topics", {})
export function RecordControl({ app }: { app: ControllerApp }) {
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

    return (
        <>
            <div className={`record-control ${active ? "recording" : ""}`} data-testid="record-control">
                <ButtonGroup>
                    <Button
                        size="sm"
                        variant={active ? "danger" : "default"}
                        className="record-toggle"
                        icon="record"
                        pressed={active}
                        title={status.unavailable ?? (error ? `${label}: ${error}` : label)}
                        aria-label={label}
                        // with new streams joining, a recording can start before anything is on the bus: they join as they appear
                        disabled={busy || !!status.unavailable || (!active && !status.options.recordNew && !selected.length)}
                        onClick={toggle}
                    >
                        {active
                            ? (
                                <span data-testid="record-live">
                                    {busy ? "Stopping…" : "Stop recording"} <Text mono>{formatClock(status.recording.seconds)}</Text>{" "}
                                    <Text mono muted className="record-extra">· {formatBytes(status.recording.bytes)} · {status.keys.length} streams</Text>
                                </span>
                            )
                            : busy ? "Starting…" : "Record"}
                    </Button>
                    <IconButton size="sm" variant="default" icon="more-horizontal" label="Recording options" pressed={open} aria-haspopup="dialog" aria-expanded={open} className="record-more" onClick={() => setOpen(!open)} />
                </ButtonGroup>
                {error && !open && <Badge tone="danger" title={error}>failed</Badge>}
            </div>
            {open && <RecordOptions app={app} error={error} onClose={() => setOpen(false)} />}
        </>
    )
}

function RecordOptions({ app, error, onClose }: { app: ControllerApp; error: string | null; onClose: () => void }) {
    const status = useStore(recorder.status)
    const streams = useStore(recorder.streams)
    const { topics } = useStore(app.connection.status)
    const chosen = useStore(recordedTopics)
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
        <div ref={panel} className="record-options" role="dialog" aria-label="Recording options" data-testid="record-options">
            <Panel glass title="Recording" actions={<IconButton icon="close" label="Close" onClick={onClose} />}>
                {status.unavailable === "connecting…" && <Text small muted>connecting to the recorder…</Text>}
                {status.unavailable && status.unavailable !== "connecting…" && (
                    <Alert tone="warn" title="Recording isn't available" data-testid="onboard-recorder-down" actions={<Button size="sm" onClick={() => recorder.refresh()}>Try again</Button>}>
                        The Controller's server isn't answering. Closing the Controller (✕) and opening it again restarts it.
                        <Text as="div" small muted>{status.unavailable}</Text>
                    </Alert>
                )}
                {!status.unavailable && !all.length && (
                    <Alert title="Nothing to record yet" data-testid="onboard-nothing-to-record" actions={<Button size="sm" onClick={() => openApp("launcher")}>Open the Launcher</Button>}>
                        Launch a blueprint (or a replay) and its topics show up here to record.
                    </Alert>
                )}
                {active && (
                    <Row gap={8} wrap data-testid="record-now">
                        <Badge tone="danger" solid dot>REC {formatClock(status.recording.seconds)}</Badge>
                        <Text mono small>{formatBytes(status.recording.bytes)} · {status.keys.length} streams · {status.recording.messages.toLocaleString()} msgs</Text>
                        <Text small muted className="record-path" title={status.recording.path ?? ""}>{status.recording.path}</Text>
                        {status.recording.dropped > 0 && <Text small tone="danger">{status.recording.dropped.toLocaleString()} dropped: the disk can't keep up</Text>}
                        {status.recording.skipped > 0 && <Text small muted>{status.recording.skipped.toLocaleString()} left out by max rates</Text>}
                        {options.logs && <Text small muted>{status.logs.dirs.length ? `${status.logs.lines.toLocaleString()} dimos log lines` : "no dimos run logs found"}</Text>}
                    </Row>
                )}
                {(error || problem) && <Alert tone="danger">{error ?? problem}</Alert>}

                <Field
                    label="Folder"
                    hint={outside ? "Outside Desktop's recordings folder: the Recordings app won't list these." : options.directory ? "Inside Desktop's recordings folder." : "Desktop's recordings folder (the Recordings app lists it)."}
                    error={undefined}
                >
                    <Row gap={6}>
                        <FolderInput directory={status.directory} disabled={active} onCommit={(directory) => run(recorder.settings({ directory }))} />
                        {options.directory && <Button size="sm" disabled={active} title={status.default_directory} onClick={() => run(recorder.settings({ directory: "" }))}>Default</Button>}
                    </Row>
                </Field>

                <Heading level={3}>Biggest streams</Heading>
                <div className="top-streams" data-testid="top-streams">
                    {top.map((stream) => (
                        <Row key={stream.key} gap={8} className="stream-row">
                            <Toggle size="sm" value={isRecorded(stream.key, chosen)} onChange={(value: boolean) => recordedTopics.update({ [stream.key]: value })} />
                            <Text small className="topic-name" title={stream.key}>{stream.topic}</Text>
                            <Text small mono muted>{formatRate(stream.bytesPerSecond)}</Text>
                        </Row>
                    ))}
                    {!top.length && <Text small muted>{streams.error ? `can't measure: ${streams.error}` : streams.seconds < 2 ? "measuring…" : "nothing is sending"}</Text>}
                </div>
                <Text as="p" small muted data-testid="record-summary">
                    Recording {recordedCount} of {all.length} streams{recordedRate > 0 ? ` · about ${formatRate(recordedRate)}` : ""}
                    {active && !options.recordNew ? "" : " · new ones join"}
                </Text>

                <Row gap={6}>
                    {recordings === "missing"
                        ? <Button size="sm" icon="download" onClick={() => openApp("appstore")}>Install Recordings from the App Store</Button>
                        : (
                            <Button size="sm" icon="folder" disabled={recordings === "outside"} title={recordings === "outside" ? "Open the Controller inside dimOS Desktop to open Recordings" : "Open the Recordings app"} onClick={() => openApp("dim-recordings")}>
                                See recordings
                            </Button>
                        )}
                </Row>

                <Panel collapsible defaultOpen={false} persistKey="controller.record.advanced" title="Advanced" className="record-advanced" data-testid="record-advanced">
                    <Field label="Images" hint={active ? "can change once this recording ends" : "how camera images are stored"}>
                        <Select
                            size="sm"
                            value={options.image_format}
                            options={[["raw", "raw (exact)"], ["png", "png (lossless)"], ["jpegxl", "jpeg xl (lossless)"], ["webp", "webp"], ["jpeg", "jpeg"]]}
                            onChange={(image_format: string) => run(recorder.settings({ image_format: image_format as ImageFormat }))}
                        />
                    </Field>
                    <Field label="Chunks" hint="mcap chunk compression; uncompressed survives a hard kill best">
                        <Select size="sm" value={options.compression} options={[["none", "uncompressed"], ["lz4", "lz4"], ["zstd", "zstd"]]} onChange={(compression: string) => run(recorder.settings({ compression: compression as Compression }))} />
                    </Field>
                    <Field label="New topics"><Toggle size="sm" value={options.recordNew} onChange={(recordNew: boolean) => run(recorder.settings({ recordNew }))} label="join a running recording" /></Field>
                    <Field label="dimos logs"><Toggle size="sm" value={options.logs} onChange={(logs: boolean) => run(recorder.settings({ logs }))} label="record the running dimos's logs" /></Field>
                    <Row gap={6} justify="space-between">
                        <Heading level={3}>All streams · {recordedCount} of {all.length}</Heading>
                        <Row gap={4}>
                            <Button size="sm" variant="ghost" onClick={() => recordedTopics.update(Object.fromEntries(all.map((topic) => [topic.key, true])))}>all</Button>
                            <Button size="sm" variant="ghost" onClick={() => recordedTopics.update(Object.fromEntries(all.map((topic) => [topic.key, false])))}>none</Button>
                        </Row>
                    </Row>
                    <div className="record-topics" data-testid="all-streams">
                        <div className="record-topic legend">
                            <span />
                            <Text small muted>topic</Text>
                            <Text small muted>now</Text>
                            <Text small muted title="At most this many messages per second are recorded; empty = every message">max Hz</Text>
                        </div>
                        {all.map((topic) => <StreamRow key={topic.key} topic={topic} rate={rateOf.get(topic.key)} chosen={chosen} maxRate={options.rates[topic.key]} onRate={(hz) => run(recorder.settings({ rates: { [topic.key]: hz } }))} />)}
                    </div>
                </Panel>
            </Panel>
        </div>
    )
}

/** The recording folder: typed freely, saved on Enter or leaving the field. */
function FolderInput({ directory, disabled, onCommit }: { directory: string; disabled: boolean; onCommit: (directory: string) => void }) {
    const [text, setText] = useState(directory)
    useEffect(() => setText(directory), [directory])
    const commit = () => text.trim() !== directory && onCommit(text)
    return (
        <TextInput
            mono
            size="sm"
            aria-label="Recording folder"
            value={text}
            disabled={disabled}
            title={disabled ? "The folder can change once this recording ends" : directory}
            onChange={setText}
            onEnter={commit}
            onBlur={commit}
        />
    )
}

function StreamRow({ topic, rate, chosen, maxRate, onRate }: { topic: Topic; rate: StreamRate | undefined; chosen: Record<string, boolean>; maxRate: number | undefined; onRate: (hz: number | null) => void }) {
    const on = isRecorded(topic.key, chosen)
    return (
        <div className={`record-topic ${on ? "" : "off"} ${isRpcTopic(topic) ? "rpc" : ""}`}>
            <Checkbox aria-label={`Record ${topic.name}`} value={on} onChange={(value: boolean) => recordedTopics.update({ [topic.key]: value })} />
            <Text small className="topic-name" title={topic.key}>
                {topic.name}
                <Text muted> {topic.type.split(".")[1]}</Text>
            </Text>
            <Text small mono muted title={rate ? `${rate.messagesPerSecond} msg/s` : "quiet"}>{rate ? formatRate(rate.bytesPerSecond) : "–"}</Text>
            <MaxRate topic={topic} maxRate={maxRate} onRate={onRate} />
        </div>
    )
}

/** Max messages a second: a number, or empty for every message (cleared with the ✕). */
function MaxRate({ topic, maxRate, onRate }: { topic: Topic; maxRate: number | undefined; onRate: (hz: number | null) => void }) {
    return (
        <Row gap={2}>
            <NumberInput size="sm" className="max-rate" aria-label={`Max messages per second for ${topic.name}`} min={0} step={1} placeholder="all" value={maxRate ?? null} onChange={(value: number) => onRate(value > 0 ? value : null)} />
            {maxRate ? <IconButton size="sm" icon="close" label="Every message" onClick={() => onRate(null)} /> : null}
        </Row>
    )
}
