//! Controller's planner adapter. Discovery and calls use Desktop's existing gateway.
//! Every request carries the inspected run, module and receiver-issued session.
use std::sync::Mutex;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::desktop;
#[cfg(test)]
use crate::pickle;

const PREVIEW_POINTS: usize = 120;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub run_id: String,
    pub module: String,
    pub session: String,
}

#[derive(Default)]
struct PlannerSession {
    binding: Option<Binding>,
    target: Option<Value>,
    plan: Option<Value>,
    revision: u64,
}

pub struct Manipulation {
    desktop_url: String,
    state: Mutex<PlannerSession>,
}

impl Manipulation {
    pub fn new(desktop_url: String) -> Self {
        Self { desktop_url, state: Mutex::new(PlannerSession::default()) }
    }

    async fn discover(&self) -> Result<(Binding, Vec<Value>)> {
        if self.desktop_url.is_empty() { bail!("Open Controller through DimOS Desktop to select a run"); }
        let active = desktop::get(&self.desktop_url, "/gateways/dimos/active").await?;
        let run_id = active["runId"].as_str().filter(|_| active["running"] == true)
            .ok_or_else(|| anyhow!("No running blueprint selected in Desktop"))?;
        let modules = desktop::get(&self.desktop_url, "/gateways/dimos/active/modules").await?;
        let planners: Vec<_> = modules["modules"].as_array().into_iter().flatten().filter(|module| {
            ["describe_operator", "operator_request"].iter().all(|name|
                module["rpcs"].as_array().into_iter().flatten().any(|rpc| rpc["name"] == *name))
        }).collect();
        if planners.len() != 1 {
            bail!("Selected run exposes {} bound planners; select a run with one operator planner (older engines need the operator API)", planners.len());
        }
        let module = planners[0]["id"].as_str().ok_or_else(|| anyhow!("Planner has no instance ID"))?;
        let info = self.rpc(run_id, module, "describe_operator", json!({})).await?;
        if info["run_id"] != run_id || info["ready"] != true { bail!("Planner does not confirm the selected run or is not ready"); }
        let session = info["session"].as_str().filter(|v| !v.is_empty()).ok_or_else(|| anyhow!("Planner has no session"))?;
        let mut views = Vec::new();
        for provider in modules["modules"].as_array().into_iter().flatten() {
            if provider["rpcs"].as_array().into_iter().flatten().any(|rpc| rpc["name"] == "get_web_views") {
                let id = provider["id"].as_str().ok_or_else(|| anyhow!("View has no module ID"))?;
                let advertised = self.rpc(run_id, id, "get_web_views", json!({})).await?;
                for view in advertised.as_array().into_iter().flatten().filter(|view| view["embed"] == true) {
                    views.push(json!({ "module": id, "title": view["title"], "scheme": view["scheme"], "port": view["port"], "path": view["path"] }));
                }
            }
        }
        Ok((Binding { run_id: run_id.into(), module: module.into(), session: session.into() }, views))
    }

    async fn rpc(&self, run: &str, module: &str, method: &str, kwargs: Value) -> Result<Value> {
        if !module.chars().all(|c| c.is_ascii_alphanumeric() || "_-.:".contains(c)) {
            bail!("Invalid module instance ID");
        }
        let reply = desktop::post(&self.desktop_url,
            &format!("/gateways/dimos/active/modules/{module}/rpcs/{method}"),
            &json!({ "run_id": run, "kwargs": kwargs })).await?;
        if reply["ok"] != true { bail!("{}", reply["error"].as_str().unwrap_or("Planner request failed")); }
        Ok(reply["result"].clone())
    }

    pub async fn call(&self, binding: &Binding, method: &str, payload: Value) -> Result<Value> {
        self.rpc(&binding.run_id, &binding.module, "operator_request",
            json!({ "session": binding.session, "method": method, "payload": payload })).await
    }

    pub fn binding(&self, body: &Value) -> Result<Binding> {
        let binding: Binding = serde_json::from_value(body["binding"].clone())
            .map_err(|_| anyhow!("Include binding from GET api/manipulation; refresh before acting"))?;
        self.check(&self.state.lock().unwrap(), &binding)?;
        Ok(binding)
    }

    fn check(&self, state: &PlannerSession, binding: &Binding) -> Result<()> {
        if state.binding.as_ref() != Some(binding) { bail!("Selected planner changed; refresh before acting"); }
        Ok(())
    }

