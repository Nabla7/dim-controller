//! Every Controller action as an HTTP endpoint (routes.rs): the page calls these, Desktop's agent calls the same
//! ones (the served openapi.json, and dimos.yaml's `provides:`, which `deno task check-endpoints` keeps equal). What only
//! the page can do (render its view, read the camera, locate from an image box) the backend asks the page for with an
//! event on zenoh (annotations.rs, frontend.rs). The page's continuous driving (keys, stick) publishes through the gateway with
//! its deadman; `POST api/drive` is the endpoint way to drive. Neither needs arming (`POST api/drive/arm` is a no-op
//! kept so older callers don't 404).
use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRef, FromRequest, Query, Request, State as Extract};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::annotations::{self, Annotations};
use crate::drive::{self, Drive};
use crate::labels;
use crate::manipulation::Manipulation;
use crate::recorder;
use crate::routes::Routes;
use crate::settings::{self, Settings};

pub const TITLE: &str = "Controller";

/// the endpoints' API version (openapi.json's info.version): major = breaking, minor = added
pub const API_VERSION: &str = "2.0.0";

pub const WHEN: &str = "you need to drive a robot, watch it live in 3D, or record it";

pub const DESCRIPTION: &str = "Controller: drive the running robot (keyboard / sticks, velocity commands, stop) while watching its live 3D view \
(point clouds, costmap, pose, planned path, TF) and cameras; recording to mcap, location labels, live 3D annotations (boxes with labels every \
open page shows), and the view's settings (layers, styles, fixed frame, follow). Coordinates are meters in the world frame, +z up. GET \
api/status is the overview; GET api/view what the user sees.";

#[derive(Clone)]
pub struct Api {
    pub recorder: Arc<recorder::State>,
    pub annotations: Arc<Annotations>,
    pub settings: Arc<Settings>,
    pub drive: Arc<Drive>,
    /// the arm's planner (dimos's ManipulationModule, over its pickled zenoh RPCs)
    pub manipulation: Arc<Manipulation>,
    /// Desktop's own HTTP API (DIMOS_APP's `desktopUrl`): the running dimos's log dirs
    pub desktop_url: Arc<String>,
}

impl FromRef<Api> for Arc<Annotations> {
    fn from_ref(api: &Api) -> Self {
        api.annotations.clone()
    }
}

impl FromRef<Api> for Arc<recorder::State> {
    fn from_ref(api: &Api) -> Self {
        api.recorder.clone()
    }
}

/// A JSON body, lenient: no body (or no content-type, as an agent may send) is `{}`.
pub struct Body(pub Value);

impl<S: Send + Sync> FromRequest<S> for Body {
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Response> {
        let bytes = Bytes::from_request(request, state)
            .await
            .map_err(|error| error.into_response())?;
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Body(json!({})));
        }
        serde_json::from_slice(&bytes).map(Body).map_err(|error| {
            error_response(
                StatusCode::BAD_REQUEST,
                format!("the body isn't JSON: {error}"),
            )
        })
    }
}

fn error_response(status: StatusCode, message: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": message.to_string() }))).into_response()
}

