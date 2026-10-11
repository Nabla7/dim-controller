// The bottom-left key guide for an arm: the end-effector keys lighting up as they're held, the gripper keys, and
// what's being sent. On a phone: STOP (jogging is the arm panel's hold buttons). No arming.
import { Button, KeyPad, Panel, Text } from "dimos-react"
import type { ControllerApp } from "../logic/controller.ts"
import { useStore } from "../logic/settings.ts"
import type { EeAxis } from "../profile/types.ts"

export function ArmHud({ app, mobile }: { app: ControllerApp; mobile: boolean }) {
    const state = useStore(app.arm.state)
    const keys = app.profile.arm?.keys ?? {}
    const keyFor = (axis: EeAxis, sign: number) => Object.entries(keys).find(([, action]) => "ee" in action && action.ee === axis && Math.sign(action.value) === sign)?.[0].replace(/^Key/, "")
    const cell = (axis: EeAxis, sign: number) => {
        const key = keyFor(axis, sign)
        return key ? { label: key, down: Math.sign(state.ee[axis]) === sign && state.ee[axis] !== 0, title: `${axis} ${sign > 0 ? "+" : "−"}` } : null
    }
    const activity = state.jogging
        ? `jog ${state.jogging.joint.replace(/^.*\//, "")} ${state.jogging.sign > 0 ? "+" : "−"}`
        : Object.entries(state.ee).filter(([, value]) => value).map(([axis, value]) => `${axis}${value > 0 ? "+" : "−"}`).join(" ")
    if (mobile) {
        return (
            <div className="drive-hud-mobile arm-hud">
                <div className="hud-center">
                    <Button variant="danger" size="lg" className="stop-button" onClick={() => app.arm.stop()}>STOP</Button>
                </div>
            </div>
        )
    }
    return (
        <Panel glass className="drive-hud arm-hud" data-testid="arm-hud">
            <div className="drive-hud-row">
                {state.topics.eeTwist && (
                    <KeyPad
                        aria-label="end-effector keys"
                        rows={[
                            [cell("z", 1), cell("x", 1), cell("z", -1), cell("roll", 1), cell("pitch", 1), cell("yaw", 1)],
                            [cell("y", 1), cell("x", -1), cell("y", -1), cell("roll", -1), cell("pitch", -1), cell("yaw", -1)],
                        ]}
                    />
                )}
                {state.topics.grippers.length > 0 && <KeyPad aria-label="gripper keys" rows={[[{ label: "[", title: "open the gripper" }], [{ label: "]", title: "close the gripper" }]]} />}
                <div className="hud-readout" data-testid="arm-hud-readout">
                    <Text small>{activity || "hold a key or a jog button"}</Text>
                    <Text small muted mono title={[state.topics.eeTwist, state.topics.jointCommand, ...state.topics.grippers].filter(Boolean).join(", ")}>
                        {state.topics.jointCommand || state.topics.eeTwist || state.topics.grippers.length ? `sent ${state.sent}` : "no arm inputs running"}
                    </Text>
                </div>
            </div>
        </Panel>
    )
}