    pub async fn status(&self) -> Value {
        let result = async {
            let (binding, views) = self.discover().await?;
            let (state, groups) = tokio::try_join!(
                self.call(&binding, "get_state", json!({})),
                self.call(&binding, "list_planning_groups", json!({}))
            )?;
            let mut held = self.state.lock().unwrap();
            if held.binding.as_ref() != Some(&binding) {
                *held = PlannerSession { binding: Some(binding.clone()), revision: held.revision + 1, ..Default::default() };
            }
            Ok::<_, anyhow::Error>(json!({ "available": true, "binding": binding, "state": state,
                "groups": groups, "operator": { "joint_topology": {} },
                "target": held.target, "plan": held.plan, "views": views }))
        }.await;
        match result {
            Ok(status) => status,
            Err(error) => {
                let mut held = self.state.lock().unwrap();
                *held = PlannerSession { revision: held.revision + 1, ..Default::default() };
                json!({ "available": false, "binding": null, "error": error.to_string() })
            }
        }
    }

    pub fn set_target(&self, binding: &Binding, target: Option<Value>) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        self.check(&state, binding)?;
        if state.target != target { state.revision += 1; state.plan = None; }
        state.target = target;
        Ok(())
    }

    pub fn target(&self, binding: &Binding) -> Result<Option<Value>> {
        let state = self.state.lock().unwrap();
        self.check(&state, binding)?;
        Ok(state.target.clone())
    }

    pub fn plan(&self, binding: &Binding, plan_id: &Value) -> Result<Value> {
        let state = self.state.lock().unwrap();
        self.check(&state, binding)?;
        let plan = state.plan.clone().ok_or_else(|| anyhow!("No plan: Plan first"))?;
        if !plan_id.is_string() || plan["id"] != *plan_id { bail!("Plan changed; inspect the current plan before acting"); }
        Ok(plan)
    }

    pub async fn plan_to(&self, binding: &Binding, target: &Value, mode: &str, speed: Option<f64>) -> Result<Value> {
        self.set_target(binding, Some(target.clone()))?;
        let revision = {
            let mut state = self.state.lock().unwrap();
            state.revision += 1;
            state.plan = None;
            state.revision
        };
        let groups: Vec<String> = serde_json::from_value(target["groups"].clone())?;
        let poses = target["poses"].as_object().filter(|v| !v.is_empty());
        let joints = target["joints"].as_object().filter(|v| !v.is_empty());
        let result = match (mode, joints, poses) {
            ("joint", Some(joints), _) => {
                let definitions = self.call(binding, "list_planning_groups", json!({})).await?;
                let mut targets = serde_json::Map::new();
                for group in &groups {
                    let definition = definitions.as_array().into_iter().flatten().find(|g| g["id"] == *group)
                        .ok_or_else(|| anyhow!("Unknown planning group {group}"))?;
                    let names: Vec<String> = serde_json::from_value(definition["joint_names"].clone())?;
                    let mut values = serde_json::Map::new();
                    for name in names {
                        let value = joints.get(&name).and_then(Value::as_f64).ok_or_else(|| anyhow!("Missing joint {name}"))?;
                        values.insert(name, json!(value));
                    }
                    targets.insert(group.clone(), Value::Object(values));
                }
                self.call(binding, "plan_to_joints", json!({ "targets": targets, "speed": speed })).await?
            }
            ("cartesian", _, Some(poses)) => self.call(binding, "plan_cartesian", json!({ "poses": poses,
                "auxiliary": groups.iter().filter(|g| !poses.contains_key(*g)).collect::<Vec<_>>(), "speed": speed })).await?,
            (_, _, Some(poses)) => self.call(binding, "plan_to_poses", json!({ "targets": poses, "speed": speed })).await?,
            _ => bail!("{mode} mode needs a joint or pose target"),
        };
        let succeeded = result["status"]["name"] == "SUCCEEDED";
        let plan = succeeded.then(|| summarize(&result, &groups, mode, target));
        let mut state = self.state.lock().unwrap();
        self.check(&state, binding)?;
        if state.revision != revision { bail!("Target or plan changed while planning; request a new plan"); }
        state.plan = plan.clone();
        Ok(json!({ "ok": succeeded, "status": result["status"]["name"], "message": result["message"], "plan": plan, "binding": binding }))
    }

    pub async fn execute(&self, binding: &Binding, plan_id: &Value) -> Result<Value> {
        let plan = self.plan(binding, plan_id)?;
        let result = self.call(binding, "execute", json!({ "plan_id": plan["id"] })).await?;
        Ok(json!({ "ok": matches!(result["status"]["name"].as_str(), Some("ACCEPTED" | "EXECUTING" | "COMPLETED")), "status": result["status"]["name"], "message": result["message"] }))
    }

    pub async fn cancel(&self, binding: &Binding) -> Result<Value> {
        self.invalidate_plan(binding)?;
        let result = self.call(binding, "cancel", json!({})).await?;
        Ok(json!({ "ok": !matches!(result["status"]["name"].as_str(), Some("UNCERTAIN" | "FAULT")), "status": result["status"]["name"], "message": result["message"] }))
    }

    fn invalidate_plan(&self, binding: &Binding) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        self.check(&state, binding)?;
        state.revision += 1;
        state.plan = None;
        Ok(())
    }

    pub async fn clear(&self, binding: &Binding) -> Result<Value> {
        self.invalidate_plan(binding)?;
        let result = self.call(binding, "clear_planned_path", json!({})).await?;
        Ok(json!({ "ok": result["status"]["name"] == "SUCCEEDED", "message": result["message"] }))
    }
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

    #[tokio::test]
    async fn discovered_binding_guards_gateway_calls_and_cached_plans() {
        use axum::{extract::{Path, State}, routing::{get, post}, Json, Router};
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        let changed = Arc::new(AtomicBool::new(false));
        let app = Router::new()
            .route("/gateways/dimos/active", get(|State(changed): State<Arc<AtomicBool>>| async move {
                Json(json!({ "running": true, "runId": if changed.load(Ordering::SeqCst) { "new-run" } else { "run" } }))
            }))
            .route("/gateways/dimos/active/modules", get(|| async { Json(json!({ "modules": [{
                "id": "planner:left", "rpcs": [{"name": "describe_operator"}, {"name": "operator_request"}]
            }] })) }))
            .route("/gateways/dimos/active/modules/{module}/rpcs/{method}", post(|State(changed): State<Arc<AtomicBool>>, Path((module, method)): Path<(String, String)>, Json(body): Json<Value>| async move {
                assert_eq!(module, "planner:left");
                let run = if changed.load(Ordering::SeqCst) { "new-run" } else { "run" };
                if body["run_id"] != run { return Json(json!({ "ok": false, "error": "Run changed" })); }
                let result = if method == "describe_operator" {
                    json!({ "run_id": run, "session": format!("{run}-session"), "ready": true })
                } else {
                    assert_eq!(body["kwargs"]["session"], format!("{run}-session"));
                    match body["kwargs"]["method"].as_str().unwrap() {
                        "list_planning_groups" => json!([]),
                        "get_state" => json!({}),
                        "execute" => json!({ "status": {"name": "ACCEPTED"}, "message": "" }),
                        method => panic!("unexpected method {method}"),
                    }
                };
                Json(json!({ "ok": true, "result": result }))
            })).with_state(changed.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = Manipulation::new(format!("http://{address}"));
        let status = client.status().await;
        assert_eq!(status["available"], true, "{status}");
        let binding = client.binding(&status).unwrap();
        client.state.lock().unwrap().plan = Some(json!({ "id": "inspected-plan" }));
        assert!(client.execute(&binding, &json!("other-plan")).await.is_err());
        assert_eq!(client.execute(&binding, &json!("inspected-plan")).await.unwrap()["ok"], true);
        changed.store(true, Ordering::SeqCst);
        assert!(client.execute(&binding, &json!("inspected-plan")).await.unwrap_err().to_string().contains("Run changed"));
        let next = client.status().await;
        assert_eq!(next["binding"]["run_id"], "new-run");
        assert_eq!(next["plan"], Value::Null);
        assert!(client.binding(&status).is_err());
        assert!(client.plan(&binding, &json!("inspected-plan")).is_err());
        server.abort();
    }

    #[test]
    fn target_changes_invalidate_inspected_plan() {
        let client = Manipulation::new(String::new());
        let binding = Binding { run_id: "run".into(), module: "arm".into(), session: "session".into() };
        *client.state.lock().unwrap() = PlannerSession { binding: Some(binding.clone()), plan: Some(json!({"id": "p"})), ..Default::default() };
        client.set_target(&binding, Some(json!({"joints": {"left1": 0.2}}))).unwrap();
        assert!(client.plan(&binding, &json!("p")).is_err());
    }

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
