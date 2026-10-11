// First-run messages over the 3D view: what's missing before the Controller can show or drive a robot, and a button to
// the place that fixes it (the Launcher, filtered to blueprints that take cmd_vel). Live: they follow Desktop's `runs`
// events (logic/runs.ts) and the bridge's state, so the message goes away as soon as a blueprint starts.
import { useEffect, useState } from "react"
import { Badge, Button, EmptyState, Row, Spinner } from "dimos-react"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"
import { type EmptyStateOptions, openApp } from "../dim-app/source/desktop.js"
import { takesVelocity } from "../logic/cmdvel.ts"

const LAUNCH_DRIVABLE = { stream: "cmd_vel" }
const LAUNCH_ARM = { stream: "joint_command" }
const REPLAY_HINT = "No robot? Turn on replay in the Launcher to drive a recorded one."
/** A lost connection is usually Desktop restarting or a network blip that heals by itself: warn only past this. */
const LOST_WARN_AFTER_MS = 8000
/** "No blueprint running" dismissed for this tab's session (a lidar alone, say): cleared once a blueprint runs. */
const NO_BLUEPRINT_DISMISSED = "lv.onboard.noBlueprintDismissed"
const readFlag = () => {
    try {
        return sessionStorage.getItem(NO_BLUEPRINT_DISMISSED) === "1"
    } catch {
        return false
    }
}
const writeFlag = (on: boolean) => {
    try {
        on ? sessionStorage.setItem(NO_BLUEPRINT_DISMISSED, "1") : sessionStorage.removeItem(NO_BLUEPRINT_DISMISSED)
    } catch {
        // storage blocked: the dismissal lasts until reload
    }
}

/** True once `on` has held for `ms` without a break. */
function useSustained(on: boolean, ms: number): boolean {
    const [sustained, setSustained] = useState(false)
    useEffect(() => {
        setSustained(false)
        if (!on) {
            return
        }
        const timer = setTimeout(() => setSustained(true), ms)
        return () => clearTimeout(timer)
    }, [on, ms])
    return on && sustained
}

/** A first-run message centered over the view (above Desktop's dock): dimos-react's EmptyState, its actions as Buttons. */
export function EmptyLayer({ title, body, label, tone, busy, actions = [], testId }: EmptyStateOptions) {
    return (
        <EmptyState
            layer
            className="first-run"
            data-testid={testId}
            icon={busy ? null : tone === "warn" ? "warn" : "robot"}
            tone={tone === "warn" ? "warn" : undefined}
            title={title}
            message={body as string}
            actions={
                <Row gap={8} justify="center" wrap>
                    {actions.map((action) => (
                        <Button
                            key={action.label}
                            size="sm"
                            variant={action.primary === false ? "default" : "primary"}
                            onClick={() => (action.onClick ? action.onClick() : action.app ? openApp(action.app, action.params) : action.href && globalThis.open(action.href, action.target ?? "_blank"))}
                        >
                            {action.label}
                        </Button>
                    ))}
                </Row>
            }
        >
            {(label || busy) && <Row gap={6} justify="center">{busy && <Spinner size={14} />}{label && <Badge tone={tone === "warn" ? "warn" : "default"}>{label}</Badge>}</Row>}
        </EmptyState>
    )
}

export type Onboarding = { message: EmptyStateOptions | null; blocksDriving: boolean }