fn s(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}
fn n(description: &str) -> Value {
    json!({ "type": "number", "description": description })
}
fn b(description: &str) -> Value {
    json!({ "type": "boolean", "description": description })
}
fn vec3(description: &str) -> Value {
    json!({ "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3, "description": description })
}
fn required(mut spec: Value) -> Value {
    spec["required"] = json!(true);
    spec
}

pub fn routes() -> Routes<Api> {
    let box_params = json!({
        "id": s("optional id (default box-<n>); use it to update or delete"),
        "label": s("shown above the box"),
        "center": vec3("box center [x, y, z], meters in frame"),
        "size": vec3("full extents [dx, dy, dz], meters"),
        "yaw": n("radians about +z (default 0)"),
        "frame": s("TF frame of center (default world)"),
        "color": s("CSS color"),
        "note": s("a second line under the label, e.g. \"1.76 m tall\""),
    });
    Routes::new()
        .endpoint("GET", "api/status", "you want an overview: recording, driving, view, labels, boxes", "The overview: whether it's recording (seconds, size, path, topics, log lines), the view settings (robot type, fixed frame, follow), layers turned on or off, driving (the command being sent, speeds and topic), annotations and location labels, and how many pages are open. Returns {recording, recordingKeys, view, layersEnabled, rendering, drive, armed (always true), driving (the command being sent, or null), annotations, labels, pages}.", json!({}), status)
        .role("context")
        .endpoint("GET", "api/view", "you need to see what the user sees, or where the robot is", "What the user sees: the rendered 3D view (with annotation labels) as an image, the 3D camera's pose and intrinsics, the latest robot camera image (with a pixel grid) and its CameraInfo and pose, the robot's pose, the annotations, and the fixed frame. 503 if no page is open to render it.", json!({}), annotations::view)
        .role("view")
        .endpoint("POST", "api/camera", "you want to point the user's 3D view at the robot or a place", "Move the 3D camera in every open page: action=recenter (follow the robot again, or reframe it if already following), topDown (straight down over the robot), or lookAt (target [x, y, z], optional distance; stops following). Returns {ok, pages} (how many pages got it); 400 for an unknown action or lookAt without a target.", json!({ "action": required(s("recenter | topDown | lookAt")), "target": vec3("lookAt: the point, world frame"), "distance": n("lookAt: meters from the target") }), camera)
        // settings: everything the page's panels change
        .endpoint("GET", "api/action_buttons", "you need the buttons on the controller's action bar", "This machine's action buttons (the action bar on every open page): each a label and the shell command a click runs. Returns {buttons: [{id, label, command}]}.", json!({}), crate::action_buttons::list)
        .endpoint("POST", "api/action_buttons", "you want to give the user a one-click button for a shell command on this machine", "Adds a button to the action bar on every open page; a click runs `command` with sh -c from the home directory of the machine this runs on (the robot's computer when Desktop runs there). Kept across restarts. Returns {button: {id, label, command}, buttons}.", json!({ "label": required(s("the button's text, a few words")), "command": required(s("the shell command a click runs (sh -c)")) }), crate::action_buttons::add)
        .endpoint("DELETE", "api/action_buttons/{id}", "you want to remove an action button", "Removes a button for good. Returns {ok, removed, buttons}; 404 if there is no such id.", json!({ "id": required(s("the button's id (in the path), from GET api/action_buttons")) }), crate::action_buttons::delete)
        .endpoint("POST", "api/action_buttons/{id}/run", "you want to run an action button's command", "Runs the button's command (sh -c, from the home directory; stopped after 120 s) and waits for it. Returns {id, label, exitCode, ok, stdout, stderr (each its last 8 KB), ms}; 404 if there is no such id.", json!({ "id": required(s("the button's id (in the path)")) }), crate::action_buttons::run)
        .endpoint("GET", "api/host", "you need to know whether the robot's computer is overloaded", "The machine this runs on (the robot's computer): its CPU load, sampled every few seconds in the background. Returns {cpu: {busyPercent (all cores, over the last sample; Linux and macOS), cores, sampledAt (unix ms), everySecs} or null before the first sample}.", json!({}), crate::host::get)
        .endpoint("GET", "api/settings", "you need the current value of a view, drive or recorder setting", "Every page setting by key: lv.view {profile (the robot type picked: dog, humanoid, wheeled, arm, drone; \"\" = auto), robot (the type in use, written by the page), fixedFrame (\"\" = auto), follow, followFrame (the TF frame the camera follows; \"\" = the robot's), showStats, robotModel, camerasIn3d (every camera drawn in the 3D view), viewCube (the 3D view's view cube)}; lv.arm {linear, angular, jointSpeed} (arm jog speeds); lv.gamepad {deadZone, invertY}; lv.rendering.v2 {pointStyle, cubeShade}; lv.layers.enabled {<topic key>: on/off}; lv.layer.<type>.<topic key> (that layer's style: colors, sizes, ...); lv.drive.<robot type> {linear, angular, vertical, topics: [] = auto, else the output topics, one per entry, \"/name\" or \"/name TwistStamped\"}; lv.joy {enabled} (the raw gamepad, drive keys and thumb sticks as sensor_msgs/Joy on /joystick, default on); lv.record.topics {<topic key>: record or not (default on)}; lv.record.options {recordNew, compression, image_format, directory (\"\" = default), logs, rates {<topic key>: max messages/s}}; lv.cameras (the camera panels). Returns an object of setting key -> its value.", json!({}), get_settings)
        .endpoint("PATCH", "api/settings", "you want to change layers, the view, drive speeds or topics", "Change a page setting (merged into the key's object; a null field is removed); every open page applies it at once. E.g. {key: \"lv.layers.enabled\", value: {\"dimos/lidar/sensor_msgs.PointCloud2\": false}} hides a layer; {key: \"lv.view\", value: {follow: false}}. Keys: see GET api/settings. Returns {key, value} (the key's whole value after the merge); 400 for an unknown key or a value that isn't an object.", json!({ "key": required(s("e.g. lv.view, lv.layers.enabled, lv.layer.pointcloud.<topic key>")), "value": required(json!({ "type": "object", "description": "the fields to set" })) }), patch_settings)
        // recording
        .endpoint("GET", "api/recorder", "you want to know if it's recording, or list the recordings", "The recorder: whether it's recording (messages, bytes, dropped, skipped by a max rate, seconds, path), the keys and log dirs being recorded, the files in the recordings folder, the folder (and the default one, and Desktop's shared recordings folder) and its options (lv.record.options). Returns {recording {active, path, messages, bytes, dropped, skipped, seconds}, keys, logs {dirs, lines}, files [{name, path, bytes, seconds_old}], settings, directory, default_directory, recordings_root, options}.", json!({}), recorder::status)
        .endpoint("POST", "api/recorder/start", "you need to start recording the robot's data to an mcap file", "Start recording to mcap. Without keys: every topic on the bus except the ones turned off in the recorder (lv.record.topics), and topics that appear later join (unless recordNew is off); the running dimos's jsonl logs go in too (unless logs is off). Each stream is kept to its max rate (rates). Location labels are written into it. Returns the recording status {active, path, messages, bytes, dropped, skipped, seconds}; 409 with the reason if it can't start (e.g. already recording), 503 if the bus can't be reached.", json!({ "keys": json!({ "type": "array", "items": { "type": "string" }, "description": "dimos keys to record (dimos/<topic>/<pkg.Type>); default: as above" }), "name": s("file name (default controller_<time>.mcap)") }), recorder::start)
        .endpoint("POST", "api/recorder/stop", "you want to stop and save the running recording", "Stop the recording and close the file (it shows in Desktop's recordings), once the files it asked for (the robot's meshes, a sim's world) are in it or given up on. Returns the final status {active, path, messages, bytes, dropped, skipped, seconds}; 409 if not recording.", json!({}), recorder::stop)
        .endpoint("POST", "api/recorder/add", "you want more topics in the recording that's already running", "Add keys to the running recording. Returns {added} (how many of the keys were new); 409 if not recording.", json!({ "keys": required(json!({ "type": "array", "items": { "type": "string" }, "description": "dimos keys to add (dimos/<topic>/<pkg.Type>)" })) }), recorder::add)
        .endpoint("POST", "api/recorder/logs", "you want dimos logs added to the running recording", "Add dimos log dirs to the running recording (each run's log dir, or logs roots whose run dirs are followed). Returns {dirs} (the log dirs now recorded); 409 if not recording.", json!({ "log_dirs": json!({ "type": "array", "items": { "type": "string" }, "description": "a run's log dir each; its jsonl logs are tailed into the recording" }), "log_roots": json!({ "type": "array", "items": { "type": "string" }, "description": "logs roots; each run dir in them is followed" }) }), recorder::add_logs)
        .endpoint("PUT", "api/recorder/settings", "you want to change the recording format, folder or topic rates", "Recording options, saved (lv.record.options): image_format (raw | png | jpegxl | webp | jpeg), compression (none | lz4 | zstd) and directory (\"\" = the default) not while recording; recordNew, logs and rates (a stream's max messages per second, 0 = every message) any time. Only the fields given change. Returns the recorder status (as GET api/recorder); 409 for a format or folder change while recording, 400 for a bad value.", json!({ "image_format": s("raw | png | jpegxl | webp | jpeg"), "compression": s("none | lz4 | zstd"), "directory": s("where recordings go; \"\" = the default (Desktop's shared recordings folder)"), "recordNew": b("topics that appear mid-recording join it"), "logs": b("record the running dimos's jsonl logs"), "rates": json!({ "type": "object", "description": "topic key -> max messages per second (0 or null = every message)" }) }), recorder::settings)
        .endpoint("GET", "api/recorder/streams", "you need to know which topics are on the bus and how heavy they are", "Each stream on the bus, biggest first: key, topic, type, bytesPerSecond and messagesPerSecond (measured live; the meter listens while this is asked for and stops 15 s after), whether it's recorded, and its maxRate. Returns {streams [...], seconds} (seconds = how long the meter has listened).", json!({}), recorder::streams)
        .endpoint("GET", "api/recorder/files/{name}", "you want to download a finished recording", "Download a recording from the recordings folder. Returns the file's bytes (application/octet-stream, as an attachment); 404 if there is no such file.", json!({ "name": required(s("the file name, as GET api/recorder lists it under files")) }), recorder::download_file)
        .endpoint("DELETE", "api/recorder/files/{name}", "you want to delete a finished recording", "Delete a recording from the recordings folder (not the running one). Returns {ok, removed}; 409 if it is the running recording, 404 if there is no such file.", json!({ "name": required(s("the file name, as GET api/recorder lists it under files")) }), recorder::delete_file)
        // location labels and annotations
        .endpoint("GET", "api/labels", "you want the named places pinned on the map", "Location labels pinned in the map (right-click in the 3D view): id, label, frame_id, position, orientation, created (ns). Returns {labels [...]}.", json!({}), labels::list)
        .endpoint("POST", "api/labels", "you want to name a place on the map", "Pin a text label at a point (the viewer's fixed frame, usually world); if a recording is running it is written into it on /labels. Returns {label (with its new id), recorded (whether it went into a running recording)}; 400 if a field is missing.", json!({ "label": required(s("the text shown at the point")), "frame_id": required(s("the frame of position, e.g. world")), "position": required(vec3("[x, y, z] meters in frame_id")) }), labels::add)
        .endpoint("DELETE", "api/labels/{id}", "you want to remove a named place from the map", "Remove a location label. Returns {ok, removed}; 404 if there is no such label.", json!({ "id": required(s("the label's id, from GET api/labels")) }), labels::remove)
        .endpoint("GET", "api/annotations", "you want the labeled 3D boxes shown in the view", "The live annotations (id, label, center, size, yaw, frame, note). Returns {annotations [...]}.", json!({}), annotations::list_annotations)
        .endpoint("POST", "api/annotations", "you want to mark something in the 3D view with a labeled box", "Add a live 3D box annotation with a label; every open page shows it immediately. Returns the annotation as stored (with its id); 400 for a bad field.", box_params, annotations::add_annotation)
        .endpoint("PATCH", "api/annotations/{id}", "you want to move, resize, relabel or rename a 3D box", "Change an annotation: label, note, center, size, yaw, color, or newId (to rename it). Only the fields given change. Returns the updated annotation; 404 if there is no such id.", json!({ "id": required(s("the annotation's id (in the path), from GET api/annotations")), "label": s("new text shown above the box"), "note": s("new second line under the label"), "center": vec3("new center"), "size": vec3("new size"), "yaw": n("new rotation, radians about +z"), "color": s("CSS color"), "newId": s("rename to this id") }), annotations::patch_annotation)
        .endpoint("DELETE", "api/annotations/{id}", "you want to remove one 3D box from the view", "Remove an annotation by id. Returns {ok, removed}; 404 if there is no such id.", json!({ "id": required(s("the annotation's id, from GET api/annotations")) }), annotations::delete_annotation)
        .endpoint("DELETE", "api/annotations", "you want to clear every 3D box from the view", "Remove every annotation. Returns {removed} (how many were removed).", json!({}), annotations::clear_annotations)
        .endpoint("POST", "api/locate", "you need an object's 3D position or height from the camera image", "Find an object in 3D from a box around it in the robot camera image (pixel coordinates of the image GET api/view returns): uses the lidar points inside that box (else where the box's bottom meets the floor) and returns its 3D box and height. add=true also adds it as an annotation. Returns {method (lidar, or floor contact), points, depth, height (meters; null if a floor-contact box is cut off at the image top), ground, box {center, size, yaw, frame}, note}, or with add=true {located, annotation}; 400 for a bad bbox, 422 with the reason if it can't (no page open, no CameraInfo, no TF, ...).", json!({ "bbox": required(json!({ "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4, "description": "[x1, y1, x2, y2] pixels in the camera image" })), "label": s("with add=true: the annotation's label"), "add": b("also add the found box as an annotation"), "id": s("with add=true: the annotation's id (default box-<n>)") }), annotations::locate)
        // driving
        .endpoint("POST", "api/drive/arm", "an older script arms driving first (never needed now)", "No-op, kept for older callers: driving needs no arming (always armed). Use api/drive/stop to stop. Returns {armed: true, note}.", json!({ "armed": b("ignored"), "source": s("ignored") }), arm)
        .endpoint("POST", "api/drive", "you need to drive or turn the robot", "Drive the robot: publish a Twist (linear [x, y, z] m/s, angular [x, y, z] rad/s, each within ±5) at 10 Hz for seconds (default 1, at most 10), then a second of zeros. No arming needed. topic: default the drive panel's, else the cmd_vel on the bus. dryRun=true only says what it would send. A new command or a stop replaces a running one; every open page shows it. Returns {key, linear, angular, seconds, hz, messages (how many it sends), dryRun, source}; 400 for a speed, duration or topic out of range.", json!({ "linear": vec3("m/s, robot frame (x forward, y left)"), "angular": vec3("rad/s (z = turn left)"), "seconds": n("default 1, at most 10"), "topic": s("e.g. /cmd_vel"), "dryRun": b("send nothing, say what would be sent"), "source": s("who is driving, shown on the page (default agent)") }), drive_robot)
        .endpoint("POST", "api/drive/stop", "you need the robot to stop moving", "Stop driving: cancels a running drive command and sends a second of zeros. Returns what it sends, as api/drive does (a zero Twist); 400 for a bad topic.", json!({ "topic": s("default as for api/drive"), "dryRun": b("send nothing, say what would be sent") }), stop_robot)
        // the arm's planner: viser's workflow through dimos's ManipulationModule
        .endpoint("GET", "api/manipulation", "you need the arm planner's state, target, groups or last plan", "The arm's planner (dimos's ManipulationModule): available (false with error when none answers), state (operation_status, execution_status, has_pending_plan, groups: {<group>: {joints {name, position}, end_effector_pose (world), gripper_position, joint_presets {home, init}}}), planning groups (id, joint_names, base_frame, tip_frame, has_gripper), the target shown as the ghost arm, and the plan last made (id, duration, jointNames, times, positions).", json!({}), manipulation_status)
        .endpoint("POST", "api/manipulation/target", "you want to set or clear where the arm should go (moves nothing)", "Set the target every open page shows as the ghost arm (it moves nothing): groups (the planning groups selected, default [manipulator]) with joints {name: radians} and/or poses {group: {position [x, y, z], orientation [x, y, z, w], frame (default world)}} (or one pose for the first group), source joints | cartesian (which was edited); or preset current | init | home (that preset's joints for the groups). clear=true removes the target.", json!({ "groups": json!({ "type": "array", "description": "planning group ids" }), "joints": json!({ "type": "object", "description": "joint name -> radians" }), "poses": json!({ "type": "object", "description": "group -> {position, orientation, frame}" }), "pose": json!({ "type": "object", "description": "the first group's pose" }), "source": s("joints | cartesian"), "preset": s("current | init | home"), "clear": b("remove the target") }), manipulation_target)
        .endpoint("POST", "api/manipulation/plan", "you want a collision-checked plan to the arm target", "Plan from where the arm is to the target (the body's, else the current one), collision-checked by the ManipulationModule: mode joint (default lv.manip.mode) plans to the groups' joints, mode cartesian a straight TCP path to the poses (with the hook; without it plan_to_poses). On success the plan is kept for Preview and Execute and every page draws its path. speed: the plan's speed scale 0.05-1 (default lv.manip.speed).", json!({ "mode": s("joint | cartesian"), "groups": json!({ "type": "array" }), "joints": json!({ "type": "object" }), "poses": json!({ "type": "object" }), "speed": n("0.05-1") }), manipulation_plan)
        .endpoint("POST", "api/manipulation/preview", "you want to show the planned arm motion without moving the arm", "Play the kept plan on the ghost arm in every open page (the real arm doesn't move).", json!({}), manipulation_preview)
        .endpoint("POST", "api/manipulation/execute", "you want the arm to run the kept plan", "Run the kept plan on the arm.", json!({}), manipulation_execute)
        .endpoint("POST", "api/manipulation/cancel", "you need the arm's planning or motion stopped", "Stop planning or the running trajectory.", json!({}), manipulation_cancel)
        .endpoint("POST", "api/manipulation/clear", "you want the kept arm plan discarded", "Discard the kept plan.", json!({}), manipulation_clear)
        .endpoint("GET", "api/manipulation/obstacles", "you need the arm planner's obstacles", "The planning scene's obstacles: name -> pose.", json!({}), manipulation_obstacles)
        .endpoint("POST", "api/manipulation/evaluate", "you want to check an arm target before planning", "Check a target the way viser's panel does, in the planner's process (needs the hook): collision-aware IK for poses, collision and limits for joints. Body: a target (groups, joints or poses, source). Answers success, collision_free, status (FEASIBLE, COLLISION, NO_SOLUTION, INVALID...), message, joints (the IK's for poses), poses (each group's tip for joints).", json!({ "groups": json!({ "type": "array" }), "joints": json!({ "type": "object" }), "poses": json!({ "type": "object" }), "source": s("joints | cartesian") }), manipulation_evaluate)
        .endpoint("GET", "api/manipulation/scene", "you need the arm planning scene's shapes and grasp proposals", "What viser draws besides the arm (needs the hook): obstacles with their shapes (box, sphere, cylinder, mesh vertices/faces, octree points), grasp proposals (pose, score; best first), the last preview; each with a version, left out when ?obstacles=&grasps=&preview= already has it. Without the hook: obstacle poses only (type marker).", json!({}), manipulation_scene)
        .endpoint("GET", "api/manipulation/hook", "you need to know whether the controller's planner hook is loaded or installed", "dim-controller's hook in the blueprint's process: loaded (its info: pid, python, groups, joint topology) and installed (per running dimos run's venv).", json!({}), manipulation_hook)
        .endpoint("POST", "api/manipulation/hook/install", "you want the controller's planner hook installed into the running blueprint", "Install (uninstall=true: remove) the hook into the venv of every running dimos run, or venv; it loads when the blueprint restarts.", json!({ "venv": s("a venv or its python (default: every running dimos run's)"), "uninstall": b("") }), manipulation_hook_install)
        .endpoint("GET", "api/manipulation/poses", "you need the arm poses saved for a robot", "The arm poses saved for a robot model (robot: its URDF name), from ~/.dimos/app_data/manip_data/<robot>/poses.yaml: poses [{name, color, target}] (target as api/manipulation/target takes it; setting it moves nothing).", json!({ "robot": required(s("the URDF's name, e.g. r1pro")) }), manipulation_poses)
        .endpoint("PUT", "api/manipulation/poses", "you want to change the arm poses saved for a robot", "Replace the arm poses saved for a robot model (the whole list, in order); every open page shows them.", json!({ "robot": required(s("the URDF's name")), "poses": required(json!({ "type": "array", "description": "[{name, color (CSS, optional), target {groups, joints, poses, source}}]" })) }), save_manipulation_poses)
        .endpoint("PATCH", "api/manipulation/options", "you want to change the arm view's planner options", "The arm 3D view's planner options (lv.manip), applied in every open page: mode (joint | cartesian: what the gizmo and sliders set), speed (next plan's speed scale 0.05-1), display (visual | collision | both: the arm's geometry), obstacles (draw the planning scene's obstacles), grasps (draw the grasp proposals), grid (the ground grid), interact (the 3D arm and gizmo are shown).", json!({ "mode": s("joint | cartesian"), "speed": n("0.05-1"), "display": s("visual | collision | both"), "obstacles": b(""), "grasps": b(""), "grid": b(""), "interact": b("") }), manipulation_options)
        // the page's plumbing: its event socket, its reports, its answers to the backend's capture requests
        .plumbing("POST", "api/pages/{page}", annotations::report_page)
        .plumbing("POST", "api/pages/{page}/close", annotations::close_page)
        .plumbing("POST", "api/captures/{request}", annotations::answer_capture)
        .plumbing("GET", "openapi.json", || async { Json(openapi()) })
}

/// The endpoints as an OpenAPI 3.1 document: the served openapi.json, and dimos.yaml's `provides:`.
pub fn openapi() -> Value {
    routes().openapi(TITLE, API_VERSION, WHEN, DESCRIPTION)
}

async fn status(Extract(api): Extract<Api>) -> Response {
    let recorder = api.recorder.status().await;
    let view = api.settings.get("lv.view");
    let profile = robot_type(&view);
    Json(json!({
        "recording": recorder.recording,
        "recordingKeys": recorder.keys.len(),
        "view": view,
        "layersEnabled": api.settings.get("lv.layers.enabled"),
        "rendering": api.settings.get("lv.rendering.v2"),
        "drive": api.settings.get(&format!("lv.drive.{profile}")),
        "armed": true,
        "driving": api.drive.running(),
        "annotations": api.annotations.list(),
        "labels": api.recorder.labels.list(),
        "pages": api.annotations.page_count(),
    }))
    .into_response()
}

async fn camera(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    match body["action"].as_str() {
        Some("recenter" | "topDown") => {}
        Some("lookAt") => {
            if serde_json::from_value::<[f64; 3]>(body["target"].clone()).is_err() {
                return error_response(StatusCode::BAD_REQUEST, "lookAt needs target [x, y, z]");
            }
        }
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "action is recenter, topDown or lookAt",
            )
        }
    }
    let pages = api.annotations.page_count();
    api.annotations.broadcast(json!({ "type": "camera", "action": body["action"], "target": body["target"], "distance": body["distance"] }));
    Json(json!({ "ok": true, "pages": pages })).into_response()
}

async fn get_settings(Extract(api): Extract<Api>) -> Response {
    Json(Value::Object(api.settings.all())).into_response()
}

async fn patch_settings(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    let Some(key) = body["key"].as_str().filter(|key| settings::valid_key(key)) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "key: a setting key starting with lv. (GET api/settings lists them)",
        );
    };
    let Some(patch) = body["value"].as_object() else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "value: an object of the fields to set",
        );
    };
    let value = api.settings.merge(key, patch);
    api.annotations
        .broadcast(json!({ "type": "settings", "key": key, "value": value, "from": body["from"] }));
    Json(json!({ "key": key, "value": value })).into_response()
}

/// The robot type in use (`lv.view.robot`, which the page writes: auto's answer or the pick), else the pick
/// (`lv.view.profile`); it names the drive settings, `lv.drive.<type>`.
fn robot_type(view: &Value) -> String {
    [&view["robot"], &view["profile"]]
        .iter()
        .find_map(|value| value.as_str().filter(|text| !text.is_empty()))
        .unwrap_or("dog")
        .to_string()
}

/// The drive topic when none is given: the drive panel's list (its first; the older single `topic` too), else a Twist
/// on the bus (tele_cmd_vel first).
async fn default_topic(api: &Api) -> String {
    let profile = robot_type(&api.settings.get("lv.view"));
    let drive = api.settings.get(&format!("lv.drive.{profile}"));
    let chosen = drive["topics"][0]
        .as_str()
        .or_else(|| drive["topic"].as_str())
        .and_then(|topic| topic.split_whitespace().next())
        .unwrap_or_default()
        .to_string();
    if !chosen.is_empty() {
        return chosen;
    }
    let keys = api.recorder.discover().await.unwrap_or_default();
    let twists: Vec<String> = keys
        .iter()
        .filter_map(|key| recorder::split_key(key))
        .filter(|(_, kind)| kind == crate::msgs::TWIST_TYPE)
        .map(|(topic, _)| topic)
        .collect();
    twists
        .iter()
        .find(|t| t.ends_with("tele_cmd_vel"))
        .or_else(|| twists.iter().find(|t| t.ends_with("cmd_vel")))
        .cloned()
        .unwrap_or_else(|| "/cmd_vel".into())
}

fn source(body: &Value) -> String {
    body["source"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("agent")
        .chars()
        .take(40)
        .collect()
}

/// Tells every page what driving is doing: the command just sent (or dry-run) or stopped.
fn announce(api: &Api, command: Option<Value>) {
    api.annotations
        .broadcast(json!({ "type": "drive", "armed": true, "command": command }));
}

/// No arming any more: answers as always armed, so older callers keep working.
async fn arm() -> Response {
    Json(json!({ "armed": true, "note": "driving needs no arming; this endpoint does nothing" })).into_response()
}

async fn drive_robot(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    let dry_run = body["dryRun"].as_bool().unwrap_or(false);
    let fallback = if body["topic"].as_str().is_some_and(|t| !t.is_empty()) {
        String::new()
    } else {
        default_topic(&api).await
    };
    match drive::parse(&body, &fallback) {
        Ok(command) => {
            let mut sent = api.drive.send(api.recorder.clone(), command, dry_run);
            sent["source"] = json!(source(&body));
            announce(&api, Some(sent.clone()));
            Json(sent).into_response()
        }
        Err(problem) => error_response(StatusCode::BAD_REQUEST, problem),
    }
}

async fn stop_robot(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    let topic = match body["topic"].as_str().filter(|t| !t.is_empty()) {
        Some(topic) => topic.to_string(),
        None => default_topic(&api).await,
    };
    match drive::parse(&json!({ "topic": topic }), "") {
        Ok(command) => {
            let stopped = api.drive.stop(
                api.recorder.clone(),
                &command.topic,
                body["dryRun"].as_bool().unwrap_or(false),
            );
            announce(&api, None);
            Json(stopped).into_response()
        }
        Err(problem) => error_response(StatusCode::BAD_REQUEST, problem),
    }
}

async fn manipulation_status(Extract(api): Extract<Api>) -> Response {
    Json(api.manipulation.status().await).into_response()
}

fn planner_error(error: anyhow::Error) -> Response {
    error_response(StatusCode::BAD_GATEWAY, error)
}

/// A target from a body (manipulation::normalize_target's shape), or a preset's joints from the planner's state for
/// the body's groups: current, init or home, as viser's Preset menu.
async fn target_from(api: &Api, body: &Value) -> Result<Value, Response> {
    if let Some(preset) = body["preset"].as_str() {
        let groups: Vec<String> = match &body["groups"] {
            Value::Array(groups) if !groups.is_empty() => groups.iter().filter_map(|group| group.as_str().map(str::to_string)).collect(),
            _ => vec![body["group"].as_str().unwrap_or("manipulator").to_string()],
        };
        let state = api.manipulation.call("get_state", vec![], vec![], std::time::Duration::from_secs(5)).await.map_err(planner_error)?;
        let mut joints = serde_json::Map::new();
        for group in &groups {
            let group_state = &state["groups"][group];
            let preset_joints = match preset {
                "current" => &group_state["joints"],
                "init" | "home" => &group_state["joint_presets"][preset],
                _ => return Err(error_response(StatusCode::BAD_REQUEST, "preset is current, init or home")),
            };
            let (Some(names), Some(positions)) = (preset_joints["name"].as_array(), preset_joints["position"].as_array()) else {
                return Err(error_response(StatusCode::NOT_FOUND, format!("the planner has no {preset} preset for {group}")));
            };
            joints.extend(names.iter().zip(positions).filter_map(|(name, position)| Some((name.as_str()?.to_string(), position.clone()))));
        }
        return Ok(json!({ "groups": groups, "joints": joints, "poses": {}, "source": "joints", "preset": preset }));
    }
    crate::manipulation::normalize_target(body).ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "a target has joints {name: radians} or poses {group: {position, orientation}} (or a pose), or is a preset"))
}

async fn manipulation_target(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    if body["clear"] == true {
        api.manipulation.set_target(None);
        api.annotations.broadcast(json!({ "type": "manipulation", "target": null, "from": body["from"] }));
        return Json(json!({ "ok": true, "target": null })).into_response();
    }
    let target = match target_from(&api, &body).await {
        Ok(target) => target,
        Err(response) => return response,
    };
    api.manipulation.set_target(Some(target.clone()));
    api.annotations.broadcast(json!({ "type": "manipulation", "target": target, "from": body["from"] }));
    Json(json!({ "ok": true, "target": target })).into_response()
}

async fn manipulation_plan(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    let target = if body["joints"].is_object() || body["poses"].is_object() || body["pose"].is_object() || body["preset"].is_string() {
        match target_from(&api, &body).await {
            Ok(target) => target,
            Err(response) => return response,
        }
    } else {
        match api.manipulation.target() {
            Some(target) => target,
            None => return error_response(StatusCode::BAD_REQUEST, "no target: set one (api/manipulation/target) or pass it"),
        }
    };
    let options = api.settings.get("lv.manip");
    let speed = body["speed"].as_f64().or_else(|| options["speed"].as_f64());
    let mode = body["mode"].as_str().or_else(|| options["mode"].as_str()).unwrap_or("joint").to_string();
    match api.manipulation.plan_to(&target, &mode, speed).await {
        Ok(result) => {
            api.manipulation.set_target(Some(target.clone()));
            api.annotations.broadcast(json!({ "type": "manipulation", "target": target, "plan": result["plan"], "planned": result, "from": body["from"] }));
            Json(result).into_response()
        }
        Err(error) => planner_error(error),
    }
}

async fn manipulation_preview(Extract(api): Extract<Api>) -> Response {
    let Some(plan) = api.manipulation.plan() else {
        return error_response(StatusCode::CONFLICT, "no plan to preview: Plan first");
    };
    let pages = api.annotations.page_count();
    api.annotations.broadcast(json!({ "type": "manipulation", "preview": plan["id"] }));
    Json(json!({ "ok": true, "pages": pages, "duration": plan["duration"] })).into_response()
}

async fn manipulation_execute(Extract(api): Extract<Api>) -> Response {
    match api.manipulation.execute().await {
        Ok(result) => {
            api.annotations.broadcast(json!({ "type": "manipulation", "executed": result }));
            Json(result).into_response()
        }
        Err(error) => error_response(StatusCode::CONFLICT, error),
    }
}

async fn manipulation_cancel(Extract(api): Extract<Api>) -> Response {
    api.annotations.broadcast(json!({ "type": "manipulation", "cancel": true }));
    match api.manipulation.cancel().await {
        Ok(result) => Json(result).into_response(),
        Err(error) => planner_error(error),
    }
}

async fn manipulation_clear(Extract(api): Extract<Api>) -> Response {
    let result = api.manipulation.clear().await;
    api.annotations.broadcast(json!({ "type": "manipulation", "plan": null }));
    match result {
        Ok(result) => Json(result).into_response(),
        Err(error) => planner_error(error),
    }
}

/// viser's target check through the hook: collision-aware IK for poses, state validity for joints.
async fn manipulation_evaluate(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    let Some(target) = crate::manipulation::normalize_target(&body) else {
        return error_response(StatusCode::BAD_REQUEST, "a target to check: joints or poses, and groups");
    };
    let request = if target["source"] == "cartesian" {
        json!({ "groups": target["groups"], "poses": target["poses"], "seed": target["joints"] })
    } else {
        json!({ "groups": target["groups"], "joints": target["joints"] })
    };
    match api.manipulation.hook("evaluate", &request, std::time::Duration::from_secs(5)).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => error_response(StatusCode::SERVICE_UNAVAILABLE, error),
    }
}

