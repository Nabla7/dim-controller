# dim-controller

Drive and watch a running dimOS robot: a 3D view placed by TF, cameras, a 2D map, keys / gamepad / phone sticks, arm
planning and an mcap recorder. A [dimOS Desktop](https://github.com/dimensionalOS/dimos-desktop) app, meant to be
[forked per robot](#fork-it-for-your-robot).

![Controller: camera as the main view, the map and 3D view on the left, status and settings on the right](docs/desktop.jpg)

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-controller
```

Open **Controller** from Desktop's rail while a blueprint (sim, replay or robot) runs. Topics show up as they flow;
nothing is configured by topic name. Details for every part: [docs/reference.md](docs/reference.md).

## 3D view

Every topic is drawn by its message type (point clouds, odometry, paths, markers, detections, costmaps, TF, cameras in
3D) and placed by TF. A robot with a URDF on `/robot_description` is drawn from it, meshes and Gaussian splats included.

<p>
<img src="docs/scene.jpg" alt="3D view as the main view: the URDF scene's meshes and splats, with lidar" width="49%">
<img src="docs/top_down.jpg" alt="3D view from straight above (palette: 3D view: top-down)" width="49%">
</p>

The layers button has every layer: each point cloud with its color, size and bandwidth, and the robot model's rows
(URDF, Meshes, Textures, Splats, a row per URDF group).

![The 3D view's layers menu](docs/layers.jpg)

## Map

![The 2D map as the main view](docs/map.jpg)

## Cameras

Each camera is a panel; its gear trades latency for quality (Low latency, Balanced, High quality), done by the gateway.

![A camera's latency / quality menu](docs/quality.jpg)

## Network

The link chip opens Network: throughput and latency history, and what's using the link, stream by stream, with each
stream's drops and its priority.

![Network: link history and every stream's share](docs/network.jpg)

## Phone

The rails become drawers, the view switch (top left) picks the main view, and driving is two thumb sticks with STOP
between them. On its side the main view fills the screen.

<p>
<img src="docs/phone.jpg" alt="Phone: the camera with thumb sticks" width="24%">
<img src="docs/phone_3d.jpg" alt="Phone: the 3D view as the main view" width="24%">
<img src="docs/phone_map.jpg" alt="Phone: the map as the main view" width="24%">
<img src="docs/phone_drawer.jpg" alt="Phone: the right rail as a drawer" width="24%">
</p>

![Phone on its side: the main view under the sticks](docs/phone_side.jpg)

## Driving

WASD / arrows drive while held (Q/E strafe, Shift boosts), **Space always stops**. A gamepad works too (LT + RT stops).
There's no arming: every command goes through the gateway with a deadman, and driving disengages when latency passes
Settings → Drive → Max latency. The controller format (dog, humanoid, wheeled, arm, drone, or auto) sets the keys and
speeds. `/` opens the palette (every action), `?` lists every key.

<p>
<img src="docs/palette.jpg" alt="The command palette" width="49%">
<img src="docs/keys.jpg" alt="Every key" width="49%">
</p>

## SONIC G1

The SONIC panel appears when a running `G1SonicPolicyModule` is discovered,
including the WebXR teleop blueprint. It uses the DimOS gateway's module RPCs;
install the companion SONIC Desktop PR with `activate()`, `stop_motion()` and
the gateway's optional `run_id` request guard.

Activate requests the measured-pose ramp into balancing. Stop motion cancels
navigation and operator references without stopping balance. Deactivate holds
the measured pose and requires a supported robot. The large red DAMPING STOP
button, Space and gamepad LT+RT request latched software damping, not power
isolation. Balancing stops; restart is required. Focus loss and Escape still
stop motion without dropping balance. The UI does not automatically retry
activation, and keyboard/stick driving is blocked on stale or inactive policy
state. Other robot profiles retain their existing driving behavior.

The same panel lists SONIC's available gaits/postures and installed motion clips.
Select a gait and Apply, or a clip and Play. Pelvis height is an explicit planner
request (0.2-0.8 m, matching NVIDIA's gamepad bounds), with a Mode default option;
it is not measured robot height. Editing the controls does not send commands
until Apply/Play. Each action stops navigation first and is tied to the inspected
run ID. Gait, height and clip requests require live planner control; while a clip
or WebXR owns the reference, Return to locomotion clears it without disarming.
The panel shows the current gait, staged transitions and clip progress from
policy feedback. Posture/clip changes on hardware require confirmation; the
available mode list and height bounds are not hardware validation.

Start with `dimos --simulation mujoco --transport zenoh --viewer none run
unitree-g1-sonic-wbc`. Do not use the robot's stock locomotion controls while
SONIC owns the motors.

## Arm

With a manipulation blueprint running, the arm view does what viser does: drag a gizmo, move joint sliders or pick a
saved pose, and the planner checks it (orange: reachable, red: not); Preview plays the plan as a ghost, Execute runs it.

![Arm: target ghost, planned path and the Plan and move panel](docs/arm.jpg)

The operator integration branch discovers the active run through Desktop and binds each planner request to
`{run_id, module, session}`. It requires an engine exposing `describe_operator` and `operator_request`.
Older engines show an explicit unavailable reason; installing a process hook is no longer supported.
`GET api/manipulation` supplies the binding. Include it in mutation bodies (or the JSON `binding` query for
model/scene reads), and include the inspected `plan_id` for Preview and Execute. A changed session clears
cached targets and plans. Opening Controller does not start another coordinator or device connection.

For OpenYAM, the existing blueprint's spatial view opens in the main panel. It carries the three camera
views, Home, Hold, Resume and episode Record / Stop & save / Discard into Controller, and opens separately
for WebXR. The Arms panel uses the ordinary planner for targets, saved poses, preview, execution and cancel.
The bottom **Record** control still creates a general stream log; **Record** inside Spatial workstation
creates a training episode. The two recordings have different semantics.

This is the first M1 increment, not full acceptance: the sim's planner model contains frames and joint
limits, so the thin-link preview is kinematic and does not validate collisions. Detailed measured arm
geometry stays in the spatial view. A unified renderer, run-bound browser gripper/jogging controls,
physical acceptance and headset regression checks remain. Dual-arm ACT training is a later milestone.

The Desktop gateway also needs the remote-proxy fix that uses deployed RPC names even when its importable
local module class comes from an older checkout. Otherwise discovery succeeds but new method calls fail.

Embedded views use Controller's same-origin `api/operator-view/*` route, declared private in the app
manifest. Its backend only connects to the current session's advertised loopback port, accepts that local
server's self-signed certificate and refuses redirects. The browser keeps certificate validation enabled;
the separate XR link opens the original HTTPS view with XR enabled. This path serves local Desktop
blueprints; it does not add a remote-host proxy or a second robot connection.

Certificate regression check, 2026-10-26: the installed Desktop rendered the scene and all three cameras
with normal browser certificate validation, zero page errors and rejection of an old-run URL. Backend
tests also check binary camera data, action bodies/statuses, unadvertised views, redirects and stale
bindings (84 Rust tests passed). Type checking, manifest validation and the Nix build passed. The earlier
browser check below ignored HTTPS errors and therefore did not establish certificate compatibility.

Integration check on 2026-10-26: Controller `095b7e0`, engine `3336924e0f`, and gateway compatibility
patch `333008be0f` ran through the installed Desktop. A headless browser used the shared target API and
UI Preview/Execute, verified left-arm motion with the right holding, saved/discarded raw episodes,
and exercised Hold/Home/Resume. Both arms reached their configured Home within 0.002 rad; no page
errors occurred. The saved capture contains 419 action updates, 417 states and 51/47 wrist frames.
The check first supplied simulated controller input to engage both arms and grippers: it does not
establish a cold-start browser-only workflow or headset/hardware acceptance. The saved episode has
zero exported training frames; dual-arm ACT was not run.

Checks passed: 82 Rust tests, 305 frontend tests, TypeScript checking, the 47-operation OpenAPI/manifest
check and a Nix application build. Evidence and reproduction scripts remain outside the repository in
`/Users/pimvandenbosch/Desktop/openyam-learning-artifacts/operator-controller-20261026/`.


## Recording

**Record** writes an mcap of every stream (dimos's logs included), readable in Foxglove. **…** picks the folder,
leaves out the biggest streams, and sets image format and per-stream rates.

![Recording options](docs/record.jpg)

## For agents

Every action is an HTTP endpoint the page itself uses, listed in the served `/openapi.json` (`server/src/api.rs`,
mirrored in `dimos.yaml`'s `provides:`; `deno task check-endpoints [--write]`). Settings live in the backend, so a
change from the agent or another window shows in every open page.

## Fork it for your robot

Everything robot-specific is one file, a profile under `frontend/src/profile/` (`dog.ts`, `humanoid.ts`, `wheeled.ts`,
`arm.ts`, `drone.ts`): the robot's frame, topics, speeds, keys and extra controls. E.g. a torso height slider on R / F:

```ts
keys: {
    ...groundKeys,
    KeyR: { control: "torso_height", step: 0.02 },
    KeyF: { control: "torso_height", step: -0.02 },
},
controls: [{
    kind: "slider", id: "torso_height", label: "Torso height",
    topic: "/torso_height", type: "std_msgs.Float32",
    min: 0, max: 0.4, step: 0.01, initial: 0.2, unit: "m",
    message: (value) => ({ data: value }),
}],
```

A new message type is one file in `frontend/src/layers/` (copy the closest, change `types`, import it in
`layers/index.ts`).

## Develop

```sh
cd frontend && deno task dev                   # vite on :5173, proxied to a Desktop on :7077 (DESKTOP_URL)
deno task typecheck && deno task test          # types; the tests (deno)
cd ../server && cargo test                     # every endpoint; the recorder and driving over zenoh on loopback
deno task check-endpoints [--write]            # dimos.yaml's provides: = the served openapi.json
nix build .#dimosApp                           # what Desktop builds: bin/dimos-app-server serving the page
```

Screenshots ([docs/screenshots.py](docs/screenshots.py)): dim-go2-sim's ranch scene with two people, and xarm-perception-sim.

## Credits

Robot-type icons (`frontend/public/robots/`) are modified from: "Humanoid robot" and "robot dog" by Izwar Muis and
"Robotics" by rukanicon (Noun Project, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)), and Tabler Icons
"drone" (MIT). Links in [docs/reference.md](docs/reference.md#credits).