/** Which first-run message applies now (null: none), and whether the drive bar should step aside for it. */
export function useOnboarding(app: ControllerApp): Onboarding {
    const runs = useStore(app.runs.state)
    const connection = useStore(app.connection.status)
    const [dismissed, setDismissed] = useState<string | null>(null)
    const runningKey = runs.running.join(",")
    const isArm = useStore(app.robot).type === "arm"
    const arm = useStore(app.arm.state)
    const launch = isArm ? LAUNCH_ARM : LAUNCH_DRIVABLE
    const lostAWhile = useSustained(connection.state === "lost", LOST_WARN_AFTER_MS)
    const [noBlueprintDismissed, setNoBlueprintDismissed] = useState(readFlag)
    const anyRunning = runs.running.length > 0
    useEffect(() => {
        if (anyRunning && noBlueprintDismissed) {
            writeFlag(false)
            setNoBlueprintDismissed(false)
        }
    }, [anyRunning, noBlueprintDismissed])

    if (lostAWhile) {
        return {
            blocksDriving: false,
            message: {
                testId: "onboard-bridge-lost",
                tone: "warn",
                label: "No connection",
                title: "Can't reach the robot data gateway",
                body: "Desktop or its zenoh-gateway hasn't answered for a while (restarting, or blocked on this network), so no robot data can arrive. It keeps retrying by itself.",
                actions: [
                    { label: "Try again", onClick: () => location.reload() },
                    { label: "Open Settings", app: "settings", primary: false },
                ],
            },
        }
    }
    if (!runs.known || !runs.desktop) {
        // not inside Desktop (dev server, remote robot): nothing to point at
        return { message: null, blocksDriving: false }
    }
    if (runs.dimosInstalled === false) {
        return {
            blocksDriving: true,
            message: {
                testId: "onboard-no-dimos",
                tone: "warn",
                label: "dimOS not installed",
                title: "dimOS isn't installed yet",
                body: "The Controller drives robots that a dimOS blueprint connects to. The Launcher installs dimOS (a few minutes) and then runs blueprints.",
                actions: [{ label: "Open the Launcher", app: "launcher", params: launch }],
            },
        }
    }
    if (runs.running.length === 0 && runs.starting) {
        return {
            blocksDriving: true,
            message: {
                testId: "onboard-starting",
                busy: true,
                label: "Starting",
                title: `Starting ${runs.starting}`,
                body: "This takes a few seconds; the robot shows up here when it's running.",
                actions: [{ label: "Open the Launcher", app: "launcher", primary: false }],
            },
        }
    }
    // nothing the Launcher started, but robot data is flowing: a blueprint run from a terminal (dimos run / dtk run)
    const outside = runs.running.length === 0 && connection.topics.some((topic) => !/^\/rpc\b|^\/dimos\//.test(topic.name))
    if (runs.running.length === 0 && !outside && noBlueprintDismissed) {
        // dismissed: the 3D view shows whatever topics exist; there's nothing to drive, so no key guide
        return { message: null, blocksDriving: true }
    }
    if (runs.running.length === 0 && !outside) {
        return {
            blocksDriving: true,
            message: {
                testId: "onboard-no-blueprint",
                label: "No blueprint running",
                title: isArm ? "You need to launch an arm blueprint before you can move an arm" : "You need to launch a blueprint with a cmd_vel topic before you can control a robot",
                body: isArm
                    ? "A blueprint is the software that connects to a robot. No arm? coordinator-mock or keyboard-teleop-xarm7 run a simulated one."
                    : `A blueprint is the software that connects to a robot. ${REPLAY_HINT}`,
                actions: [
                    { label: "Open the Launcher", app: "launcher", params: launch },
                    { label: "Dismiss", onClick: () => (writeFlag(true), setNoBlueprintDismissed(true)), primary: false },
                ],
            },
        }
    }
    const names = runs.running.join(", ")
    // an arm, and nothing running takes an arm command (joint_command, ee_twist_command, gripper_command)
    const armInputs = arm.topics.jointCommand || arm.topics.eeTwist || arm.topics.grippers.length
    if (isArm && arm.topics.fromMetadata && !armInputs && dismissed !== runningKey) {
        return {
            blocksDriving: true,
            message: {
                testId: "onboard-no-arm-input",
                tone: "warn",
                label: "Nothing to move",
                title: `${names} has no arm command input, so the arm panel won't move anything`,
                body: "None of its modules takes joint_command, ee_twist_command or gripper_command (dimos's ControlCoordinator does). You can still look at its topics here.",
                actions: [
                    { label: "Open the Launcher", app: "launcher", params: LAUNCH_ARM },
                    { label: "Just view", onClick: () => setDismissed(runningKey), primary: false },
                ],
            },
        }
    }
    // no module of the running blueprints takes a velocity command (an input named *cmd_vel*): driving moves nothing
    if (!isArm && takesVelocity(runs.blueprints) === false && dismissed !== runningKey) {
        return {
            blocksDriving: true,
            message: {
                testId: "onboard-no-cmd-vel",
                tone: "warn",
                label: "Nothing to drive",
                title: `${names} has no cmd_vel input, so driving won't do anything`,
                body: "None of its modules takes velocity commands (an input like cmd_vel or tele_cmd_vel). You can still look at its topics here. To drive, launch a blueprint that takes cmd_vel.",
                actions: [
                    { label: "Open the Launcher", app: "launcher", params: LAUNCH_DRIVABLE },
                    { label: "Just view", onClick: () => setDismissed(runningKey), primary: false },
                ],
            },
        }
    }
    if (connection.topics.length === 0) {
        return {
            blocksDriving: false,
            message: {
                testId: "onboard-waiting-topics",
                busy: true,
                label: "Waiting for data",
                title: `Waiting for ${names}'s topics`,
                body: "They appear a few seconds after a blueprint starts. If nothing comes, its log in the Launcher says why.",
                actions: [{ label: "Open the Launcher", app: "launcher", primary: false }],
            },
        }
    }
    return { message: null, blocksDriving: false }
}
