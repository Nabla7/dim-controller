// The Tiles layout's status tile: the link, the robot, driving and rendering at a glance (each also lives elsewhere: the
// top bar, Settings, the drive keys, Settings → Stats). Read-only.
import { KeyValue, KeyValueRow, Row, Text } from "dimos-react"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"
import { profiles } from "../profile/index.ts"
import { RobotIcon } from "./RobotIcon.tsx"
import { useSceneStats, useTfIssues } from "./sceneState.tsx"

export function StatusPanel({ app }: { app: ControllerApp }) {
    const connection = useStore(app.connection.status)
    const stats = useSceneStats(app)
    const robot = useStore(app.robot)
    const drive = useStore(app.drive.state)
    const issues = useTfIssues(app)
    const ms = (value: number | null) => value === null ? "–" : `${Math.round(value)} ms`
    const live = connection.state === "connected"
    const driving = drive.halt
        ? { text: drive.halt.reason === "lost" ? "held: link lost" : `held: latency over ${drive.halt.maxMs} ms`, tone: "danger" }
        : drive.publishing
        ? { text: `sending · ${drive.sent}`, tone: "ok" }
        : { text: "idle", tone: undefined }
    const rows: [string, string, string | undefined][] = [
        ["Link", live ? `${connection.topics.length} topics` : connection.state === "lost" ? "no gateway" : connection.state, live ? "ok" : "warn"],
        ["Round trip", ms(connection.rttMs), undefined],
        ["Dropped", `${connection.droppedPerSecond}/s`, connection.droppedPerSecond > 0 ? "warn" : undefined],
        ["Drive", driving.text, driving.tone],
        ["Drive topic", drive.topic || "nothing", drive.topic ? undefined : "warn"],
        ["Render", `${stats.fps} fps · ${stats.points.toLocaleString()} pts`, undefined],
        ["Latency", `p50 ${ms(stats.latencyP50)} · p95 ${ms(stats.latencyP95)}`, undefined],
        ["TF", issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}: ${issues[0].summary}` : "ok", issues.length ? "warn" : "ok"],
    ]
    return (
        <div className="status-panel" data-testid="status-panel">
            <Row gap={8}>
                <RobotIcon type={robot.type} size={32} />
                <Text>{profiles.find((profile) => profile.type === robot.type)?.name ?? robot.type}{robot.auto ? " (auto)" : ""}</Text>
            </Row>
            <KeyValue>
                {rows.map(([label, value, tone]) => (
                    <KeyValueRow key={label} label={label}>
                        <Text tone={tone} title={value}>{value}</Text>
                    </KeyValueRow>
                ))}
            </KeyValue>
        </div>
    )
}
