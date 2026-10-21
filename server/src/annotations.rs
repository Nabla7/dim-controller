//! Live annotations and the agent's view of the viewer. Annotations are ephemeral 3D boxes with labels (not zenoh
//! topics): kept here, and every change is pushed to the pages on zenoh (frontend.rs: the frontend topic `events`; a page
//! GETs api/annotations on load and when its zenoh-gateway connection comes back). The page also answers capture requests
//! that arrive the same way (its 3D view, the camera image, locating an object from an image box), since only the page
//! has the rendered view, the decoded clouds and the TF tree: a capture event names the page it's for (the one the user
//! looked at last; pages report themselves with POST api/pages/{page} every few seconds), and the page answers with
//! POST api/captures/{request}. The routes are in api.rs.
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State as Extract};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::api::Body;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Annotation {
    pub id: String,
    pub label: String,
    /// box center, meters in `frame`
    pub center: [f64; 3],
    /// full extents along the box's x, y, z
    pub size: [f64; 3],
    /// radians about +z
    #[serde(default)]
    pub yaw: f64,
    /// the TF frame it is in (default: the page's fixed frame, "world" in dimos)
    #[serde(default = "world")]
    pub frame: String,
    /// CSS color, e.g. "#ffd166"
    #[serde(default)]
    pub color: Option<String>,
    /// extra lines under the label, e.g. "1.76 m tall"
    #[serde(default)]
    pub note: Option<String>,
}

fn world() -> String {
    "world".into()
}

/// A page (a viewer tab) and when its user last looked at it.
#[derive(Clone, Debug, Serialize)]
pub struct Page {
    visible: bool,
    #[serde(rename = "lastActive")]
    last_active: u64,
    /// the page's last report (it reports every few seconds while open)
    #[serde(skip)]
    seen: u64,
}

/// A page not heard from for this long is gone (closed, crashed, asleep).
const PAGE_TTL_MS: u64 = 15_000;

