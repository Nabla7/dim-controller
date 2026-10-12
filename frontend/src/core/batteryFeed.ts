// Low battery → a Desktop notification: every sensor_msgs.BatteryState topic on the bridge, once per dip to 20 %
// (re-armed above 25 %), with the "battery" sound. Outside Desktop notify() does nothing.
import { decode, type LcmValue } from "./lcm/lcm.ts"
import type { Connection } from "./transport.ts"
import { lowLevelAlert, notify, type Notification } from "../dim-app/source/notify.js"

export const LOW_BATTERY_PERCENT = 20

/** A BatteryState's charge in percent (ROS says 0..1; some publishers send 0..100), or null when it has none. */
export function batteryPercent(state: LcmValue): number | null {
    const raw = Number(state?.percentage)
    if (Number.isFinite(raw) && raw >= 0) {
        return raw <= 1 ? raw * 100 : Math.min(raw, 100)
    }
    const charge = Number(state?.charge)
    const capacity = Number(state?.capacity)
    if (Number.isFinite(charge) && Number.isFinite(capacity) && capacity > 0) {
        return Math.max(0, Math.min(100, (charge / capacity) * 100))
    }
    return null
}

/** One topic's alert: feed it decoded BatteryStates. */
export function batteryAlert(robot: string, topic: string, send: (notification: Notification) => unknown = notify) {
    const alert = lowLevelAlert({
        low: LOW_BATTERY_PERCENT,
        hysteresis: 5,
        send,
        notification: (percent: number) => ({
            title: "Battery low",
            body: `${robot} at ${Math.round(percent)}% (${topic})`,
            kind: "warn",
            sound: "battery",
            details: { robot, topic, percent },
        }),
    })
    return (state: LcmValue) => alert(batteryPercent(state))
}

export function feedBattery(connection: Connection, robotName: () => string) {
    const subscribed = new Set<string>()
    const sync = () => {
        for (const topic of connection.status.get().topics) {
            if (topic.type !== "sensor_msgs.BatteryState" || subscribed.has(topic.key)) {
                continue
            }
            subscribed.add(topic.key)
            const alert = batteryAlert(robotName(), topic.name)
            connection.subscribe(topic.key, { maxHz: 1 }, (message) => {
                try {
                    alert(decode("sensor_msgs.BatteryState", message.bytes))
                } catch {
                    // a malformed message: skip it
                }
            })
        }
    }
    connection.status.subscribe(sync)
    sync()
}
