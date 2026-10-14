//! Every Controller action as an HTTP endpoint (routes.rs): the page calls these, Desktop's agent calls the same
//! ones (the served agent.json, and dimos.yaml's `agent:`, which `deno task check-endpoints` keeps equal). What only
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
        .endpoint("GET", "api/status", "The overview: whether it's recording (seconds, size, path, topics, log lines), the view settings (robot type, fixed frame, follow), layers turned on or off, driving (the command being sent, speeds and topic), annotations and location labels, and how many pages are open.", json!({}), status)
        .role("context")
        .endpoint("GET", "api/view", "What the user sees: the rendered 3D view (with annotation labels) as an image, the 3D camera's pose and intrinsics, the latest robot camera image (with a pixel grid) and its CameraInfo and pose, the robot's pose, the annotations, and the fixed frame.", json!({}), annotations::view)
        .role("view")
        .endpoint("POST", "api/camera", "Move the 3D camera in every open page: action=recenter (follow the robot again, or reframe it if already following), topDown (straight down over the robot), or lookAt (target [x, y, z], optional distance; stops following).", json!({ "action": required(s("recenter | topDown | lookAt")), "target": vec3("lookAt: the point, world frame"), "distance": n("lookAt: meters from the target") }), camera)
        // settings: everything the page's panels change
        .endpoint("GET", "api/settings", "Every page setting by key: lv.view {profile (the robot type picked: dog, humanoid, wheeled, arm, drone; \"\" = auto), robot (the type in use, written by the page), fixedFrame (\"\" = auto), follow, followFrame (the TF frame the camera follows; \"\" = the robot's), showStats, robotModel, camerasIn3d (every camera drawn in the 3D view), viewCube (the 3D view's view cube)}; lv.arm {linear, angular, jointSpeed} (arm jog speeds); lv.gamepad {deadZone, invertY}; lv.rendering.v2 {pointStyle, cubeShade}; lv.layers.enabled {<topic key>: on/off}; lv.layer.<type>.<topic key> (that layer's style: colors, sizes, ...); lv.drive.<robot type> {linear, angular, vertical, topics: [] = auto, else the output topics, one per entry, \"/name\" or \"/name TwistStamped\"}; lv.record.topics {<topic key>: record or not (default on)}; lv.record.options {recordNew, compression, image_format, directory (\"\" = default), logs, rates {<topic key>: max messages/s}}; lv.cameras (the camera panels).", json!({}), get_settings)
        .endpoint("PATCH", "api/settings", "Change a page setting (merged into the key's object; a null field is removed); every open page applies it at once. E.g. {key: \"lv.layers.enabled\", value: {\"dimos/lidar/sensor_msgs.PointCloud2\": false}} hides a layer; {key: \"lv.view\", value: {follow: false}}. Keys: see GET api/settings.", json!({ "key": required(s("e.g. lv.view, lv.layers.enabled, lv.layer.pointcloud.<topic key>")), "value": required(json!({ "type": "object", "description": "the fields to set" })) }), patch_settings)
        // recording
        .endpoint("GET", "api/recorder", "The recorder: whether it's recording (messages, bytes, dropped, skipped by a max rate, seconds, path), the keys and log dirs being recorded, the files in the recordings folder, the folder (and the default one, and Desktop's shared recordings folder) and its options (lv.record.options).", json!({}), recorder::status)
        .endpoint("POST", "api/recorder/start", "Start recording to mcap. Without keys: every topic on the bus except the ones turned off in the recorder (lv.record.topics), and topics that appear later join (unless recordNew is off); the running dimos's jsonl logs go in too (unless logs is off). Each stream is kept to its max rate (rates). Location labels are written into it.", json!({ "keys": json!({ "type": "array", "items": { "type": "string" }, "description": "dimos keys to record (dimos/<topic>/<pkg.Type>); default: as above" }), "name": s("file name (default controller_<time>.mcap)") }), recorder::start)
        .endpoint("POST", "api/recorder/stop", "Stop the recording and close the file (it shows in Desktop's recordings).", json!({}), recorder::stop)
        .endpoint("POST", "api/recorder/add", "Add keys to the running recording.", json!({ "keys": required(json!({ "type": "array", "items": { "type": "string" } })) }), recorder::add)
        .endpoint("POST", "api/recorder/logs", "Add dimos log dirs to the running recording (each run's log dir, or logs roots whose run dirs are followed).", json!({ "log_dirs": json!({ "type": "array", "items": { "type": "string" } }), "log_roots": json!({ "type": "array", "items": { "type": "string" } }) }), recorder::add_logs)
        .endpoint("PUT", "api/recorder/settings", "Recording options, saved (lv.record.options): image_format (raw | png | jpegxl | webp | jpeg), compression (none | lz4 | zstd) and directory (\"\" = the default) not while recording; recordNew, logs and rates (a stream's max messages per second, 0 = every message) any time.", json!({ "image_format": s("raw | png | jpegxl | webp | jpeg"), "compression": s("none | lz4 | zstd"), "directory": s("where recordings go; \"\" = the default (Desktop's shared recordings folder)"), "recordNew": b("topics that appear mid-recording join it"), "logs": b("record the running dimos's jsonl logs"), "rates": json!({ "type": "object", "description": "topic key -> max messages per second (0 or null = every message)" }) }), recorder::settings)
        .endpoint("GET", "api/recorder/streams", "Each stream on the bus, biggest first: key, topic, type, bytesPerSecond and messagesPerSecond (measured live; the meter listens while this is asked for and stops 15 s after), whether it's recorded, and its maxRate.", json!({}), recorder::streams)
        .endpoint("GET", "api/recorder/files/{name}", "Download a recording from the recordings folder.", json!({}), recorder::download_file)
        .endpoint("DELETE", "api/recorder/files/{name}", "Delete a recording from the recordings folder (not the running one).", json!({}), recorder::delete_file)
        // location labels and annotations
        .endpoint("GET", "api/labels", "Location labels pinned in the map (right-click in the 3D view): id, label, frame_id, position, orientation, created (ns).", json!({}), labels::list)
        .endpoint("POST", "api/labels", "Pin a text label at a point (the viewer's fixed frame, usually world); if a recording is running it is written into it on /labels.", json!({ "label": required(s("")), "frame_id": required(s("the frame of position, e.g. world")), "position": required(vec3("[x, y, z] meters in frame_id")) }), labels::add)
        .endpoint("DELETE", "api/labels/{id}", "Remove a location label.", json!({}), labels::remove)
        .endpoint("GET", "api/annotations", "The live annotations (id, label, center, size, yaw, frame, note).", json!({}), annotations::list_annotations)
        .endpoint("POST", "api/annotations", "Add a live 3D box annotation with a label; every open page shows it immediately.", box_params, annotations::add_annotation)
        .endpoint("PATCH", "api/annotations/{id}", "Change an annotation: label, note, center, size, yaw, color, or newId (to rename it).", json!({ "label": s(""), "note": s(""), "center": vec3("new center"), "size": vec3("new size"), "yaw": n(""), "color": s(""), "newId": s("rename to this id") }), annotations::patch_annotation)
        .endpoint("DELETE", "api/annotations/{id}", "Remove an annotation by id.", json!({}), annotations::delete_annotation)
        .endpoint("DELETE", "api/annotations", "Remove every annotation.", json!({}), annotations::clear_annotations)
        .endpoint("POST", "api/locate", "Find an object in 3D from a box around it in the robot camera image (pixel coordinates of the image GET api/view returns): uses the lidar points inside that box (else where the box's bottom meets the floor) and returns its 3D box and height. add=true also adds it as an annotation.", json!({ "bbox": required(json!({ "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4, "description": "[x1, y1, x2, y2] pixels in the camera image" })), "label": s(""), "add": b(""), "id": s("") }), annotations::locate)
        // driving
        .endpoint("POST", "api/drive/arm", "No-op, kept for older callers: driving needs no arming (always armed). Use api/drive/stop to stop.", json!({ "armed": b("ignored"), "source": s("ignored") }), arm)
        .endpoint("POST", "api/drive", "Drive the robot: publish a Twist (linear [x, y, z] m/s, angular [x, y, z] rad/s, each within ±5) at 10 Hz for seconds (default 1, at most 10), then a second of zeros. No arming needed. topic: default the drive panel's, else the cmd_vel on the bus. dryRun=true only says what it would send. A new command or a stop replaces a running one; every open page shows it.", json!({ "linear": vec3("m/s, robot frame (x forward, y left)"), "angular": vec3("rad/s (z = turn left)"), "seconds": n("default 1, at most 10"), "topic": s("e.g. /cmd_vel"), "dryRun": b("send nothing, say what would be sent"), "source": s("who is driving, shown on the page (default agent)") }), drive_robot)
        .endpoint("POST", "api/drive/stop", "Stop driving: cancels a running drive command and sends a second of zeros.", json!({ "topic": s("default as for api/drive"), "dryRun": b("") }), stop_robot)
        // the arm's planner: viser's workflow through dimos's ManipulationModule
        .endpoint("GET", "api/manipulation", "The arm's planner (dimos's ManipulationModule): available (false with error when none answers), state (operation_status, execution_status, has_pending_plan, groups: {<group>: {joints {name, position}, end_effector_pose (world), gripper_position, joint_presets {home, init}}}), planning groups (id, joint_names, base_frame, tip_frame, has_gripper), the target shown as the ghost arm, and the plan last made (id, duration, jointNames, times, positions).", json!({}), manipulation_status)
        .endpoint("POST", "api/manipulation/target", "Set the target every open page shows as the ghost arm (it moves nothing): groups (the planning groups selected, default [manipulator]) with joints {name: radians} and/or poses {group: {position [x, y, z], orientation [x, y, z, w], frame (default world)}} (or one pose for the first group), source joints | cartesian (which was edited); or preset current | init | home (that preset's joints for the groups). clear=true removes the target.", json!({ "groups": json!({ "type": "array", "description": "planning group ids" }), "joints": json!({ "type": "object", "description": "joint name -> radians" }), "poses": json!({ "type": "object", "description": "group -> {position, orientation, frame}" }), "pose": json!({ "type": "object", "description": "the first group's pose" }), "source": s("joints | cartesian"), "preset": s("current | init | home"), "clear": b("remove the target") }), manipulation_target)
        .endpoint("POST", "api/manipulation/plan", "Plan from where the arm is to the target (the body's, else the current one), collision-checked by the ManipulationModule: mode joint (default lv.manip.mode) plans to the groups' joints, mode cartesian a straight TCP path to the poses (with the hook; without it plan_to_poses). On success the plan is kept for Preview and Execute and every page draws its path. speed: the plan's speed scale 0.05-1 (default lv.manip.speed).", json!({ "mode": s("joint | cartesian"), "groups": json!({ "type": "array" }), "joints": json!({ "type": "object" }), "poses": json!({ "type": "object" }), "speed": n("0.05-1") }), manipulation_plan)
        .endpoint("POST", "api/manipulation/preview", "Play the kept plan on the ghost arm in every open page (the real arm doesn't move).", json!({}), manipulation_preview)
        .endpoint("POST", "api/manipulation/execute", "Run the kept plan on the arm.", json!({}), manipulation_execute)
        .endpoint("POST", "api/manipulation/cancel", "Stop planning or the running trajectory.", json!({}), manipulation_cancel)
        .endpoint("POST", "api/manipulation/clear", "Discard the kept plan.", json!({}), manipulation_clear)
        .endpoint("GET", "api/manipulation/obstacles", "The planning scene's obstacles: name -> pose.", json!({}), manipulation_obstacles)
        .endpoint("POST", "api/manipulation/evaluate", "Check a target the way viser's panel does, in the planner's process (needs the hook): collision-aware IK for poses, collision and limits for joints. Body: a target (groups, joints or poses, source). Answers success, collision_free, status (FEASIBLE, COLLISION, NO_SOLUTION, INVALID...), message, joints (the IK's for poses), poses (each group's tip for joints).", json!({ "groups": json!({ "type": "array" }), "joints": json!({ "type": "object" }), "poses": json!({ "type": "object" }), "source": s("joints | cartesian") }), manipulation_evaluate)
        .endpoint("GET", "api/manipulation/scene", "What viser draws besides the arm (needs the hook): obstacles with their shapes (box, sphere, cylinder, mesh vertices/faces, octree points), grasp proposals (pose, score; best first), the last preview; each with a version, left out when ?obstacles=&grasps=&preview= already has it. Without the hook: obstacle poses only (type marker).", json!({}), manipulation_scene)
        .endpoint("GET", "api/manipulation/description", "The planner's robot model as dimos.robot_description.v1 (links with visual and collision geometry, joints, base pose), from the hook.", json!({}), manipulation_description)
        .endpoint("GET", "api/manipulation/hook", "dim-controller's hook in the blueprint's process: loaded (its info: pid, python, groups, joint topology) and installed (per running dimos run's venv).", json!({}), manipulation_hook)
        .endpoint("POST", "api/manipulation/hook/install", "Install (uninstall=true: remove) the hook into the venv of every running dimos run, or venv; it loads when the blueprint restarts.", json!({ "venv": s("a venv or its python (default: every running dimos run's)"), "uninstall": b("") }), manipulation_hook_install)
        .endpoint("PATCH", "api/manipulation/options", "The arm 3D view's planner options (lv.manip), applied in every open page: mode (joint | cartesian: what the gizmo and sliders set), speed (next plan's speed scale 0.05-1), display (visual | collision | both: the arm's geometry), obstacles (draw the planning scene's obstacles), grasps (draw the grasp proposals), grid (the ground grid), interact (the 3D arm and gizmo are shown).", json!({ "mode": s("joint | cartesian"), "speed": n("0.05-1"), "display": s("visual | collision | both"), "obstacles": b(""), "grasps": b(""), "grid": b(""), "interact": b("") }), manipulation_options)
        // the page's plumbing: its event socket, its reports, its answers to the backend's capture requests
        .plumbing("POST", "api/pages/{page}", annotations::report_page)
        .plumbing("POST", "api/pages/{page}/close", annotations::close_page)
        .plumbing("POST", "api/captures/{request}", annotations::answer_capture)
        .plumbing("GET", "agent.json", || async { Json(routes().manifest(DESCRIPTION)) })
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
            api.annotations.broadcast(json!({ "type": "manipulation", "target": target, "plan": result["plan"], "planned": result }));
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

/// The planner's robot model (dimos.robot_description.v1) from the hook, for the 3D arm.
async fn manipulation_description(Extract(api): Extract<Api>) -> Response {
    match api.manipulation.hook("robot_description", &Value::Null, std::time::Duration::from_secs(30)).await {
        Ok(description) => Json(description).into_response(),
        Err(error) => error_response(StatusCode::SERVICE_UNAVAILABLE, error),
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

    /// every listed endpoint is routed (a readable JSON answer, never the router's bare 404 / 405), and agent.json is the table
    // the planner endpoints open a zenoh session, which needs the multi-thread runtime
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn every_endpoint_is_routed() {
        let (_api, router) = router();
        let manifest = routes().manifest(DESCRIPTION);
        for endpoint in manifest["endpoints"].as_array().unwrap() {
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
        let (status, served) = call(&router, "GET", "/agent.json", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(served, manifest);
        let roles: Vec<_> = manifest["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["role"].as_str())
            .collect();
        assert_eq!(roles, vec!["context", "view"]);
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