/// The hook's scene: obstacles with their shapes, grasp proposals, the last preview; each with a version, and left out
/// when the query's version (?obstacles=&grasps=&preview=) is already current. Without the hook: the RPC's obstacle
/// poses as markers.
async fn manipulation_scene(Extract(api): Extract<Api>, Query(query): Query<HashMap<String, String>>) -> Response {
    let known: serde_json::Map<String, Value> = query.iter().filter_map(|(key, value)| Some((key.clone(), json!(value.parse::<i64>().ok()?)))).collect();
    match api.manipulation.hook("scene", &Value::Object(known), std::time::Duration::from_secs(5)).await {
        Ok(scene) => Json(json!({ "hook": true, "scene": scene })).into_response(),
        Err(hook_error) => match api.manipulation.obstacles().await {
            Ok(poses) => {
                let obstacles: Vec<Value> = poses.as_object().into_iter().flatten().map(|(name, pose)| json!({ "name": name, "type": "marker", "pose": { "position": [pose["position"]["x"], pose["position"]["y"], pose["position"]["z"]], "orientation": [pose["orientation"]["x"], pose["orientation"]["y"], pose["orientation"]["z"], pose["orientation"]["w"]] } })).collect();
                Json(json!({ "hook": false, "problem": hook_error.to_string(), "scene": { "versions": {}, "obstacles": obstacles } })).into_response()
            }
            Err(error) => planner_error(error),
        },
    }
}

