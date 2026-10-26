//! viser's manipulation workflow for the arm mode's 3D view: target, Plan, Preview, Execute, Cancel, Clear, through
//! dimos's ManipulationModule. Its RPCs are zenoh queries on `dimos/rpc/ManipulationModule/<method>` whose payload is
//! a pickled `(args, kwargs)` and whose reply is pickled too (pickle.rs). The plan last made is kept here so Execute
//! runs exactly that plan, and Preview / a new plan / a new target reach every open page as events.
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use zenoh::query::QueryTarget;

use crate::pickle::{self, Out};
use crate::recorder;

/// The module whose RPCs these are; its instance name in the blueprint.
pub const MODULE: &str = "ManipulationModule";
/// dim-controller's hook in the blueprint's own process (server/python/dim_controller_hook): what the RPCs don't give
/// (the robot model, obstacle shapes, grasp proposals, viser's target check and Cartesian plan), when it is installed.
pub const HOOK: &str = "dim_controller/hook";
const HOOK_TIMEOUT: Duration = Duration::from_secs(2);
/// Planning can take the module's planning_timeout (10 s by default) plus TOPP-RA.
const PLAN_TIMEOUT: Duration = Duration::from_secs(20);
const CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// The trajectory sent to pages: at most this many points (a plan has a few hundred).
const PREVIEW_POINTS: usize = 120;

pub struct Manipulation {
    recorder: Arc<recorder::State>,
    /// the last plan: its id (what Execute runs) and the trajectory the pages preview
    plan: Mutex<Option<Value>>,
    /// the target the pages show as the ghost arm: {group, mode, joints?, pose?}
    target: Mutex<Option<Value>>,
}

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_secs_f64()).unwrap_or_default()
}

/// The error a dimos RPC replied with: its serialized exception (a dict with the type and message).
fn rpc_error(value: &Value) -> String {
    let text = |key: &str| value[key].as_str().map(str::to_string);
    let kind = text("type_name").or_else(|| text("type")).unwrap_or_else(|| "error".into());
    let message = text("message").or_else(|| text("args").or_else(|| value["args"][0].as_str().map(str::to_string))).unwrap_or_else(|| value.to_string());
    format!("{kind}: {message}")
}

impl Manipulation {
    pub fn new(recorder: Arc<recorder::State>) -> Self {
        Manipulation { recorder, plan: Mutex::new(None), target: Mutex::new(None) }
    }

    /// Call `ManipulationModule.<method>(*args, **kwargs)` and decode the reply.
    pub async fn call(&self, method: &str, args: Vec<Out>, kwargs: Vec<(&str, Out)>, timeout: Duration) -> Result<Value> {
        let session = self.recorder.session().await?;
        let replies = session
            .get(format!("dimos/rpc/{MODULE}/{method}"))
            .payload(pickle::rpc_request(args, kwargs))
            .target(QueryTarget::All)
            .timeout(timeout)
            .await
            .map_err(|error| anyhow!("zenoh: {error}"))?;
        match first_answer(&replies).await {
            Some(Ok(bytes)) => Ok(pickle::to_json(&pickle::loads(&bytes)?)),
            Some(Err(bytes)) => {
                let detail = pickle::loads(&bytes).map(|value| rpc_error(&pickle::to_json(&value)));
                bail!("{MODULE}.{method} failed: {}", detail.unwrap_or_else(|_| "an error it couldn't describe".into()))
            }
            None => bail!("no {MODULE} answered {method} (is a manipulation blueprint running?)"),
        }
    }

    /// Ask the hook `name` (JSON in, JSON out). Err when no hook answers (not installed, or dimos changed under it).
    pub async fn hook(&self, name: &str, request: &Value, timeout: Duration) -> Result<Value> {
        let session = self.recorder.session().await?;
        let mut query = session.get(format!("{HOOK}/{name}")).timeout(timeout);
        if !request.is_null() {
            query = query.payload(serde_json::to_vec(request)?);
        }
        let replies = query.target(QueryTarget::All).await.map_err(|error| anyhow!("zenoh: {error}"))?;
        let answer: Value = match first_answer(&replies).await {
            Some(Ok(bytes)) => serde_json::from_slice(&bytes)?,
            Some(Err(bytes)) => bail!("hook {name}: {}", String::from_utf8_lossy(&bytes)),
            None => bail!("no dim-controller hook in the blueprint's process (install it: api/manipulation/hook/install, then restart the blueprint)"),
        };
        if answer["ok"] == true {
            Ok(answer["result"].clone())
        } else {
            bail!("hook {name}: {}", answer["error"].as_str().unwrap_or("failed"))
        }
    }

