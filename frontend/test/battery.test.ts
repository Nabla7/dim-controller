import { assertEquals } from "jsr:@std/assert@1"
import { BATTERY_STALE_MS, BATTERY_SUBSCRIBE, batteryAlert, batteryChip, batteryPercent, batteryReading } from "../src/core/batteryFeed.ts"

Deno.test("batteryPercent reads ROS 0..1, 0..100, and charge/capacity", () => {
    assertEquals(batteryPercent({ percentage: 0.42 }), 42)
    assertEquals(batteryPercent({ percentage: 87 }), 87)
    assertEquals(batteryPercent({ percentage: NaN, charge: 5, capacity: 20 }), 25)
    assertEquals(batteryPercent({ percentage: NaN }), null)
})

Deno.test("low battery notifies once per dip, with the battery sound", () => {
    const sent: { title: string; body?: string; sound?: string; kind?: string }[] = []
    const feed = batteryAlert("Unitree Go2", "/battery", (notification) => sent.push(notification))
    for (const percentage of [0.5, 0.21, 0.2, 0.12, 0.23, 0.18, 0.3, 0.19]) {
        feed({ percentage })
    }
    assertEquals(sent.length, 2)
    assertEquals(sent[0], {
        title: "Battery low",
        body: "Unitree Go2 at 20% (/battery)",
        kind: "warn",
        sound: "battery",
        details: { robot: "Unitree Go2", topic: "/battery", percent: 20 },
    } as typeof sent[0])
    assertEquals(sent[1].body, "Unitree Go2 at 19% (/battery)")
})

Deno.test("a Go2's BatteryState reads as the chip shows it: charge, charging, volts, amps, cells", () => {
    const go2 = { percentage: 0.62, voltage: 29.4, current: 1.5, temperature: 31, power_supply_status: 1, cell_voltage: [4.1, 4.12, 4.09] }
    const reading = batteryReading("/battery", go2, 1000)
    assertEquals([reading.percent, reading.estimated, reading.charging, reading.voltage, reading.cells.length], [62, false, true, 29.4, 3])
    const chip = batteryChip([reading], 1500)!
    assertEquals([chip.text, chip.tone, chip.charging], ["62%", "ok", true])
    assertEquals(chip.detail.includes("29.4 V") && chip.detail.includes("1.50 A") && chip.detail.includes("31 °C"), true)
})

Deno.test("battery colours: green over 50 %, yellow from 20 %, red below, grey once stale", () => {
    const tone = (percentage: number, age = 0) => batteryChip([batteryReading("/battery", { percentage }, 0)], age)!.tone
    assertEquals([tone(0.8), tone(0.5), tone(0.2), tone(0.19), tone(55)], ["ok", "warn", "warn", "bad", "ok"])
    assertEquals(tone(0.8, BATTERY_STALE_MS + 1), "stale")
    assertEquals(batteryChip([batteryReading("/battery", { percentage: 0.1, power_supply_status: 1 }, 0)], BATTERY_STALE_MS + 1)!.charging, false)
})

Deno.test("no percentage: estimated from cell voltages (V or mV), else hidden (volts shown)", () => {
    const fromCells = batteryReading("/battery", { percentage: NaN, cell_voltage: [3.75, 3.75] }, 0)
    assertEquals([Math.round(fromCells.percent!), fromCells.estimated], [50, true])
    assertEquals(Math.round(batteryReading("/battery", { percentage: NaN, cell_voltage: new Float32Array([4200, 4200]) }, 0).percent!), 100)
    const none = batteryReading("/battery", { percentage: NaN, voltage: 25.2 }, 0)
    assertEquals(none.percent, null)
    assertEquals(batteryChip([none], 0)!.text, "25.2 V")
    assertEquals(batteryChip([], 0), null)
})

Deno.test("several batteries: the chip shows the lowest", () => {
    const chip = batteryChip([batteryReading("/a", { percentage: 0.9 }, 0), batteryReading("/b", { percentage: 0.3 }, 0)], 0)!
    assertEquals(chip.text, "30%")
})

Deno.test("the battery stream is low priority and latest-only", () => {
    assertEquals(BATTERY_SUBSCRIBE.delivery, "latest")
    assertEquals(BATTERY_SUBSCRIBE.bandwidthPriority < 1, true)
    assertEquals(BATTERY_SUBSCRIBE.priority, 7)
})
