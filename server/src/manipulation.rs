//! viser's manipulation workflow for the arm mode's 3D view: target, Plan, Preview, Execute, Cancel, Clear, through
//! dimos's ManipulationModule. Its RPCs are zenoh queries on `dimos/rpc/ManipulationModule/<method>` whose payload is
//! a pickled `(args, kwargs)` and whose reply is pickled too (pickle.rs). The plan last made is kept here so Execute
//! runs exactly that plan, and Preview / a new plan / a new target reach every open page as events.
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use crate::pickle::{self, Out};
use crate::recorder;

/// The module whose RPCs these are; its instance name in the blueprint.
pub const MODULE: &str = "ManipulationModule";
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
            .timeout(timeout)
            .await
            .map_err(|error| anyhow!("zenoh: {error}"))?;
        let Ok(reply) = replies.recv_async().await else {
            bail!("no {MODULE} answered {method} (is a manipulation blueprint running?)");
        };
        match reply.result() {
            Ok(sample) => Ok(pickle::to_json(&pickle::loads(&sample.payload().to_bytes())?)),
            Err(error) => {
                let detail = pickle::loads(&error.payload().to_bytes()).map(|value| rpc_error(&pickle::to_json(&value)));
                bail!("{MODULE}.{method} failed: {}", detail.unwrap_or_else(|_| "an error it couldn't describe".into()))
            }
        }
    }

    /// The planner's state (ManipulationSnapshot as JSON), its planning groups, the current target and plan.
    pub async fn status(&self) -> Value {
        let (state, groups) = tokio::join!(
            self.call("get_state", vec![], vec![], CALL_TIMEOUT),
            self.call("list_planning_groups", vec![], vec![], CALL_TIMEOUT)
        );
        match state {
            Ok(state) => json!({
                "available": true,
                "state": state,
                "groups": groups.unwrap_or(json!([])),
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

    /// Plan to a target: `{mode: "joint", group, joints: {name: rad}}` or `{mode: "cartesian", group, pose: {position,
    /// orientation, frame}}`. A successful plan is kept (with a thinned trajectory) for Preview and Execute; a failed one
    /// clears it, as the module does.
    pub async fn plan_to(&self, target: &Value, speed: Option<f64>) -> Result<Value> {
        let group = target["group"].as_str().unwrap_or("manipulator").to_string();
        let ts = now();
        let goal = match target["mode"].as_str().unwrap_or("joint") {
            "joint" => {
                let joints = target["joints"].as_object().ok_or_else(|| anyhow!("joint mode needs joints {{name: radians}}"))?;
                let names: Vec<String> = joints.keys().cloned().collect();
                let positions = joints.values().map(|value| value.as_f64().ok_or_else(|| anyhow!("joint positions are numbers"))).collect::<Result<Vec<_>>>()?;
                pickle::joint_state(&names, &positions, ts)
            }
            "cartesian" => {
                let pose = &target["pose"];
                let position: [f64; 3] = serde_json::from_value(pose["position"].clone()).map_err(|_| anyhow!("cartesian mode needs pose.position [x, y, z]"))?;
                let orientation: [f64; 4] = serde_json::from_value(pose["orientation"].clone()).map_err(|_| anyhow!("cartesian mode needs pose.orientation [x, y, z, w]"))?;
                pickle::pose_stamped(pose["frame"].as_str().unwrap_or("world"), position, orientation, ts)
            }
            other => bail!("mode is joint or cartesian, not {other}"),
        };
        let method = if target["mode"] == "cartesian" { "plan_to_poses" } else { "plan_to_joints" };
        let kwargs = match speed {
            Some(speed) => vec![("speed_scale", Out::Float(speed.clamp(0.05, 1.0)))],
            None => vec![],
        };
        let result = self.call(method, vec![Out::Dict(vec![(group.clone(), goal)])], kwargs, PLAN_TIMEOUT).await?;
        let succeeded = result["status"]["name"] == "SUCCEEDED";
        let plan = succeeded.then(|| summarize(&result, &group, target));
        *self.plan.lock().unwrap() = plan.clone();
        Ok(json!({
            "ok": succeeded,
            "status": result["status"]["name"],
            "message": result["message"],
            "plan": plan,
        }))
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

/// A plan as the pages use it: id, group, duration, joint names, and the trajectory thinned to PREVIEW_POINTS
/// (times and positions), plus the target it was planned to.
fn summarize(result: &Value, group: &str, target: &Value) -> Value {
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
        "group": group,
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
    fn summarizes_a_real_plan() {
        let bytes = std::fs::read(format!("{}/src/pickle_fixtures/plan_to_joints.pkl", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let result = pickle::to_json(&pickle::loads(&bytes).unwrap());
        let plan = summarize(&result, "manipulator", &json!({ "mode": "joint" }));
        assert_eq!(plan["id"], "84a9de8e36c04ece99efcd5d7716bf88");
        let positions = plan["positions"].as_array().unwrap();
        assert!(positions.len() <= PREVIEW_POINTS + 1 && positions.len() > 50);
        assert_eq!(plan["times"].as_array().unwrap().len(), positions.len());
        // the last point is the plan's end, kept even when the thinning skips it
        assert!((plan["positions"].as_array().unwrap().last().unwrap()[0].as_f64().unwrap() - 0.6).abs() < 1e-3);
        assert_eq!(plan["jointNames"][0], "joint1");
    }
}
