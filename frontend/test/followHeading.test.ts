// The chase camera's heading: yaw only from an optical (z forward) or body (x forward) frame, smoothed, level.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import * as THREE from "three"
import { behind, ChaseHeading, headingOf, isOpticalFrame, ridesOn, turnAbout, wrapAngle } from "../src/core/followHeading.ts"

const deg = THREE.MathUtils.degToRad
// optical (x right, y down, z forward) in a body frame (x forward, y left, z up): the usual camera_link → optical joint
const OPTICAL_IN_BODY = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-Math.PI / 2, 0, -Math.PI / 2, "ZYX"))

/** a body frame at yaw/pitch/roll (ROS: Z then Y then X) */
function bodyPose(yaw: number, pitch = 0, roll = 0) {
    return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(roll, pitch, yaw, "ZYX")).setPosition(1, 2, 0.3)
}

Deno.test("the optical joint really maps optical z onto body x", () => {
    const forward = new THREE.Vector3(0, 0, 1).applyMatrix4(OPTICAL_IN_BODY)
    assertAlmostEquals(forward.x, 1, 1e-9)
    const down = new THREE.Vector3(0, 1, 0).applyMatrix4(OPTICAL_IN_BODY)
    assertAlmostEquals(down.z, -1, 1e-9)
})

Deno.test("frames named optical face along z, others along x", () => {
    assert(isOpticalFrame("front_camera_optical_frame"))
    assert(isOpticalFrame("camera_color_optical"))
    assert(!isOpticalFrame("camera_link"))
    assert(!isOpticalFrame("base_link"))
})

Deno.test("a body frame and its optical frame give the same heading", () => {
    for (const yaw of [0, 40, 135, -100, 179]) {
        const body = bodyPose(deg(yaw))
        const optical = body.clone().multiply(OPTICAL_IN_BODY)
        assertAlmostEquals(headingOf(body, "camera_link")!, deg(yaw), 1e-9)
        assertAlmostEquals(headingOf(optical, "camera_optical_frame")!, deg(yaw), 1e-9)
        // the optical frame read as a body frame would face its x (to the right): 90° off
        assertAlmostEquals(wrapAngle(headingOf(optical, "camera_link")! - deg(yaw - 90)), 0, 1e-9)
    }
})

Deno.test("pitch and roll don't change the heading", () => {
    for (const [pitch, roll] of [[25, 0], [-30, 15], [0, 40], [60, -20]]) {
        const body = bodyPose(deg(70), deg(pitch), deg(roll))
        assertAlmostEquals(headingOf(body, "front_camera")!, deg(70), 1e-9)
        assertAlmostEquals(headingOf(body.clone().multiply(OPTICAL_IN_BODY), "front_camera_optical")!, deg(70), 1e-9)
    }
})

Deno.test("a frame looking straight down has no heading", () => {
    assertEquals(headingOf(bodyPose(deg(30), deg(90)), "camera_link"), null)
})

Deno.test("the chase heading starts without a turn, then glides to the frame's heading smoothly, across ±180°", () => {
    const chase = new ChaseHeading()
    assertEquals(chase.step(deg(170), 1 / 60), 0)
    let turned = 0
    const turns: number[] = []
    // the frame jumps to -170° (20° counterclockwise across the wrap), TF at ~15 Hz, frames at 60
    for (let frame = 0; frame < 120; frame++) {
        const turn = chase.step(deg(-170), 1 / 60)
        turns.push(turn)
        turned += turn
    }
    assertAlmostEquals(turned, deg(20), deg(0.1))
    assert(turns.every((turn) => turn >= 0 && turn < deg(2)), "small, steady steps the short way round")
    assert(turns.slice(1).every((turn, i) => turn <= turns[i] + 1e-12), "easing out")
    assertEquals(chase.step(null, 1 / 60), 0)
})

Deno.test("turning keeps the camera's height and distance: the view stays level", () => {
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(-5, 0, 3)
    const pivot = new THREE.Vector3(0, 0, 0.5)
    turnAbout(camera, pivot, deg(90))
    assertAlmostEquals(camera.position.x, 0, 1e-9)
    assertAlmostEquals(camera.position.y, -5, 1e-9)
    assertAlmostEquals(camera.position.z, 3, 1e-9)
})

Deno.test("framing from behind sits opposite the heading, above", () => {
    const target = new THREE.Vector3(1, 1, 0)
    const at = behind(target, deg(90), 7)
    assertAlmostEquals(at.x, 1, 1e-9)
    assert(at.y < 1 && at.z > 0)
    assertAlmostEquals(at.distanceTo(target), 7, 1e-9)
})

Deno.test("frames on the robot are below its base frame", () => {
    const parents: Record<string, string> = { odom: "map", base_link: "odom", camera_link: "base_link", camera_optical: "camera_link" }
    const parentOf = (frame: string) => parents[frame] ?? null
    assert(ridesOn("camera_optical", "base_link", parentOf))
    assert(ridesOn("base_link", "base_link", parentOf))
    assert(!ridesOn("odom", "base_link", parentOf))
    assert(!ridesOn("map", "base_link", parentOf))
})