/// Where the hook is: loaded (its info), and for each running `dimos run`, whether its venv has it installed.
async fn manipulation_hook(Extract(api): Extract<Api>) -> Response {
    let loaded = api.manipulation.hook("info", &Value::Null, std::time::Duration::from_secs(2)).await.ok();
    let installed = crate::hook_install::run(&["--status"]).await;
    Json(json!({ "loaded": loaded, "installed": installed.unwrap_or_else(|error| error.to_string()) })).into_response()
}

/// Install the hook into the venv of every running `dimos run` (or `venv`); it loads when the blueprint restarts.
async fn manipulation_hook_install(Body(body): Body) -> Response {
    let mut args = vec![];
    if let Some(venv) = body["venv"].as_str() {
        args.extend(["--venv", venv]);
    }
    if body["uninstall"] == true {
        args.push("--uninstall");
    }
    match crate::hook_install::run(&args).await {
        Ok(output) => Json(json!({ "ok": true, "output": output })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn manipulation_obstacles(Extract(api): Extract<Api>) -> Response {
    match api.manipulation.obstacles().await {
        Ok(obstacles) => Json(obstacles).into_response(),
        Err(error) => planner_error(error),
    }
}

async fn manipulation_options(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    let mut patch = serde_json::Map::new();
    for (key, valid) in [
        ("mode", body["mode"].as_str().is_some_and(|mode| ["joint", "cartesian"].contains(&mode))),
        ("speed", body["speed"].as_f64().is_some_and(|speed| (0.05..=1.0).contains(&speed))),
        ("display", body["display"].as_str().is_some_and(|display| ["visual", "collision", "both"].contains(&display))),
        ("obstacles", body["obstacles"].is_boolean()),
        ("grasps", body["grasps"].is_boolean()),
        ("grid", body["grid"].is_boolean()),
        ("interact", body["interact"].is_boolean()),
    ] {
        if !body[key].is_null() {
            if !valid {
                return error_response(StatusCode::BAD_REQUEST, format!("{key}: see the endpoint's description for its values"));
            }
            patch.insert(key.into(), body[key].clone());
        }
    }
    let value = api.settings.merge("lv.manip", &patch);
    api.annotations.broadcast(json!({ "type": "settings", "key": "lv.manip", "value": value, "from": body["from"] }));
    Json(json!({ "key": "lv.manip", "value": value })).into_response()
}

async fn manipulation_poses(Query(query): Query<HashMap<String, String>>) -> Response {
    let robot = query.get("robot").map(String::as_str).unwrap_or("");
    if !crate::poses::valid_robot(robot) {
        return error_response(StatusCode::BAD_REQUEST, "robot: the URDF's name (letters, digits, . _ -)");
    }
    let home = crate::poses::dimos_home();
    match crate::poses::load(&home, robot) {
        Ok(poses) => Json(json!({ "robot": robot, "file": crate::poses::file(&home, robot), "poses": poses })).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn save_manipulation_poses(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    let robot = body["robot"].as_str().unwrap_or("");
    if !crate::poses::valid_robot(robot) {
        return error_response(StatusCode::BAD_REQUEST, "robot: the URDF's name (letters, digits, . _ -)");
    }
    let poses = match crate::poses::validate(&body["poses"]) {
        Ok(poses) => poses,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, error),
    };
    match crate::poses::save(&crate::poses::dimos_home(), robot, &poses) {
        Ok(file) => {
            api.annotations.broadcast(json!({ "type": "manipulation", "savedPoses": { "robot": robot, "poses": poses }, "from": body["from"] }));
            Json(json!({ "ok": true, "file": file, "poses": poses })).into_response()
        }
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

#[cfg(test)]
impl Api {
    pub fn for_tests(annotations: Arc<Annotations>) -> Api {
        Api {
            recorder: Arc::new(recorder::State::new(
                std::env::temp_dir().join("lv_api_test"),
                "tcp/127.0.0.1:9".into(),
            )),
            annotations,
            settings: Arc::new(Settings::load(None)),
            drive: Arc::default(),
            manipulation: Arc::new(Manipulation::new(Arc::new(recorder::State::new(
                std::env::temp_dir().join("lv_api_test"),
                "tcp/127.0.0.1:9".into(),
            )))),
            desktop_url: Arc::new(String::new()),
        }
    }
}

#[cfg(test)]
pub fn test_router(recorder: Arc<recorder::State>) -> axum::Router {
    let mut api = Api::for_tests(Arc::default());
    api.settings = recorder.settings.clone();
    api.recorder = recorder;
    routes().router.with_state(api)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body as HttpBody;
    use tower::ServiceExt;

    async fn call(
        router: &axum::Router,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let request = axum::http::Request::builder().method(method).uri(path);
        let request = match body {
            Some(body) => request.body(HttpBody::from(body.to_string())),
            None => request.body(HttpBody::empty()),
        };
        let response = router.clone().oneshot(request.unwrap()).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn router() -> (Api, axum::Router) {
        let dir = std::env::temp_dir().join(format!("lv_api_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let mut api = Api::for_tests(Arc::default());
        api.recorder = Arc::new(recorder::State::new(dir, "tcp/127.0.0.1:9".into()));
        api.settings = api.recorder.settings.clone();
        (api.clone(), routes().router.with_state(api))
    }

    /// the drive settings follow the robot type in use (lv.view.robot), else the pick, else dog
    #[test]
    fn drive_settings_are_per_robot_type() {
        assert_eq!(robot_type(&json!({ "profile": "", "robot": "arm" })), "arm");
        assert_eq!(robot_type(&json!({ "profile": "drone" })), "drone");
        assert_eq!(robot_type(&json!({ "profile": "", "robot": "" })), "dog");
        assert_eq!(robot_type(&json!({})), "dog");
    }

    /// every listed endpoint is routed (a readable JSON answer, never the router's bare 404 / 405), and openapi.json is the table
    // the planner endpoints open a zenoh session, which needs the multi-thread runtime
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn every_endpoint_is_routed() {
        let (_api, router) = router();
        let table = routes();
        for endpoint in &table.endpoints {
            let method = endpoint["method"].as_str().unwrap();
            let path = endpoint["path"].as_str().unwrap();
            // no page answers captures and nothing may be published: skip what would wait or drive
            if matches!(
                path,
                "api/view"
                    | "api/locate"
                    | "api/drive"
                    | "api/drive/stop"
                    | "api/drive/arm"
                    | "api/recorder/start"
                    | "api/recorder/streams"
            ) {
                continue;
            }
            let path = path.replace("{id}", "x").replace("{name}", "x.mcap");
            let request = axum::http::Request::builder()
                .method(method)
                .uri(format!("/{path}"))
                .body(HttpBody::empty())
                .unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert!(
                status.is_success()
                    || serde_json::from_slice::<Value>(&bytes)
                        .is_ok_and(|v| v["error"].is_string()),
                "{method} {path}: {status}"
            );
        }
        let (status, served) = call(&router, "GET", "/openapi.json", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(served, openapi());
        let roles: Vec<_> = table.endpoints.iter().filter_map(|e| e["role"].as_str()).collect();
        assert_eq!(roles, vec!["context", "view"]);
    }

    #[tokio::test]
    async fn action_buttons_add_run_and_remove() {
        let (api, router) = router();
        let mut events = api.annotations.events.subscribe();
        let (status, added) = call(&router, "POST", "/api/action_buttons", Some(json!({ "label": "Say hi", "command": "echo hi; echo oops >&2; exit 3" }))).await;
        assert_eq!(status, StatusCode::OK);
        let id = added["button"]["id"].as_str().unwrap().to_string();
        assert_eq!(events.recv().await.unwrap()["type"], "action_buttons");
        let (_, ran) = call(&router, "POST", &format!("/api/action_buttons/{id}/run"), None).await;
        assert_eq!((ran["exitCode"].clone(), ran["stdout"].clone(), ran["stderr"].clone(), ran["ok"].clone()), (json!(3), json!("hi\n"), json!("oops\n"), json!(false)));
        let (status, _) = call(&router, "POST", "/api/action_buttons", Some(json!({ "label": "no command" }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = call(&router, "DELETE", &format!("/api/action_buttons/{id}"), None).await;
        assert_eq!(status, StatusCode::OK);
        let (_, listed) = call(&router, "GET", "/api/action_buttons", None).await;
        assert!(!listed["buttons"].as_array().unwrap().iter().any(|button| button["id"] == json!(id)));
        let (status, _) = call(&router, "POST", &format!("/api/action_buttons/{id}/run"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn settings_reach_every_page() {
        let (api, router) = router();
        let mut events = api.annotations.events.subscribe();
        let (status, body) = call(
            &router,
            "PATCH",
            "/api/settings",
            Some(json!({ "key": "lv.view", "value": { "follow": false } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            events.try_recv().unwrap()["value"],
            json!({ "follow": false })
        );
        assert_eq!(
            call(&router, "GET", "/api/settings", None).await.1["lv.view"]["follow"],
            false
        );
        assert_eq!(
            call(&router, "GET", "/api/status", None).await.1["view"]["follow"],
            false
        );
        assert_eq!(
            call(
                &router,
                "PATCH",
                "/api/settings",
                Some(json!({ "key": "view", "value": {} }))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(
                &router,
                "PATCH",
                "/api/settings",
                Some(json!({ "key": "lv.view", "value": 3 }))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn camera_drive_and_labels() {
        let (api, router) = router();
        let mut events = api.annotations.events.subscribe();
        assert_eq!(
            call(
                &router,
                "POST",
                "/api/camera",
                Some(json!({ "action": "topDown" }))
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(events.try_recv().unwrap()["action"], "topDown");
        assert_eq!(
            call(
                &router,
                "POST",
                "/api/camera",
                Some(json!({ "action": "lookAt" }))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(
                &router,
                "POST",
                "/api/camera",
                Some(json!({ "action": "spin" }))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        // dry runs only: tests never publish a Twist
        let (status, dry) = call(
            &router,
            "POST",
            "/api/drive",
            Some(
                json!({ "linear": [0.3, 0, 0], "seconds": 2, "topic": "/cmd_vel", "dryRun": true }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{dry}");
        assert_eq!(
            (dry["key"].as_str(), dry["messages"].as_u64()),
            (Some("dimos/cmd_vel/geometry_msgs.Twist"), Some(30))
        );
        assert_eq!(
            call(
                &router,
                "POST",
                "/api/drive",
                Some(json!({ "seconds": 99, "topic": "/cmd_vel", "dryRun": true }))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(
                &router,
                "POST",
                "/api/drive/stop",
                Some(json!({ "topic": "/cmd_vel", "dryRun": true }))
            )
            .await
            .0,
            StatusCode::OK
        );
        // no arming: api/drive/arm is a no-op that always answers armed
        while events.try_recv().is_ok() {}
        let (status, armed) = call(
            &router,
            "POST",
            "/api/drive/arm",
            Some(json!({ "armed": false })),
        )
        .await;
        assert_eq!((status, armed["armed"].as_bool()), (StatusCode::OK, Some(true)));
        assert_eq!(
            call(&router, "GET", "/api/status", None).await.1["armed"],
            true
        );
        let (status, dry) = call(
            &router,
            "POST",
            "/api/drive",
            Some(json!({ "linear": [0.3, 0, 0], "topic": "/cmd_vel", "dryRun": true })),
        )
        .await;
        assert_eq!(
            (status, dry["source"].as_str()),
            (StatusCode::OK, Some("agent"))
        );
        assert_eq!(
            events.try_recv().unwrap()["command"]["dryRun"],
            true,
            "pages see dry runs too"
        );
        let (status, made) = call(
            &router,
            "POST",
            "/api/labels",
            Some(json!({ "label": "door", "frame_id": "world", "position": [1, 2, 0] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{made}");
        assert_eq!(
            call(
                &router,
                "POST",
                "/api/labels",
                Some(json!({ "label": "door" }))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let id = made["label"]["id"].as_str().unwrap();
        assert_eq!(
            call(&router, "DELETE", &format!("/api/labels/{id}"), None)
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&router, "DELETE", "/api/labels/nope", None).await.0,
            StatusCode::NOT_FOUND
        );
        let (status, added) = call(
            &router,
            "POST",
            "/api/annotations",
            Some(json!({ "label": "chair", "center": [0, 0, 0.5], "size": [0.5, 0.5, 1] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{added}");
        assert_eq!(
            call(
                &router,
                "PATCH",
                "/api/annotations/box-1",
                Some(json!({ "note": "tall" }))
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &router,
                "PATCH",
                "/api/annotations/nope",
                Some(json!({ "note": "x" }))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(&router, "GET", "/api/view", None).await.0,
            StatusCode::SERVICE_UNAVAILABLE,
            "no page open"
        );
    }
}
