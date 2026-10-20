// Every sensor_msgs.BatteryState topic on the bridge: the bar's battery chip (ui/BarChips.tsx, styled after the Go2
// app's: an outline filled to the charge, green / yellow / red, a bolt while charging, greyed when stale) and, on a dip
// to 20 % (re-armed above 25 %), a Desktop notification with the "battery" sound (outside Desktop notify() does nothing).
// Streamed at low priority, latest-only: a battery reading is never worth bandwidth the drive or the views need.
import { decode, type LcmValue } from "./lcm/lcm.ts"
import { type Connection, Priority } from "./transport.ts"
import { PRIORITY_TIERS } from "./bandwidth.ts"
import { Store } from "./store.ts"
import { lowLevelAlert, notify, type Notification } from "dimos-react/dim-app/notify.js"

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

/** a reading older than this is stale: the chip greys out */
export const BATTERY_STALE_MS = 5000
/** a Li-ion cell's voltage at empty and full, for a charge from cell voltages when the publisher sends no percentage */
const CELL_EMPTY_V = 3.3
const CELL_FULL_V = 4.2
/** sensor_msgs/BatteryState POWER_SUPPLY_STATUS_* */
const STATUS_CHARGING = 1
const STATUS_FULL = 4
/** the BatteryState subscription's options: low priority, latest-only (a dropped reading is replaced a second later) */
export const BATTERY_SUBSCRIBE = { maxHz: 1, delivery: "latest", priority: Priority.BACKGROUND, bandwidthPriority: PRIORITY_TIERS.background } as const

export interface BatteryReading {
    topic: string
    /** 0..100, or null when the message has no charge and no cell voltages to tell it from */
    percent: number | null
    /** whether the percent came from cell voltages (an estimate) */
    estimated: boolean
    voltage: number | null
    /** amps, positive while charging (ROS) */
    current: number | null
    temperature: number | null
    charging: boolean
    full: boolean
    cells: number[]
    receivedAt: number
}

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)

/** A decoded BatteryState as the chip shows it; with no charge in it, an estimate from its cells' mean voltage (V or mV). */
export function batteryReading(topic: string, state: LcmValue, receivedAt: number): BatteryReading {
    const cells = (Array.isArray(state?.cell_voltage) || ArrayBuffer.isView(state?.cell_voltage) ? Array.from(state.cell_voltage as ArrayLike<number>) : [])
        .filter((volts) => Number.isFinite(volts) && volts > 0)
        .map((volts) => (volts > 100 ? volts / 1000 : volts))
    let percent = batteryPercent(state)
    let estimated = false
    if (percent === null && cells.length) {
        const mean = cells.reduce((sum, volts) => sum + volts, 0) / cells.length
        percent = Math.max(0, Math.min(100, ((mean - CELL_EMPTY_V) / (CELL_FULL_V - CELL_EMPTY_V)) * 100))
        estimated = true
    }
    const status = Number(state?.power_supply_status)
    return {
        topic,
        percent,
        estimated,
        voltage: finite(state?.voltage),
        current: finite(state?.current),
        temperature: finite(state?.temperature),
        charging: status === STATUS_CHARGING,
        full: status === STATUS_FULL,
        cells,
        receivedAt,
    }
}

export type BatteryTone = "ok" | "warn" | "bad" | "stale"

/** The chip for the readings (the lowest charge when there are several), or null without any. */
export function batteryChip(readings: BatteryReading[], now: number): { percent: number | null; tone: BatteryTone; text: string; charging: boolean; detail: string } | null {
    if (!readings.length) {
        return null
    }
    const shown = [...readings].sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101))[0]
    const stale = now - shown.receivedAt > BATTERY_STALE_MS
    const percent = shown.percent === null ? null : Math.round(shown.percent)
    const tone: BatteryTone = stale ? "stale" : percent === null ? "ok" : percent > 50 ? "ok" : percent >= LOW_BATTERY_PERCENT ? "warn" : "bad"
    const describe = (reading: BatteryReading) => {
        const parts = [
            reading.percent === null ? "charge unknown" : `${Math.round(reading.percent)}%${reading.estimated ? " (from cell voltages)" : ""}`,
            reading.charging ? "charging" : reading.full ? "full" : null,
            reading.voltage === null ? null : `${reading.voltage.toFixed(1)} V`,
            reading.current === null ? null : `${reading.current.toFixed(2)} A`,
            reading.temperature === null ? null : `${reading.temperature.toFixed(0)} °C`,
            reading.cells.length ? `${reading.cells.length} cells ${Math.min(...reading.cells).toFixed(2)}–${Math.max(...reading.cells).toFixed(2)} V` : null,
        ].filter(Boolean)
        const age = now - reading.receivedAt > BATTERY_STALE_MS ? ` · no reading for ${Math.round((now - reading.receivedAt) / 1000)} s` : ""
        return `${reading.topic}: ${parts.join(" · ")}${age}`
    }
    return {
        percent,
        tone,
        text: percent === null ? (shown.voltage === null ? "—" : `${shown.voltage.toFixed(1)} V`) : `${percent}%`,
        charging: shown.charging && !stale,
        detail: `Battery · ${readings.map(describe).join("\n")}`,
    }
}

/** the latest reading of each BatteryState topic (core/batteryFeed.ts feeds it; the bar's chip shows it) */
export const batteryReadings = new Store<{ readings: BatteryReading[] }>({ readings: [] })

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
            connection.subscribe(topic.key, { ...BATTERY_SUBSCRIBE }, (message) => {
                try {
                    const state = decode("sensor_msgs.BatteryState", message.bytes)
                    alert(state)
                    const reading = batteryReading(topic.name, state, Date.now())
                    batteryReadings.set({ readings: [...batteryReadings.get().readings.filter((other) => other.topic !== topic.name), reading] })
                } catch {
                    // a malformed message: skip it
                }
            })
        }
    }
    connection.status.subscribe(sync)
    sync()
}