pub struct Annotations {
    items: Mutex<BTreeMap<String, Annotation>>,
    next: AtomicU64,
    pub events: broadcast::Sender<Value>,
    pages: Mutex<HashMap<String, Page>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl Default for Annotations {
    fn default() -> Self {
        Annotations {
            items: Mutex::default(),
            next: AtomicU64::new(1),
            events: broadcast::channel(256).0,
            pages: Mutex::default(),
            pending: Mutex::default(),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Fields an update may change; anything left out stays.
#[derive(Deserialize, Default)]
pub struct Patch {
    label: Option<String>,
    center: Option<[f64; 3]>,
    size: Option<[f64; 3]>,
    yaw: Option<f64>,
    frame: Option<String>,
    color: Option<String>,
    note: Option<String>,
    /// rename: the annotation's new id
    id: Option<String>,
}

impl Annotations {
    pub fn list(&self) -> Vec<Annotation> {
        self.items.lock().unwrap().values().cloned().collect()
    }

    pub fn page_count(&self) -> usize {
        self.live_pages().len()
    }

    /// The pages heard from lately (the others are dropped).
    fn live_pages(&self) -> std::sync::MutexGuard<'_, HashMap<String, Page>> {
        let mut pages = self.pages.lock().unwrap();
        let now = now_ms();
        pages.retain(|_, page| now.saturating_sub(page.seen) < PAGE_TTL_MS);
        pages
    }

    /// Sends an event to every open page (frontend.rs publishes it on the frontend topic `events`).
    pub fn broadcast(&self, event: Value) {
        let _ = self.events.send(event);
    }

    fn changed(&self) {
        let _ = self
            .events
            .send(json!({ "type": "annotations", "annotations": self.list() }));
    }

    /// Adds one; a missing id becomes "box-<n>", a taken id is an error.
    pub fn create(&self, mut annotation: Value) -> Result<Annotation, String> {
        if annotation
            .get("id")
            .is_none_or(|id| id.as_str().is_none_or(str::is_empty))
        {
            let items = self.items.lock().unwrap();
            let mut id = format!("box-{}", self.next.fetch_add(1, Ordering::Relaxed));
            while items.contains_key(&id) {
                id = format!("box-{}", self.next.fetch_add(1, Ordering::Relaxed));
            }
            annotation["id"] = json!(id);
        }
        if annotation.get("label").is_none() {
            annotation["label"] = json!("");
        }
        let annotation: Annotation =
            serde_json::from_value(annotation).map_err(|e| format!("bad annotation: {e}"))?;
        validate(&annotation)?;
        {
            let mut items = self.items.lock().unwrap();
            if items.contains_key(&annotation.id) {
                return Err(format!("id {} is taken (PATCH it instead)", annotation.id));
            }
            items.insert(annotation.id.clone(), annotation.clone());
        }
        self.changed();
        Ok(annotation)
    }

    pub fn update(&self, id: &str, patch: Patch) -> Result<Annotation, String> {
        let updated = {
            let mut items = self.items.lock().unwrap();
            let mut annotation = items
                .get(id)
                .cloned()
                .ok_or_else(|| format!("no annotation {id}"))?;
            if let Some(label) = patch.label {
                annotation.label = label;
            }
            if let Some(center) = patch.center {
                annotation.center = center;
            }
            if let Some(size) = patch.size {
                annotation.size = size;
            }
            if let Some(yaw) = patch.yaw {
                annotation.yaw = yaw;
            }
            if let Some(frame) = patch.frame {
                annotation.frame = frame;
            }
            if let Some(color) = patch.color {
                annotation.color = Some(color).filter(|c| !c.is_empty());
            }
            if let Some(note) = patch.note {
                annotation.note = Some(note).filter(|n| !n.is_empty());
            }
            if let Some(new_id) = patch.id.filter(|new_id| new_id != id) {
                if items.contains_key(&new_id) {
                    return Err(format!("id {new_id} is taken"));
                }
                annotation.id = new_id;
            }
            validate(&annotation)?;
            items.remove(id);
            items.insert(annotation.id.clone(), annotation.clone());
            annotation
        };
        self.changed();
        Ok(updated)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.items
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| format!("no annotation {id}"))?;
        self.changed();
        Ok(())
    }

    pub fn clear(&self) -> usize {
        let count = std::mem::take(&mut *self.items.lock().unwrap()).len();
        self.changed();
        count
    }

    /// The page the user looked at last (a visible one wins).
    fn active_page(&self) -> Option<String> {
        let pages = self.live_pages();
        pages
            .iter()
            .max_by_key(|(_, page)| (page.visible, page.last_active))
            .map(|(id, _)| id.clone())
    }

    /// Asks the active page to do something only it can (render, read the camera, locate) and waits for its answer.
    pub async fn ask_page(&self, kind: &str, args: Value) -> Result<Value, String> {
        let page = self
            .active_page()
            .ok_or("no Controller page is open (open_app the Controller first)")?;
        let request = format!("r{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(request.clone(), sender);
        let _ = self.events.send(json!({ "type": "capture", "page": page, "request": request, "kind": kind, "args": args }));
        let answer = tokio::time::timeout(Duration::from_secs(15), receiver).await;
        self.pending.lock().unwrap().remove(&request);
        match answer {
            Ok(Ok(value)) => match value.get("error").and_then(Value::as_str) {
                Some(error) => Err(error.to_string()),
                None => Ok(value),
            },
            _ => Err("the Controller page didn't answer (is its tab open?)".into()),
        }
    }
}

fn validate(annotation: &Annotation) -> Result<(), String> {
    if annotation.id.is_empty()
        || annotation.id.len() > 64
        || annotation.id.contains(['/', '?', '#'])
    {
        return Err("id: 1-64 characters, no / ? #".into());
    }
    if annotation.size.iter().any(|s| !s.is_finite() || *s <= 0.0)
        || annotation.center.iter().any(|c| !c.is_finite())
    {
        return Err("center must be finite and size > 0".into());
    }
    Ok(())
}

fn error(status: StatusCode, message: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": message.to_string() }))).into_response()
}

#[derive(Deserialize)]
pub struct PageReport {
    visible: bool,
    #[serde(default)]
    active: bool,
}

pub async fn list_annotations(Extract(state): Extract<Arc<Annotations>>) -> Response {
    Json(json!({ "annotations": state.list() })).into_response()
}

pub async fn add_annotation(
    Extract(state): Extract<Arc<Annotations>>,
    Body(body): Body,
) -> Response {
    match state.create(body) {
        Ok(annotation) => Json(annotation).into_response(),
        Err(problem) => error(StatusCode::BAD_REQUEST, problem),
    }
}

pub async fn clear_annotations(Extract(state): Extract<Arc<Annotations>>) -> Response {
    Json(json!({ "removed": state.clear() })).into_response()
}

pub async fn patch_annotation(
    Extract(state): Extract<Arc<Annotations>>,
    Path(id): Path<String>,
    Body(body): Body,
) -> Response {
    let mut body = body;
    if let Some(new_id) = body.get("newId").cloned() {
        body["id"] = new_id;
    } else if let Some(object) = body.as_object_mut() {
        object.remove("id");
    }
    let patch: Patch = match serde_json::from_value(body) {
        Ok(patch) => patch,
        Err(problem) => return error(StatusCode::BAD_REQUEST, problem),
    };
    match state.update(&id, patch) {
        Ok(annotation) => Json(annotation).into_response(),
        Err(problem) => error(StatusCode::NOT_FOUND, problem),
    }
}

pub async fn delete_annotation(
    Extract(state): Extract<Arc<Annotations>>,
    Path(id): Path<String>,
) -> Response {
    match state.delete(&id) {
        Ok(()) => Json(json!({ "ok": true, "removed": id })).into_response(),
        Err(problem) => error(StatusCode::NOT_FOUND, problem),
    }
}

/// A page says it's visible / the one the user is using (it answers the agent's captures).
pub async fn report_page(
    Extract(state): Extract<Arc<Annotations>>,
    Path(page): Path<String>,
    Json(report): Json<PageReport>,
) -> Response {
    let mut pages = state.pages.lock().unwrap();
    let now = now_ms();
    let entry = pages.entry(page).or_insert(Page {
        visible: report.visible,
        last_active: 0,
        seen: now,
    });
    entry.visible = report.visible;
    entry.seen = now;
    if report.active {
        entry.last_active = now;
    }
    Json(json!({ "ok": true })).into_response()
}

/// A page is going away (`navigator.sendBeacon` on pagehide).
pub async fn close_page(
    Extract(state): Extract<Arc<Annotations>>,
    Path(page): Path<String>,
) -> Response {
    state.pages.lock().unwrap().remove(&page);
    Json(json!({ "ok": true })).into_response()
}

/// A page answering a capture request.
pub async fn answer_capture(
    Extract(state): Extract<Arc<Annotations>>,
    Path(request): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    match state.pending.lock().unwrap().remove(&request) {
        Some(sender) => {
            let _ = sender.send(body);
            Json(json!({ "ok": true })).into_response()
        }
        None => error(
            StatusCode::NOT_FOUND,
            "no such capture request (timed out?)",
        ),
    }
}

pub async fn view(Extract(state): Extract<Arc<Annotations>>) -> Response {
    match state.ask_page("view", json!({})).await {
        Ok(view) => Json(view).into_response(),
        Err(problem) => error(StatusCode::SERVICE_UNAVAILABLE, problem),
    }
}

pub async fn locate(Extract(state): Extract<Arc<Annotations>>, Body(body): Body) -> Response {
    let bbox_ok = body["bbox"]
        .as_array()
        .is_some_and(|b| b.len() == 4 && b.iter().all(Value::is_number));
    if !bbox_ok {
        return error(
            StatusCode::BAD_REQUEST,
            "bbox: [x1, y1, x2, y2] in camera image pixels",
        );
    }
    let found = match state.ask_page("locate", body.clone()).await {
        Ok(found) => found,
        Err(problem) => return error(StatusCode::UNPROCESSABLE_ENTITY, problem),
    };
    if body["add"].as_bool() != Some(true) {
        return Json(found).into_response();
    }
    let mut annotation = found["box"].clone();
    annotation["label"] = body.get("label").cloned().unwrap_or(json!(""));
    if let Some(id) = body.get("id") {
        annotation["id"] = id.clone();
    }
    match state.create(annotation) {
        Ok(added) => Json(json!({ "located": found, "annotation": added })).into_response(),
        Err(problem) => error(StatusCode::BAD_REQUEST, problem),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_update_rename_delete() {
        let annotations = Annotations::default();
        let mut events = annotations.events.subscribe();
        let first = annotations
            .create(json!({ "label": "person", "center": [1, 2, 0.9], "size": [0.6, 0.5, 1.8] }))
            .unwrap();
        assert_eq!(first.id, "box-1");
        assert_eq!(first.frame, "world");
        let event = events.try_recv().unwrap();
        assert_eq!(event["annotations"][0]["label"], "person");
        assert!(annotations
            .create(json!({ "id": "box-1", "center": [0, 0, 0], "size": [1, 1, 1] }))
            .is_err());
        assert!(annotations
            .create(json!({ "center": [0, 0, 0], "size": [0, 1, 1] }))
            .is_err());
        let patched = annotations
            .update(
                "box-1",
                Patch {
                    note: Some("1.76 m tall".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(patched.note.as_deref(), Some("1.76 m tall"));
        let renamed = annotations
            .update(
                "box-1",
                Patch {
                    id: Some("person-1".into()),
                    label: Some("Jeong".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            (renamed.id.as_str(), renamed.label.as_str()),
            ("person-1", "Jeong")
        );
        assert_eq!(annotations.list().len(), 1);
        assert!(annotations.delete("box-1").is_err());
        annotations.delete("person-1").unwrap();
        assert!(annotations.list().is_empty());
    }

    #[tokio::test]
    async fn the_active_page_answers_captures() {
        let annotations = Arc::new(Annotations::default());
        assert!(annotations.ask_page("view", json!({})).await.is_err());
        let now = now_ms();
        annotations.pages.lock().unwrap().insert(
            "p1".into(),
            Page {
                visible: true,
                last_active: 1,
                seen: now,
            },
        );
        annotations.pages.lock().unwrap().insert(
            "p2".into(),
            Page {
                visible: true,
                last_active: 2,
                seen: now,
            },
        );
        annotations.pages.lock().unwrap().insert(
            "gone".into(),
            Page {
                visible: true,
                last_active: 3,
                seen: now - PAGE_TTL_MS,
            },
        );
        let mut events = annotations.events.subscribe();
        let asking = annotations.clone();
        let task = tokio::spawn(async move { asking.ask_page("view", json!({})).await });
        let request = events.recv().await.unwrap();
        assert_eq!(request["page"], "p2");
        let sender = annotations
            .pending
            .lock()
            .unwrap()
            .remove(request["request"].as_str().unwrap())
            .unwrap();
        sender.send(json!({ "camera": { "fov": 60 } })).unwrap();
        assert_eq!(task.await.unwrap().unwrap()["camera"]["fov"], 60);
    }

    /// Pages register by reporting (api/pages/{page}), are dropped by api/pages/{page}/close or after PAGE_TTL_MS of
    /// silence; only reports with active=true make a page the one the user looked at last.
    #[tokio::test(flavor = "multi_thread")]
    async fn pages_report_and_close_over_http() {
        use tower::ServiceExt;
        let annotations = Arc::new(Annotations::default());
        let app = crate::api::routes()
            .router
            .with_state(crate::api::Api::for_tests(annotations.clone()));
        let post = |path: &str, body: &str| {
            axum::http::Request::post(path)
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap()
        };
        app.clone()
            .oneshot(post("/api/pages/p1", r#"{"visible":true,"active":true}"#))
            .await
            .unwrap();
        app.clone()
            .oneshot(post("/api/pages/p2", r#"{"visible":true,"active":false}"#))
            .await
            .unwrap();
        assert_eq!(annotations.page_count(), 2);
        assert_eq!(annotations.active_page().as_deref(), Some("p1"));
        app.clone()
            .oneshot(post("/api/pages/p1/close", ""))
            .await
            .unwrap();
        assert_eq!(annotations.page_count(), 1);
        annotations
            .pages
            .lock()
            .unwrap()
            .get_mut("p2")
            .unwrap()
            .seen -= PAGE_TTL_MS;
        assert_eq!(annotations.page_count(), 0);
    }
}