    /// The planner's state (ManipulationSnapshot as JSON), its planning groups, the hook's info (null without one),
    /// the current target and plan.
    pub async fn status(&self) -> Value {
        let (state, groups, hook) = tokio::join!(
            self.call("get_state", vec![], vec![], CALL_TIMEOUT),
            self.call("list_planning_groups", vec![], vec![], CALL_TIMEOUT),
            self.hook("info", &Value::Null, HOOK_TIMEOUT)
        );
        match state {
            Ok(state) => json!({
                "available": true,
                "state": state,
                "groups": groups.unwrap_or(json!([])),
                "hook": hook.ok(),
                "target": self.target.lock().unwrap().clone(),
                "plan": self.plan.lock().unwrap().clone(),
            }),
            Err(error) => json!({ "available": false, "error": error.to_string() }),
        }
    }

    pub fn set_target(&self, target: Option<Value>) {
        *self.target.lock().unwrap() = target;
    }

    pub fn target(&self) -> Option<Value> {
        self.target.lock().unwrap().clone()
    }

    pub fn plan(&self) -> Option<Value> {
        self.plan.lock().unwrap().clone()
    }

    /// Plan from where the arm is to `target` (`normalize_target`'s shape), the way viser's panel does: `mode` joint
    /// plans to the selected groups' joints (plan_to_joints; with only poses, plan_to_poses solves them); `mode`
    /// cartesian plans a straight TCP path to the poses (the hook's plan_cartesian, else plan_to_poses, which isn't
    /// straight). A successful plan is kept (with a thinned trajectory) for Preview and Execute; a failed one clears
    /// it, as the module does.
    pub async fn plan_to(&self, target: &Value, mode: &str, speed: Option<f64>) -> Result<Value> {
        let groups: Vec<String> = serde_json::from_value(target["groups"].clone()).map_err(|_| anyhow!("a target names its groups"))?;
        let speed = speed.map(|speed| speed.clamp(0.05, 1.0));
        let poses = target["poses"].as_object().filter(|poses| !poses.is_empty());
        let joints = target["joints"].as_object().filter(|joints| !joints.is_empty());
        let result = match (mode, joints, poses) {
            ("joint", Some(joints), _) => {
                let ts = now();
                let mut goals = vec![];
                for group in &groups {
                    let names = self.group_joints(group).await?;
                    let positions = names
                        .iter()
                        .map(|name| joints.get(name).and_then(Value::as_f64).ok_or_else(|| anyhow!("no target for {group}'s {name}")))
                        .collect::<Result<Vec<_>>>()?;
                    goals.push((group.clone(), pickle::joint_state(&names, &positions, ts)));
                }
                self.call("plan_to_joints", vec![Out::Dict(goals)], speed_kwargs(speed), PLAN_TIMEOUT).await?
            }
            ("cartesian", _, Some(poses)) => match self.hook("plan_cartesian", &json!({ "poses": poses, "auxiliary": groups.iter().filter(|group| !poses.contains_key(*group)).collect::<Vec<_>>(), "speed": speed }), PLAN_TIMEOUT).await {
                Ok(result) => result,
                Err(_) => self.plan_to_poses(poses, speed).await?,
            },
            (_, _, Some(poses)) => self.plan_to_poses(poses, speed).await?,
            _ => bail!("{mode} mode needs {}", if mode == "cartesian" { "a pose (drag the gizmo)" } else { "joints" }),
        };
        let succeeded = result["status"]["name"] == "SUCCEEDED";
        let plan = succeeded.then(|| summarize(&result, &groups, mode, target));
        *self.plan.lock().unwrap() = plan.clone();
        Ok(json!({
            "ok": succeeded,
            "status": result["status"]["name"],
            "message": result["message"],
            "plan": plan,
        }))
    }

