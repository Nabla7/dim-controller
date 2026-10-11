# dim-controller

A [dimOS Desktop](https://github.com/dimensionalOS/dimos-desktop) app for driving a running dimOS robot while watching
it: a low-latency 3D view placed by TF (point clouds, costmap, pose, planned path), live cameras, driving (keyboard, or
sticks on a phone, with a deadman), jogging a robot arm (joints, end effector, gripper) and an mcap recorder. It is the one canonical controller: it replaces
web_ctrl, the Live Viewer (its old name), `dimos-controller` and `dim-app-minimal-kb-control` (Teleop), and is meant to
be **forked per robot** (see [Fork this for your robot](#fork-this-for-your-robot)).

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-controller
```

Then open **Controller** from the rail while a blueprint (sim, replay or robot) runs on zenoh. Topics appear as they
start flowing; nothing is configured by topic name.

Every action is an HTTP endpoint the page itself uses, and Desktop's agent calls the same ones: arming, driving,
recording, labels, annotations, the camera, and every setting the panels change (layers on/off, layer styles, point
style, fixed frame, follow, drive speeds/topic, which topics to record). `server/src/api.rs` registers each with its
description; that table is the served `/agent.json`, and `dimos.yaml`'s `provides:` repeats it (`deno task
check-endpoints [--write]`, checked in CI). Settings live in the backend (`GET` / `PATCH api/settings`, saved in the
app's data dir), so a change from the agent or another window shows up in every open page. The one exception is
continuous driving from the keys and sticks, which publishes through the gateway at 20 Hz with the gateway's deadman;
`POST api/drive` is the endpoint way to drive (a Twist for up to 10 s, then zeros; `dryRun` sends nothing).

**Renamed from dim-live-viewer.** GitHub redirects the old URL. An install under the new name starts from the old
install's settings (`settings.json` is copied from `~/.dimos/data/apps/dim-live-viewer/`), and recordings keep going to
Desktop's `live-viewer` recordings folder if it exists (else `controller`). Setting keys keep their `lv.` prefix.

## What it shows

Every dimos topic is `dimos/<topic>/<message type>` on zenoh, so the key says how to draw it. Each message type has a
layer (one file in `frontend/src/layers/`), and each layer places what it draws by its header's `frame_id` through the
TF tree (`/tf`, `/tf_static`) into the fixed frame (auto: `world`, `map`, `odom`, ...). Data whose frame has no TF path
to the fixed frame is not drawn; the layer list says why.

| message type | layer |
| --- | --- |
| `sensor_msgs.PointCloud2` | points or voxels, colored by height / intensity / distance / solid, latest scan or accumulated |
| `nav_msgs.Odometry`, `geometry_msgs.PoseStamped`, `PoseWithCovarianceStamped` | pose axes + the driven path (bounded) |
| `nav_msgs.Path` | thick line |
| `nav_msgs.LineSegments3D` | node/edge graph, edges colored by weight |
| `geometry_msgs.PoseArray` | an arrow per pose |
| `visualization_msgs.Marker`, `MarkerArray` | arrows, cubes, spheres, cylinders, line strips/lists, cube/sphere lists, points, text, triangles |
| `vision_msgs.Detection3DArray`, `Detection3D`, `BoundingBox3DArray` | wireframe boxes with "class score" labels |
| `visualization_msgs.EntityMarkers`, `geometry_msgs.PointStamped` | labeled points |
| `nav_msgs.OccupancyGrid` | costmap / map plane |
| `tf2_msgs.TFMessage` | frame axes, names and parent links |
| `sensor_msgs.Image`, `CompressedImage` | camera panels; optionally projected into 3D (frustum + picture, from `CameraInfo`) |
| `vision_msgs.Detection2DArray`, `Detection2D`, `BoundingBox2DArray` | boxes over a camera panel |

Point clouds are GL point sprites, never meshes. The styles (Settings → Rendering for the default, each cloud's
settings to override): **Glow** (default: soft gaussian splats fading into the background with distance), **Cubes**
(MemWorld's: snaps each point to a grid and ray-casts an axis-aligned cube inside the sprite), **Spheres** (MemWorld's
lit balls) and **Squares**. Over 3M points a glow cloud draws a stable random subset, and if frames stay over 16 ms
the viewer switches glow to cubes and says so in the top bar. Coloring is a gradient lookup in the shader; scans stream into preallocated GPU buffers (a ring when
accumulating, aged out in the shader), so a new scan costs one partial buffer upload. The view only redraws when
something changed. Settings → Stats shows fps, CPU per frame and gateway-to-screen latency.

## Layouts

Settings → Layout picks how the page is arranged (saved as the `lv.layout` setting, so every open page follows):

- **Classic** (the default): the 3D view fills the window; the camera and the 2D map float over it (drag, resize, fold).
- **Cockpit**: the camera fills the window; the map and the 3D view are small insets over it, the drive keys sit
  bottom-center and Settings slides over from the right.
- **Split**: camera and 3D view as two equal halves (stacked when the space is taller than wide), the map and drive
  keys in a rail on the left, Settings in a column on the right.
- **Tiles**: equal tiles (camera, 3D, map, drive, status, settings); drag a tile's header onto another to swap them.

In the docked layouts every panel has a maximize button (Escape gives it back), Record moves into the top bar, and the
first camera panel is the one shown. Driving is the same in all of them: keys or sticks only, the latency hold and
Reconnect, and the drive keys never hide (a maximized panel leaves them in their corner).

## Cameras

One camera panel opens on the profile's preferred camera; `+` adds more, each with its own topic and an optional 2D
detection overlay. Drag a floating panel's inner corner (bottom-left for one on the right) to resize it; the
picture keeps its aspect, between 200 px wide and the window. The size is this viewer's (localStorage), not a shared
setting.

The gear over a camera (on hover) picks where it sits between latency and quality, per camera and per viewer:
**Low latency** (fits 640×360, keeps the rate when bandwidth is short: small frames are on the wire, decoded and on
screen soonest), **Balanced** (the default: the gateway picks size and bitrate for the bandwidth) or **High quality**
(full size, never shrunk, up to 6 Mbit/s, drops frames before detail, and a 100-400 ms playout buffer so motion is even).
All run at the camera's own rate. They are gateway subscription options (`maxResolution`, `maxBitrate`,
`minResolutionScale`, `minQuality`, `qualityToHzTradeoff`, `playoutDelay`), so the gateway encodes and sends less or
more; nothing is dropped in the browser ([core/videoQuality.ts](frontend/src/core/videoQuality.ts)). A switch changes
the running subscription in place (zenoh-gateway 0.5.1's `Subscription.update`: same track, no gap). `playoutDelay` is
the one browser-side knob: the gateway marks each video packet with it, `[0, 0]` (Low latency, Balanced) shows a frame
the moment it decodes, High quality's `[100, 400]` lets the jitter buffer hold frames to play them out evenly, which is
worth a fraction of a second when watching but not when driving. A panel's ⤢ makes it fullscreen and turns the 3D view into a picture-in-picture (⤢ there swaps back); fullscreen, a
button beside it switches **Fit** (the whole picture, letterboxed) and **Fill** (fills the screen, edges cropped),
remembered per panel for this viewer. With no point
cloud on the bus (a camera-only blueprint or recording) the camera takes the screen by itself, a few seconds after the
topics settle, and gives it back when a cloud appears; a swap you make yourself wins for the session.

While a camera is fullscreen the 3D view is a panel too: drag its header bar, resize it by the inner corner, ⤢ (or a
double-click on the header) gives it the screen back. Its ⏻ turns the 3D view off: every 3D layer unsubscribes (no
bandwidth) and a small bar is left to turn it back on (fullscreen, the same buttons sit beside recenter / top-down).
Its layers button lists every PointCloud2 on the bus, each with its own switch (the Layers tab's), color, point size,
live points and bytes a second, and a bandwidth preset: **Low bandwidth** (up to 5 Hz, at most 1 point in 4),
**Balanced** (the default: up to 20 Hz, every point unless the link is short) or **Full** (up to 30 Hz, never thinned),
the gateway's `maxHz` / `encodeOptions.quality` / `minQuality` ([core/cloudQuality.ts](frontend/src/core/cloudQuality.ts)).
The presets, the off switch and where the panel sits are this viewer's (localStorage).

The 3D camera follows the robot (`base_link`, or another frame: Settings → Follow frame): orbit and zoom keep
following, a pan stops it. The 3D view's corner buttons follow (lit while following; click to resume, or while
following to reframe the robot) and look straight down on the area around the robot (`POST api/camera` does the same
in every open page; its lookAt stops following). Hovering a frame in the TF panel picks it
out in the view: big axes drawn through everything, with its name.

## Robot type

Settings → **Robot** picks the kind of robot: **dog**, **humanoid**, **wheeled base**, **arm** or **drone** (the
Launcher's five robot icons), or **Auto** (the default). The type sets the keys, speeds and controls
(`frontend/src/profile/<type>.ts`), the stand-in model drawn at the robot's pose, and whether Settings shows the drive
controls or the [arm panel](#arm-control). Changing it applies at once in every open page (no reload), and disarms.

| type | keys | defaults |
| --- | --- | --- |
| dog | W/S forward, A/D turn, Q/E strafe | 0.5 m/s, 0.8 rad/s |
| humanoid | W/S forward, A/D turn, Q/E side-step | 0.3 m/s, 0.5 rad/s |
| wheeled | W/S forward, A/D turn (no strafe) | 0.4 m/s, 0.6 rad/s |
| drone | W/S forward, A/D yaw, Q/E down/up (`linear.z`) | 1 m/s, 1 rad/s, 0.5 m/s vertical |
| arm | the [arm panel](#arm-control)'s keys | 5 cm/s, 0.5 rad/s, joints 0.4 rad/s |

Auto ([core/robotType.ts](frontend/src/core/robotType.ts)), first match wins:

1. a running blueprint that robots.json lists under a robot with a `type` (Desktop's `GET /api/launcher/robots`);
2. what's running looks like an arm: a joint state / joint command / gripper stream and nothing takes `cmd_vel`;
3. the default robot set in Desktop, by its robots.json `type`;
4. the running blueprint's name (go2 / spot → dog, g1 → humanoid, r1pro / alfred → wheeled, drone, xarm / piper /
   openarm / a1z / coordinator → arm);
5. dog.

Running blueprints come before Desktop's default robot so a remembered Go2 doesn't turn a running arm sim into a dog.
The hint under the picker says which rule decided. The page writes the type in use to `lv.view.robot` (the pick is
`lv.view.profile`, `""` = auto), and drive settings are per type (`lv.drive.dog`, …; an install from before types
starts from its old profile's, e.g. `lv.drive.Unitree Go2`).

## Driving

There is no arming: whenever the Controller has the keyboard (click or tap the view to give it), W/S drive, A/D turn, Q/E strafe (per the robot profile), Shift doubles linear speed
and halves turning, Space stops (the agent's command too). Linear and angular speeds are in Settings → Drive. Commands go
straight to the output topics through Desktop's gateway, each with its own deadman: if the page goes quiet or
disconnects, the gateway sends a zero on every one. Nothing is sent while nobody steers (a release is followed by a second
of zeros, then silence), so a parked browser never drowns out other teleop.

If the control link's latency (the gateway heartbeat's round trip, or how long it has gone unanswered) passes Settings →
Drive → Max latency (default 1000 ms), or the link drops, driving stops (the usual zeros, once) and the drive panel shows
Reconnect: a new gateway session, video and control alike. Driving picks up again only on new input.

### Driving: which topics

Settings → Drive's **Topics** is **auto** by default, or a list you type (one per line, `/my_cmd_vel` or
`/my_cmd_vel TwistStamped`; saved like the other settings). Auto ([core/cmdvel.ts](frontend/src/core/cmdvel.ts)):

- A **velocity input** is a module input whose name contains `cmd_vel` (`cmd_vel`, `tele_cmd_vel`, `cmd_vel_in`, …) and
  whose type is Twist or TwistStamped. The running blueprints' modules come from Desktop's `/dimos/blueprints/<name>`.
- Every module with velocity inputs gets **one** topic, its entry point, so two topics never feed the same module:
  - an input that a velocity-consuming module of the same blueprint outputs is internal and skipped (a teleop mux such
    as MovementManager outputs `cmd_vel` to the robot; publishing there too would bypass it);
  - of the rest, `tele_*` first, then exactly `cmd_vel`, then any other, a planner's `nav_*` last;
  - each in its own type (TwistStamped gets a header, frame `base_link`).
- With no metadata (outside Desktop, or a blueprint Desktop can't describe) it's the standard set: `/cmd_vel` and
  `/tele_cmd_vel` as Twist (`dimos/cmd_vel` is the same zenoh key as `/cmd_vel`, so it's one topic).
- Topics with the same zenoh key are published once.

E.g. `unitree-go2-basic` → `/cmd_vel` (GO2Connection's); `unitree-go2` → `/tele_cmd_vel` (MovementManager's: it
already forwards to the robot's `cmd_vel` and mixes in the planner's `nav_cmd_vel`).

When every running blueprint is known and none has a velocity input, the Controller says so ("… has no cmd_vel input,
so driving won't do anything") with a button to the Launcher filtered to blueprints with a `cmd_vel` stream; "Just
view" hides it until what's running changes. It follows Desktop's `runs` / `launch` events, so it updates as runs
start and stop. The agent's `POST api/drive` still sends to one topic (its `topic`, else the first of the list).

The agent drives with `POST api/drive` (no arming needed; `dryRun` sends nothing); the drive HUD shows its command, and
"dry run · nothing sent" for a dry run.

On a phone the panels become a bottom sheet and driving moves to two thumb sticks: the left translates (forward/back,
plus strafe for a profile that strafes), the right turns (plus up/down for a profile with a vertical axis), with a big
STOP between them and FAST. Each stick's zone is a big share of the screen's bottom and the stick centers where the
thumb lands. The output has a dead zone and an expo curve, and eases toward the thumb while held
([core/stick.ts](frontend/src/core/stick.ts)); letting go is never eased: a lift, a touch cancel, a lost pointer, the
page losing focus or hiding, a rotation or STOP zero the stick at once, and the zero is published right then, not at the
next tick. STOP also lets go of a held thumb (it has to lift to drive again). The page doesn't scroll, pan or zoom while
driving. Sticks publish through the same drive loop and topics as the keys.

## Costmap

`nav_msgs.OccupancyGrid` topics (e.g. `global_costmap`) draw as a plane under the robot, with its pose and the planned
path; the view's top-down button (or `POST api/camera {action: "topDown"}`) gives the flat map view the old Controller
had in its map panel.

## Recording

The red **Record** button (top left) writes an mcap of every stream on the bus (while recording it reads **Stop recording** with the time, size and how
many streams); streams that appear mid-recording join it (the backend finds them, so `POST api/recorder/start` with no
keys records the same set). **…** opens the options: the folder (Desktop's shared recordings folder by default, under
`controller/`, or `live-viewer/` if that exists from before the rename; else `recordings` in the app's data dir), the
five biggest streams by live bandwidth (measured by the backend, `GET api/recorder/streams`) each with a switch to leave
it out, and **See recordings**, which opens the Recordings app (or offers to install it). **Advanced** has the image
format (raw, png / jpeg xl lossless, webp, jpeg), mcap chunk compression, whether new streams join, whether dimos's logs
go in, and every stream with its rate, a switch and a max rate (messages per second; the rest are skipped). The options
are saved in the backend (`lv.record.options`, `lv.record.topics`; `PUT api/recorder/settings`). Known types are
written as ROS 2 CDR so Foxglove opens the file; anything else is kept as raw LCM bytes with its type name.

The running dimos's own logs go into the same file. When recording starts the backend asks Desktop where they are
(`GET /dimos/runs`: each run's `log_dir`; on newer Desktops `GET /dimos/paths` as a fallback) and the backend tails
every `*.jsonl` there, new lines only (plus new files, runs that start mid-recording, truncation). Each line becomes a
`foxglove.Log` (JSON) on `/dimos/logs/<file stem>` (e.g. `/dimos/logs/main`), stamped with the line's own time, so
Foxglove's Log panel shows it; the original record is kept whole in its `fields` key (and the file in `source`).

## Location labels

Right-click the 3D view → **Label this location…** pins a text label at the clicked point (the nearest cloud point
under the cursor, else a mesh such as the map, else the ground plane), as a position in the fixed frame. Labels last for
the session, show in every open viewer, and are removed from the same menu. While a recording runs, every add and
remove (and the labels already made when it starts) is written to `/labels` as `dimos.LocationLabel` (JSON:
`timestamp`, `frame_id`, `id`, `label`, `action` add/delete, `pose` with position and orientation) and to
`/labels/scene` as a `foxglove.SceneUpdate` so Foxglove's 3D panel shows them.

## Arm control

With the robot type **arm**, Settings' first section is the arm panel and the bottom bar shows the arm's keys:

- **Joints**: one row per joint of the joint state: hold **−** / **+** to jog, or drag the slider to send that joint a
  target. **Home (all 0)** sends every joint to 0 and **Start pose** back to where they were when the Controller first
  saw them (dimos's `go_init`). Joint speed is a slider.
- **End effector**: hold X / Y / Z / Roll / Pitch / Yaw ± (or the keys, dimos's keyboard arm teleop's: W/S x, A/D y,
  Q/E z, R/F roll, T/G pitch, Y/H yaw); linear and angular speed are sliders.
- **Gripper**: Open / Close (`[` / `]`) and an opening slider; with more than one gripper topic, each on its own too.

Like driving it needs no arming, and it is as safe:

- Space, Escape, a key release or leaving the page stops (one hold / zero twist, then nothing);
- a held joint jog's target creeps ahead at the joint speed but never more than 0.25 s of motion past where the joint is,
  so if the page dies the joint stops within that; letting go sends "stay where you are" (the measured position);
- the end-effector jog is a TwistStamped at 20 Hz with the gateway's deadman set to a zero twist (zero = hold), and a
  second of zeros after a release, then silence;
- if a command moves no joint within 1.5 s the panel says so: the running coordinator may have no task for that input.

### Arm control: which topics

Nothing here is invented: the panel uses the ports of dimos's `ControlCoordinator` (`dimos/control/coordinator.py`)
and its arm subclasses (`dimos/robot/manipulators/common/coordinators.py`, `dimos/control/teleop_coordinator.py`), found
in the running blueprints' metadata ([core/armTopics.ts](frontend/src/core/armTopics.ts)); without metadata it uses the
same standard names. A port `foo` is the topic `/foo`, zenoh key `dimos/foo/<type>`, payload the LCM encoding:

| panel | topic | message | what the coordinator does with it |
| --- | --- | --- | --- |
| joint rows (read) | `/coordinator_joint_state` (else `*_joints` / `joint_states`) | `sensor_msgs.JointState` | every joint's position, 100 Hz |
| jog, slider, Home, Start pose | `/joint_command` | `sensor_msgs.JointState` (`name[]` + `position[]`, only the joints being moved) | trajectory task: a velocity-limited move to the target |
| end-effector jog | `/ee_twist_command` | `geometry_msgs.TwistStamped` (no `frame_id`: the arm's base frame) | eef_twist task: Pink IK follows the twist; zero holds |
| gripper | `/gripper_command`, `/left_gripper_command`, `/right_gripper_command` | `std_msgs.Float32`, 0 closed … 1 open | gripper task |

Known gaps (none of these are on a topic in dimos today):

- **Which inputs act.** A coordinator only subscribes to an input a task of its config takes, and the blueprint
  metadata doesn't say which; e.g. `keyboard-teleop-xarm7` has `joint_command` but no trajectory task, so joint jogs
  do nothing there (the panel's "no joint moved" note). `coordinator-mock` has joints but no gripper task.
- **Joint limits** aren't published (they live in the URDF and the hardware adapter), so sliders span ±180°, widened to
  any joint past that; a fork can set `arm.limits` in `profile/arm.ts`.
- **Absolute end-effector poses** (`/cartesian_command`, PoseStamped) are only in the cartesian-IK blueprints and need
  the current pose, which they don't publish; the panel lists the topic but jogs by twist and joints.
- **Go home as dimos means it** is `ManipulationSkills.go_home`, an RPC skill (pickled zenoh queryable) the browser
  can't call; Home here is joints to 0 over `joint_command`, which is that skill's default preset (the xArm7 sim's
  preset differs).
- **The arm in 3D** is what TF has: ManipulationModule publishes `world → <tip link>` only, and there is no
  `robot_description` topic, so the view shows those TF frames (Settings → Layers → TF), not a URDF mesh.
- Arm commands are page → gateway like continuous driving; there is no agent endpoint for them yet.

Verified against dimos `main` @ 0861d853e3: with `dtk run coordinator-mock` on Desktop's gateway, Auto picked arm, a
held + moved `arm/joint1` 0.42 → 1.14 rad in 2 s and stopped on release, a slider target and Home were reached,
disarming mid-jog stopped it and nothing was sent while disarmed; the JointState, TwistStamped and Float32 the page
encodes decode with dimos's own message classes. Not verified on a running arm: the end-effector jog and the gripper
(the blueprints with those tasks need dimos's manipulation extra or a MuJoCo window that didn't start here).

## Fork this for your robot

Everything robot-specific is in **one file**, a profile under `frontend/src/profile/`, one per robot type (`dog.ts`,
`humanoid.ts`, `wheeled.ts`, `arm.ts`, `drone.ts`): which frame is the robot, which Twist topics to prefer, speeds,
what each key does, an arm's jog speeds, keys and joint limits, and extra controls (sliders and buttons that publish a
message). `src/core/` (gateway, TF, renderer, drive loop, arm control, recorder) never needs to change.

1. Edit the profile of your robot's type (e.g. `dog.ts` for a quadruped), or copy one and return it from `profileFor`
   in `frontend/src/profile/index.ts`.
2. Add what your robot has. For example a torso height slider stepped with R/F (`/torso_height` here stands for your
   robot's real height command; no stock dimos blueprint has one):

```ts
keys: {
    ...groundKeys,
    KeyR: { control: "torso_height", step: 0.02 },
    KeyF: { control: "torso_height", step: -0.02 },
},
controls: [{
    kind: "slider", id: "torso_height", label: "Torso height",
    topic: "/torso_height", type: "std_msgs.Float32",     // any dimos message type: fields as in its LCM schema
    min: 0, max: 0.4, step: 0.01, initial: 0.2, unit: "m",
    message: (value) => ({ data: value }),
}],
```

and `drone.ts` makes Q/E change altitude instead of strafing:

```ts
keys: { ...turnKeys, KeyQ: { axis: "vertical", value: -1 }, KeyE: { axis: "vertical", value: 1 } },
```

A profile can also replace how the axes become a Twist (`drive.twist`), e.g. for a robot that steers differently.

**A new message type** is one file too: copy the closest layer in `frontend/src/layers/` (e.g. `path.tsx`), change its
`types` and drawing, and import it in `layers/index.ts`. A layer registered later for the same type wins, so a fork can
also override a built-in one. Messages decode with the LCM schemas in `src/core/lcm/schemas.json` (every dimos_lcm
type; regenerate with `deno run -A tools/gen_lcm_schemas.ts <dimos_lcm/lcm_files>`).

## Credits

The robot-type icons (`frontend/public/robots/`, shared with Desktop's Launcher) are modified versions (vectorized, line
weight normalized, restyled; the wheeled robot puts the humanoid's upper body on an original column and chassis) of:

- humanoid, wheeled (upper body): "Humanoid robot" by Izwar Muis, Noun Project,
  https://thenounproject.com/icon/humanoid-robot-8041298/ — [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
- dog: "robot dog" by Izwar Muis, Noun Project, https://thenounproject.com/icon/robot-dog-8041305/ — CC BY 3.0
- arm: "Robotics" by rukanicon, Noun Project, https://thenounproject.com/icon/robotics-5920654/ — CC BY 3.0
- drone: Tabler Icons "drone", https://tabler.io/icons — MIT

## Develop

```sh
cd frontend && npm install && npm run dev      # vite on :5173, proxied to a Desktop on :7077 (DESKTOP_URL)
npm run typecheck && npm test                  # types; LCM decoder tests (deno)
cd ../server && cargo test                     # every endpoint; the recorder and driving over zenoh on loopback
deno task check-endpoints [--write]            # dimos.yaml's provides: endpoints = the served agent.json
nix build .#dimosApp                           # what Desktop builds: bin/dimos-app-server serving the page
```

`server/` is the app's `dimos-app-server` (Desktop's app contract): it serves the built page and every endpoint
under `/apps/<name>/`, and talks zenoh itself only to record, find topics and drive. The page reaches Desktop's zenoh-gateway at
`../../zenoh-gateway`; its client is vendored from zenoh-gateway at 097bc12 (`frontend/src/vendor/zenoh_gateway`; gateway 0.5.1, what Desktop runs; a fresh transceiver per video subscription).
