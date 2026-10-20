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
3D) and placed by TF. A robot with a URDF on `/urdf_info` is drawn from it, meshes and Gaussian splats included.

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

## Arm

With a manipulation blueprint running, the arm view does what viser does: drag a gizmo, move joint sliders or pick a
saved pose, and the planner checks it (orange: reachable, red: not); Preview plays the plan as a ghost, Execute runs it.

![Arm: target ghost, planned path and the Plan and move panel](docs/arm.jpg)

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
cd frontend && npm install && npm run dev      # vite on :5173, proxied to a Desktop on :7077 (DESKTOP_URL)
npm run typecheck && npm test                  # types; LCM decoder tests (deno)
cd ../server && cargo test                     # every endpoint; the recorder and driving over zenoh on loopback
deno task check-endpoints [--write]            # dimos.yaml's provides: = the served openapi.json
nix build .#dimosApp                           # what Desktop builds: bin/dimos-app-server serving the page
```

Screenshots ([docs/screenshots.py](docs/screenshots.py)): dim-go2-sim's ranch scene with two people, and xarm-perception-sim.

## Credits

Robot-type icons (`frontend/public/robots/`) are modified from: "Humanoid robot" and "robot dog" by Izwar Muis and
"Robotics" by rukanicon (Noun Project, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)), and Tabler Icons
"drone" (MIT). Links in [docs/reference.md](docs/reference.md#credits).