    async fn plan_to_poses(&self, poses: &serde_json::Map<String, Value>, speed: Option<f64>) -> Result<Value> {
        let ts = now();
        let goals = poses
            .iter()
            .map(|(group, pose)| {
                let position: [f64; 3] = serde_json::from_value(pose["position"].clone()).map_err(|_| anyhow!("{group}'s pose.position is [x, y, z]"))?;
                let orientation: [f64; 4] = serde_json::from_value(pose["orientation"].clone()).map_err(|_| anyhow!("{group}'s pose.orientation is [x, y, z, w]"))?;
                Ok((group.clone(), pickle::pose_stamped(pose["frame"].as_str().unwrap_or("world"), position, orientation, ts)))
            })
            .collect::<Result<Vec<_>>>()?;
        self.call("plan_to_poses", vec![Out::Dict(goals)], speed_kwargs(speed), PLAN_TIMEOUT).await
    }

    /// A planning group's joints, in the planner's order.
    async fn group_joints(&self, group: &str) -> Result<Vec<String>> {
        let groups = self.call("list_planning_groups", vec![], vec![], CALL_TIMEOUT).await?;
        let found = groups.as_array().into_iter().flatten().find(|entry| entry["id"] == group).ok_or_else(|| anyhow!("no planning group {group}"))?;
        Ok(serde_json::from_value(found["joint_names"].clone())?)
    }

    /// Run the kept plan (by its id, so a plan made elsewhere since isn't run instead).
    pub async fn execute(&self) -> Result<Value> {
        let plan_id = self.plan.lock().unwrap().as_ref().and_then(|plan| plan["id"].as_str().map(str::to_string));
        let Some(plan_id) = plan_id else {
            bail!("no plan to execute: Plan first");
        };
        let result = self.call("execute", vec![], vec![("blocking", Out::Bool(false)), ("plan_id", Out::Str(plan_id))], CALL_TIMEOUT).await?;
        Ok(json!({ "ok": matches!(result["status"]["name"].as_str(), Some("ACCEPTED" | "EXECUTING" | "COMPLETED")), "status": result["status"]["name"], "message": result["message"] }))
    }

    pub async fn cancel(&self) -> Result<Value> {
        let result = self.call("cancel", vec![], vec![], CALL_TIMEOUT).await?;
        Ok(json!({ "ok": true, "status": result["status"]["name"], "message": result["message"] }))
    }

    pub async fn clear(&self) -> Result<Value> {
        *self.plan.lock().unwrap() = None;
        let result = self.call("clear_planned_path", vec![], vec![], CALL_TIMEOUT).await?;
        Ok(json!({ "ok": result["status"]["name"] == "SUCCEEDED", "message": result["message"] }))
    }

    /// The planning scene's obstacles: name -> pose (PoseStamped as JSON).
    pub async fn obstacles(&self) -> Result<Value> {
        self.call("get_obstacles", vec![], vec![], CALL_TIMEOUT).await
    }
}

/// The first reply with data among every queryable's (Ok: a sample's payload, Err: an error's), None when all were
/// empty. Queries go to every matching queryable (QueryTarget::All): a zenoh peer that routes (another Desktop app's)
/// can keep advertising a restarted blueprint's queryables and answer a query routed to it alone with nothing.
async fn first_answer(replies: &zenoh::handlers::FifoChannelHandler<zenoh::query::Reply>) -> Option<std::result::Result<Vec<u8>, Vec<u8>>> {
    let mut error = None;
    while let Ok(reply) = replies.recv_async().await {
        match reply.result() {
            Ok(sample) => return Some(Ok(sample.payload().to_bytes().to_vec())),
            Err(failure) => error = Some(Err(failure.payload().to_bytes().to_vec())),
        }
    }
    error
}

fn speed_kwargs(speed: Option<f64>) -> Vec<(&'static str, Out)> {
    speed.map(|speed| vec![("speed_scale", Out::Float(speed))]).unwrap_or_default()
}

