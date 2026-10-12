// The followed point: smooth between poses that arrive far slower than frames, and a snap on a teleport.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { PanGate, SmoothFollow, type Vec3 } from "../src/core/render/follow.ts"

/** a robot at 0.5 m/s whose pose arrives at ~18 Hz (with arrival jitter), drawn at 105 fps: the per-frame camera path */
function run(smooth: boolean) {
    const follow = new SmoothFollow()
    const path: Vec3[] = []
    let pose: Vec3 = [0, 0, 0]
    let nextPose = 0
    let seed = 1
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let frame = 0; frame < 630; frame++) {
        const t = frame / 105
        if (t >= nextPose) {
            pose = [0.5 * t, 0.1 * Math.sin(t), 0]
            nextPose = t + (1 / 18) * (0.7 + 0.6 * random())
        }
        path.push(smooth ? [...follow.step(pose, 1 / 105)] : pose)
    }
    path.splice(0, 105) // the first second: settling in
    const steps = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1]))
    const jerk = path.slice(2).map((p, i) => Math.hypot(p[0] - 2 * path[i + 1][0] + path[i][0], p[1] - 2 * path[i + 1][1] + path[i][1]))
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    return { still: steps.filter((step) => step < 1e-9).length, jerkOverStep: mean(jerk) / mean(steps), lag: Math.hypot(path.at(-1)![0] - pose[0], path.at(-1)![1] - pose[1]) }
}

Deno.test("following glides between poses instead of standing still and jumping", () => {
    const raw = run(false), smooth = run(true)
    console.log({ raw, smooth })
    assertEquals(smooth.still, 0)
    assert(smooth.jerkOverStep < raw.jerkOverStep / 10, `${smooth.jerkOverStep} vs ${raw.jerkOverStep}`)
    assert(smooth.lag < 0.15, `lags ${smooth.lag} m`)
})

Deno.test("a teleport snaps", () => {
    const follow = new SmoothFollow()
    follow.step([0, 0, 0], 0.01)
    assertEquals(follow.step([10, 0, 0], 0.01), [10, 0, 0])
    assertEquals(follow.step([10, 0, 0], 5)[0], 10, "a long gap snaps too")
})

Deno.test("a pinch's slip is undone while following; a real pan stops following and keeps all of the pan", () => {
    const gate = new PanGate()
    gate.start()
    assertEquals(gate.step([0.05, 0, 0], 7), { action: "undo" })
    assertEquals(gate.step([0.05, 0, 0], 7), { action: "undo" })
    const verdict = gate.step([0.3, 0, 0], 7)
    assertEquals(verdict.action, "pause")
    assertEquals(verdict.action === "pause" && verdict.restore.map((v) => Math.round(v * 100) / 100), [0.1, 0, 0])
    gate.start()
    assertEquals(gate.step([0.2, 0, 0], 20), { action: "undo" }) // far away, the same slip is a smaller share of the view
})
