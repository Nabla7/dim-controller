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
| `std_msgs.String` on `/urdf_info` | the robot's own model from its URDF (below) |

**Robot model (URDF).** When a blueprint runs dimos's `UrdfManager`, the robot is drawn from its URDF, for any robot:
`/urdf_info` carries the XML (re-sent every 5 s), each mesh is asked for once by its `package://` name on
`/mesh_request` and arrives on `/mesh_info` (`shape_msgs.MeshFile`: the file's bytes, matched by name; STL, OBJ, DAE
and PLY), a few at a time, so the model fills in. Each link sits at its TF frame (UrdfManager puts every joint on TF), its
visuals at their URDF origins. The layer ("Robot model (URDF)") turns on by itself, has opacity and visual / collision /
both, and replaces the robot type's stand-in model while it's drawn ([layers/robotModel.tsx](frontend/src/layers/robotModel.tsx),
[core/urdfSource.ts](frontend/src/core/urdfSource.ts)).

- **Cached by hash.** A mesh named `package://<pkg>/<path>?hash=<sha256>` is kept in IndexedDB (the 200 used most
  recently, keyed by the name without its query) and used with no request while its hash is the URDF's; otherwise it's
  asked for as `<name as the URDF gives it>&have=<the cached copy's hash>` (no `&have=` with nothing cached). The
  publisher answers unless `have` is current, its MeshFile's uri carrying the current `?hash=`, which is what gets
  cached. A name without `?hash=` is asked for on every load and never cached ([core/meshCache.ts](frontend/src/core/meshCache.ts)).