/// A target as the server keeps it, viser's panel state: `{groups: [id], joints?: {name: rad}, poses?: {group:
/// {position, orientation, frame}}, source: joints | cartesian (what was edited last), preset?}`. The older
/// one-group shape (`{mode, group, joints | pose}`) is read too.
pub fn normalize_target(body: &Value) -> Option<Value> {
    let groups = match &body["groups"] {
        Value::Array(groups) if !groups.is_empty() => Value::Array(groups.clone()),
        _ => json!([body["group"].as_str().unwrap_or("manipulator")]),
    };
    let mut poses = body["poses"].as_object().cloned().unwrap_or_default();
    if body["pose"].is_object() {
        poses.insert(groups[0].as_str().unwrap_or("manipulator").to_string(), body["pose"].clone());
    }
    let joints = body["joints"].as_object().cloned().unwrap_or_default();
    if joints.is_empty() && poses.is_empty() {
        return None;
    }
    let source = match body["source"].as_str() {
        Some(source) => source,
        None if body["mode"] == "cartesian" || joints.is_empty() => "cartesian",
        None => "joints",
    };
    let mut target = json!({ "groups": groups, "joints": joints, "poses": poses, "source": source });
    if let Some(preset) = body["preset"].as_str() {
        target["preset"] = json!(preset);
    }
    Some(target)
}

/// A plan as the pages use it: id, groups, mode, duration, joint names, and the trajectory thinned to PREVIEW_POINTS
/// (times and positions), plus the target it was planned to.
fn summarize(result: &Value, groups: &[String], mode: &str, target: &Value) -> Value {
    let plan = &result["plan"];
    let trajectory = &plan["trajectory"];
    let points = trajectory["points"].as_array().cloned().unwrap_or_default();
    let step = points.len().div_ceil(PREVIEW_POINTS).max(1);
    let mut kept: Vec<&Value> = points.iter().step_by(step).collect();
    if let Some(last) = points.last() {
        if !std::ptr::eq(*kept.last().unwrap_or(&last), last) {
            kept.push(last);
        }
    }
    json!({
        "id": plan["plan_id"],
        "groups": groups,
        "mode": mode,
        "duration": trajectory["duration"],
        "pathLength": plan["path_length"],
        "planningTime": plan["planning_time"],
        "jointNames": trajectory["joint_names"],
        "times": kept.iter().map(|point| point["time_from_start"].clone()).collect::<Vec<_>>(),
        "positions": kept.iter().map(|point| point["positions"].clone()).collect::<Vec<_>>(),
        "target": target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_old_and_multi_group_targets() {
        // the older one-group body: a pose is the group's, and the edit was cartesian
        let old = normalize_target(&json!({ "mode": "cartesian", "group": "arm", "pose": { "position": [0.1, 0.2, 0.3], "orientation": [0, 0, 0, 1] } })).unwrap();
        assert_eq!(old["groups"], json!(["arm"]));
        assert_eq!(old["poses"]["arm"]["position"], json!([0.1, 0.2, 0.3]));
        assert_eq!(old["source"], "cartesian");
        let joints = normalize_target(&json!({ "mode": "joint", "joints": { "joint1": 0.5 } })).unwrap();
        assert_eq!(joints["groups"], json!(["manipulator"]));
        assert_eq!(joints["source"], "joints");
        // viser's shape: several groups, joints for all, a pose per group with a tip
        let both = normalize_target(&json!({ "groups": ["left", "right"], "joints": { "l1": 0.1, "r1": 0.2 }, "poses": { "left": {}, "right": {} }, "source": "cartesian", "preset": "home" })).unwrap();
        assert_eq!(both["groups"], json!(["left", "right"]));
        assert_eq!(both["source"], "cartesian");
        assert_eq!(both["preset"], "home");
        assert!(normalize_target(&json!({ "groups": ["left"] })).is_none());
    }

    #[test]
    fn summarizes_a_real_plan() {
        let bytes = std::fs::read(format!("{}/src/pickle_fixtures/plan_to_joints.pkl", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let result = pickle::to_json(&pickle::loads(&bytes).unwrap());
        let plan = summarize(&result, &["manipulator".to_string()], "joint", &json!({}));
        assert_eq!(plan["id"], "84a9de8e36c04ece99efcd5d7716bf88");
        let positions = plan["positions"].as_array().unwrap();
        assert!(positions.len() <= PREVIEW_POINTS + 1 && positions.len() > 50);
        assert_eq!(plan["times"].as_array().unwrap().len(), positions.len());
        // the last point is the plan's end, kept even when the thinning skips it
        assert!((plan["positions"].as_array().unwrap().last().unwrap()[0].as_f64().unwrap() - 0.6).abs() < 1e-3);
        assert_eq!(plan["jointNames"][0], "joint1");
    }
}
