import { assertEquals } from "jsr:@std/assert@1"
import { runningBlueprints } from "../src/core/runs.ts"

Deno.test("composed runs discover each blueprint so SONIC policy controls and drive routing stay active", () => {
    assertEquals(runningBlueprints([
        { blueprint: "unitree-g1-sonic-wbc-yard.scene-data", blueprints: ["unitree-g1-sonic-wbc", "yard.scene-data"] },
        { blueprint: "unitree-g1-sonic-wbc" },
    ]), ["unitree-g1-sonic-wbc", "yard.scene-data"])
})

Deno.test("older gateways and empty component lists retain the blueprint name", () => {
    assertEquals(runningBlueprints([{ blueprint: "unitree-g1-sonic-wbc", blueprints: [] }]), ["unitree-g1-sonic-wbc"])
})