- **Gaussian splats.** A visual whose mesh is a splat file (`.spz`, `.splat`, `.ksplat`, `.sog`, or a `.ply` with
  `f_dc_0`/`scale_0` properties) arrives the same way and is drawn with [Spark](https://sparkjs.dev) at the link's pose,
  its URDF origin and scale applied ([core/splats.ts](frontend/src/core/splats.ts); Spark draws on three's WebGL
  renderer, three's own GaussianSplat needs WebGPU). A sim publishes a scene as a link with a splat visual next to its
  collision meshes as visuals, and its people as links posed by tf. A link may name a group, a dimos extension
  that URDF parsers ignore (urdfdom/pinocchio, yourdfpy, MuJoCo and Drake silently; ROS's urdf_parser_py prints
  "Unknown tag"): `<link name="sofa"><group>scene</group>...</link>`; a link fixed below a grouped one (the child of a
  fixed joint) is in its group unless it names its own. The layer is rows in the 3D view menu, each on or off by
  itself: **URDF** (the links in no group: the robot; opacity and visual/collision behind it), **Meshes** (mesh
  files, not splats, in any row's links), **Textures** (off: meshes in flat-shaded grey, to see the geometry),
  **Splats** (Gaussian splat files; behind it, **Cut above**, 2.5 m: splats higher than that in their file's frame are
  hidden, so ceilings don't hide the view from above), then a row per group, named by it, in the order the URDF first
  names them (dim-go2-sim's **scene** and **people**). A row shows only if the model has its part; the layer is
  subscribed while URDF or a group is on. No chunking is needed: zenoh carries a message of any size and the gateway splits it into
  64 KiB frames; a splat file is asked for again only after 10 minutes without a reply (a mesh after 1).

Point clouds are GL point sprites, never meshes. The styles (Settings → Rendering for the default, each cloud's
settings to override): **Glow** (default: soft gaussian splats fading into the background with distance), **Cubes**
(MemWorld's: snaps each point to a grid and ray-casts an axis-aligned cube inside the sprite), **Spheres** (MemWorld's
lit balls) and **Squares**. Over 3M points a glow cloud draws a stable random subset, and if frames stay over 16 ms
the viewer switches glow to cubes and says so in the bar. Coloring is a gradient lookup in the shader; scans stream into preallocated GPU buffers (a ring when
accumulating, aged out in the shader), so a new scan costs one partial buffer upload. The view only redraws when
something changed. Settings → Stats shows fps, CPU per frame and gateway-to-screen latency.

## Layout

One arrangement, made of panels:

- **Main view** between a **left rail** (the 2D map, the 3D view) and a **right rail** (Status, Settings, Layers, TF);
  the camera is the main view by default. Docked panels meet edge to edge, no gaps.
- **One bar** (bottom; nothing across the top, so the panels take the full height): on the left the drive keys lit
  while held and what's being sent (disengaged: why, and Reconnect; nothing to drive yet: why, and the Launcher); in the
  middle the main view's own actions (a camera: fit / fill, next camera, mode; the 3D view: follow; the map: follow,
  fit), focus and the palette; on the right a chip for each problem (the link when it's lost, connecting, degraded or
  slow; TF; rendering), the gamepad's state, Record, the shortcut list and STOP. A healthy link shows nothing: the
  Status panel has the link, round trip, drops, what's running, the drive and the render rates.

Every panel has the same header, its buttons in the same place, shown while the panel is hovered (always on a touch
screen): collapse / expand, make it the main view (swap: the main view's panel takes its place), pop out / dock. There's
no close: collapse a panel instead, and the others in its rail take its height. A collapsed panel stops its stream (the
3D view unsubscribes every layer, a camera its video and overlay, the map its topics); expanded, it subscribes again. A
camera also lets go while the browser tab is hidden; a 3D projection of the same camera keeps its own small stream. A panel's
own in-panel buttons (a camera's topic tabs and gear, the 3D view's follow and point clouds, the map's cog and follow)
show while it's hovered (on touch, for a few seconds after a tap on it). The map's choices sit behind its cog and in
Settings → Map (the same setting): what it shows (the lidar map, or a costmap when one is on the bus; with nothing yet,
"no lidar data on <topic> yet" / "no costmap data on <topic> yet"), which topic, a costmap overlay on the lidar map,
and the followed frame, and the 3D view's
follow frame in Settings → 3D view. Drag a header into a rail (it goes in at the
pointer's height), onto the main view's middle (swap), or anywhere else to float; a floating panel's edges snap to the
main view, the rails and the other floating panels, and it resizes from its corner. Splitters share a rail's height, a
rail's edge sets its width. The arrangement is this device's (`lv.workspace` in localStorage); the palette's "Reset the
layout" restores it.

Keys: WASD / arrows drive while held (Q/E strafe), release stops, Shift boosts, **Space stops, always**, `/` opens the
palette (every action: panels, layout, cameras, view, recording, controller format, the profile's buttons), `?` lists every
key, Escape closes, `[` `]` `\` hide and show the rails. Keys never drive while you type in a field or with an overlay
open, and leaving the window lets go of everything. On a phone the rails are drawers (buttons over the main view's top corners, with Record, the palette, the chips and a
view switch that picks the main view: any camera, the 3D view or the map) and driving is two thumb sticks with STOP between them;
on its side the main view fills the screen and the sticks lie over it.

**Gamepad** (Xbox, PlayStation, Steam Deck; the Gamepad API's standard mapping, other pads read with the common
layout): the left stick drives forward / back (and strafes, for formats that strafe), the right stick turns (and goes
up / down for a drone), RB held boosts, **LT + RT stops** at once and holds the pad until **A**; A also Reconnects
while driving is disengaged, and otherwise presses the focused button. Nothing is sent until both sticks are at rest after
the pad connects (a drifting or held stick never drives), and a disconnect, blur or hidden tab zeroes it and asks for
rest again. The arm format isn't driven by a pad (LT + RT still stops the arm). The bar shows the pad's state;
Settings → Drive → Gamepad has its dead zone and invert Y; `?` lists the mapping ([core/gamepad.ts](frontend/src/core/gamepad.ts)). On a Steam Deck (or SteamOS) opened outside Steam,
with no gamepad reaching the page, a banner says the controls only work as a gamepad when dimOS is opened from Steam and
offers **Open dimOS in Steam** (Desktop >= 0.2.119's `GET /api/steam-deck` and `POST /api/steam-deck/open`; an older
Desktop shows nothing).

## Cameras

One camera panel opens on the profile's preferred camera; the palette's "Add a camera panel" adds more, each with its own topic and an optional 2D
detection overlay. Each is a panel like any other (main view, a rail, floating); its fit / fill button letterboxes
the whole picture or fills the panel, cropped.

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
worth a fraction of a second when watching but not when driving. A camera panel's fit button (and the dock's, while it's
the main view) switches **Fit** (the whole picture, letterboxed) and **Fill** (fills its space, edges cropped),
remembered per panel for this viewer. With no point
cloud on the bus (a camera-only blueprint or recording) the camera takes the screen by itself, a few seconds after the
topics settle, and gives it back when a cloud appears; a swap you make yourself wins for the session.

The 3D view is a panel like the others. Collapsed (or off screen) every 3D layer unsubscribes (no bandwidth); expanded,
they subscribe again. **Cameras in 3D** (its menu, or Settings → 3D view: one setting, `lv.view.camerasIn3d`) draws every
camera's picture and frustum at its CameraInfo frame. A camera whose panel is open shares that panel's stream (one
subscription); otherwise the 3D view takes a small one (320×240, 3 Hz; depth 3 Hz) and switches that same
subscription to the panel's preset when the panel opens ([core/video.ts](frontend/src/core/video.ts)). Its layers button lists every PointCloud2 on the bus, each with its own switch (the Layers tab's), color, point size,
live points and bytes a second, and a bandwidth preset: **Low bandwidth** (up to 5 Hz, at most 1 point in 4),
**Balanced** (the default: up to 20 Hz, every point unless the link is short) or **Full** (up to 30 Hz, never thinned),
the gateway's `maxHz` / `encodeOptions.quality` / `minQuality` ([core/cloudQuality.ts](frontend/src/core/cloudQuality.ts)).
The presets are this viewer's (localStorage).

The 3D camera follows the robot (`base_link`, or another frame: Settings → Follow frame): orbit and zoom keep
following, a pan stops it. The 3D view's corner buttons follow (lit while following; click to resume, or while
following to reframe the robot) and look straight down on the area around the robot (`POST api/camera` does the same
in every open page; its lookAt stops following). **Settings → 3D view → View cube** (or the palette; `lv.view.viewCube`,
off by default) puts dimos-react's view cube in the top-right corner: click a face, edge or corner to look from there,
drag it to orbit. Hovering a frame in the TF panel picks it
out in the view: big axes drawn through everything, with its name.

## Controller format

Settings → **Controller format** picks how you control it (a control format, not what the robot is: an RC car can use
Dog): **dog**, **humanoid**, **wheeled base**, **arm** or **drone** (the
Launcher's five robot icons), or **Auto** (the default). The type sets the keys, speeds and controls
(`frontend/src/profile/<type>.ts`), the stand-in model drawn at the robot's pose, and whether Settings shows the drive
controls or the [arm panel](#arm-control). Changing it applies at once in every open page (no reload), and disarms.

| type | keys | defaults |
| --- | --- | --- |
| dog | W/S forward, A/D turn, Q/E strafe | 0.5 m/s, 0.8 rad/s |
| humanoid | W/S forward, A/D turn, Q/E side-step | 0.3 m/s, 0.5 rad/s |
| wheeled | W/S forward, A/D turn, Q/E strafe | 0.4 m/s, 0.6 rad/s |
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
Drive → Max latency (default 1000 ms), or the link drops, driving **disengages**: it stops (the usual zeros, once) and
the bar says why ("Disengaged: latency 1240 ms > 1000 ms max. Reconnect to drive.") with **Reconnect**: a new gateway
session, video and control alike. Driving picks up again only on new input.

### Driving: Joy

The raw input also goes out as `sensor_msgs/Joy` on `/joystick` (dimos's stream name for it: the web cockpit's teleop
and KeyboardTeleop publish the same), for recordings and Joy readers; it drives nothing. The gamepad sends its raw
axes (3 decimals) then LT's and RT's travel, and its buttons 0/1; the keys send KeyboardTeleop's buttons (w a s d q e
shift ctrl space, the arrows as w a s d); the phone's thumb sticks send a pad's four axes. Each on a change, at most
15 a second, and its rest once when let go: nothing while idle. Settings → Drive → Publish Joy turns it off
([core/joy.ts](frontend/src/core/joy.ts)).

### Driving: which topics

Settings → Drive's **Topics** is **auto** by default, or a list you type (one per line, `/my_cmd_vel` or
`/my_cmd_vel TwistStamped`; saved like the other settings). Auto ([core/cmdvel.ts](frontend/src/core/cmdvel.ts)):

- A **velocity input** is a module input whose name contains `cmd_vel` (`cmd_vel`, `tele_cmd_vel`, `cmd_vel_in`, …) and
  whose type is Twist or TwistStamped. The running blueprints' modules come from Desktop's `/dimos-gateway/catalog/blueprints/<name>`.
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
path; the palette's "3D view: top-down" (or `POST api/camera {action: "topDown"}`) looks straight down on it (the 2D map
panel is the everyday top-down view).

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
(`GET /dimos-gateway/runs`: each run's `log_dir`; else `GET /dimos-gateway/info`'s `paths.logsDirs`) and the backend tails
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

## Joint control (wheeled base)

The wheeled format has a joint control for the R1's torso (how low it stands): pick one joint of the joint state
(grippers, wheels, steering and a twist base's virtual joints are left out; a torso joint by default; remembered per robot
type in `lv.drive.<type>`) and hold **▲** / **▼** (phone: between the sticks above STOP; desktop: **R** / **F**, the dock
shows the pick and its position; Settings → Drive has the pick, the speed and the topic). It is the arm's joint jog
(below), so it stops the same way, and also on STOP, Space, Escape and a disengaged link. Targets go to
`/r1pro/joint_command` (r1pro_coordinator remaps joint_command there; empty the field for the coordinator's own); with no
JointState the control says so. One joint at a time: on the R1 torso_joint1..3 are pitch joints in a chain, so a single
one leans the torso rather than lowering it straight down.

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
- **The arm in 3D** without UrdfManager or the planner is what TF has: ManipulationModule publishes `world → <tip
  link>` only, so the view shows those TF frames (Settings → Layers → TF), not a URDF mesh.
- Arm commands are page → gateway like continuous driving; there is no agent endpoint for them yet.

Verified against dimos `main` @ 0861d853e3: with `dtk run coordinator-mock` on Desktop's gateway, Auto picked arm, a
held + moved `arm/joint1` 0.42 → 1.14 rad in 2 s and stopped on release, a slider target and Home were reached,
disarming mid-jog stopped it and nothing was sent while disarmed; the JointState, TwistStamped and Float32 the page
encodes decode with dimos's own message classes. Not verified on a running arm: the end-effector jog and the gripper
(the blueprints with those tasks need dimos's manipulation extra or a MuJoCo window that didn't start here).

### Arm control: plan and move (like viser)

With a manipulation blueprint running (one with dimos's `ManipulationModule`, e.g. `xarm-perception-sim` or
`dual-xarm6-planner-coordinator`), the arm mode's 3D view and Settings → **Plan and move** do what viser, dimos's
manipulation panel, does, in its order:

- **Status**: the planner's state (or its error), the target's (empty, checking, feasible, infeasible) and the plan's
  (none, planning, fresh, stale, failed), whether the joint state is stale, the current joints, the last result.
- **The arm in 3D** is the robot's URDF from `/urdf_info` when UrdfManager publishes it (joints the joint state doesn't
  name are read from TF), else the planner's own model (its URDF meshes, through the hook), posed live from the joint
  state. **Robot display**:
  visual, collision or both (a model with no collision geometry shows its visual meshes in collision colors, with
  viser's warning). **Scene grid** toggles the ground grid.
- **Planning Groups**: toggle which groups the target covers (two arms, an arm and a gripper...). Each selected group
  with a tip gets a gizmo (Move / Rotate) and its joints' sliders under **Joint Control** (a continuous joint wraps
  -pi..pi, an unbounded one is a number box).
- **Target**: drag a gizmo, move a slider, or pick a **Preset** (Init, Current, Home). The planner checks every edit
  the way viser does, in its own process: collision-aware IK for a gizmo's pose (the sliders follow the solution),
  collision and limits for joints (the gizmos follow the tips). The target ghost is orange when feasible, red when not,
  and **Plan** waits for a feasible target. A target moves nothing.
- **Actions**: **Next plan speed**, **Planning mode** (Joint space: plan to the joints; Cartesian space: a straight TCP
  path to the gizmos' poses), **Plan** (its tip paths are drawn), **Preview** (the blue preview ghost plays it),
  **Execute** (that plan, by its id; only while it is fresh: editing the target, the groups or the mode makes it
  stale), **Cancel** (shown while planning or moving), **Clear plan**.
- **Scene**: the planning scene's obstacles as their shapes (boxes, spheres, cylinders, meshes, a voxel map's occupied
  cells) and the grasp proposals a grasp module ranked (best green through worst orange, the leaders labelled with
  their score), each with a toggle.

Each of these is an endpoint (`api/manipulation`, `/target`, `/evaluate`, `/plan`, `/preview`, `/execute`, `/cancel`,
`/clear`, `/scene`, `/description`, `/options`), so the agent and every open page share the target and plan. Planning
and execution go over the planner's own zenoh RPCs (`dimos/rpc/ManipulationModule/<method>`), whose payloads are Python
pickles: a reader and writer for exactly what these calls carry is in [server/src/pickle.rs](server/src/pickle.rs),
tested against bytes captured from a running sim.

**The hook.** What viser has that no RPC gives (the model, the feasibility check, the Cartesian plan, obstacle shapes,
grasp proposals) it gets in-process: dimos's WorldMonitor hands its visualizer all of it. dim-controller does the same
without changing dimos: [server/python/dim_controller_hook](server/python/dim_controller_hook) is installed into the venv the
blueprint runs from (a `.pth` file Python runs at startup), wraps `WorldMonitor.finalize` to stand beside the
visualizer (viser, or none), and answers `dim_controller/hook/*` zenoh queries on loopback. Install it from the panel
(**Install hook**, for every running `dimos run`, found through dimos's run registry), `POST
api/manipulation/hook/install`, or `python3 server/python/install_hook.py [--venv PATH]`; restart the blueprint to load it. If
dimos changes under it (`finalize`'s signature, the visualizer protocol), it turns itself off with one warning and
dimos runs untouched; `DIM_CONTROLLER_HOOK=0` turns it off. Without it the panel still plans and executes (Cartesian
mode then uses `plan_to_poses`, not a straight line), checks a dragged pose's reach with the page's own IK (no
collisions), and draws obstacles as axes at their poses, but there is no 3D arm. It is a stopgap until WorldMonitor
exposes this itself. Its tests run in a dimos venv: `<dimos>/.venv/bin/python -m pytest server/python/tests -q`.

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
under `/apps/<name>/`, and talks zenoh itself only to record, find topics, drive and call the arm's planner: to DIMOS_APP's `zenohConnect` when Desktop gives one, else to the local dimos the way dimos's own sessions meet (scouting and links on loopback, no gossip autoconnect), never to whatever zenoh peers the LAN or tailnet has. The page reaches Desktop's zenoh-gateway at
`../../zenoh-gateway`; its client is dimos-react's vendored copy (zenoh-gateway 48ad46b, `dimos-react/dim-app/*`; gateway 0.5.8: lossy channels retransmit for 1 s, a reliable publisher drops puts queued over 2 s). The page is built on dimos-react (`frontend/package.json`): its controls, theme, 3D viewer, TF tree, thumb sticks and dim-app helpers; the workspace, panels and menus are this app's.
