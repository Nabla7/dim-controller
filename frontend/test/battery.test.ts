import { assertEquals } from "jsr:@std/assert@1"
import { batteryAlert, batteryPercent } from "../src/logic/batteryFeed.ts"

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
