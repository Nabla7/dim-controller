//! Location labels: text pinned to a pose in the viewer's fixed (root) frame, made by right-clicking the 3D view. They
//! live for the session here, every open page shows them (the `labels` event on the page event stream), and while a
//! recording runs each add and delete is written into it, as are the labels that exist when it starts:
//! - `/labels`: `dimos.LocationLabel` (JSON): `{timestamp, frame_id, id, label, action, pose: {position, orientation}}`,
//!   the record an analysis tool reads;
//! - `/labels/scene`: `foxglove.SceneUpdate` (JSON), a sphere plus the text, so Foxglove's 3D panel shows them.
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use axum::extract::{Path, State as Extract};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::{Api, Body};
use crate::logs::stamp;
use crate::record::{now_nanos, Encoded, Recorder};

pub const LABEL_TOPIC: &str = "/labels";
pub const SCENE_TOPIC: &str = "/labels/scene";
const SCENE_SCHEMA: &[u8] = include_bytes!("schemas/foxglove.SceneUpdate.json");
const LABEL_SCHEMA: &[u8] = br#"{
  "title": "dimos.LocationLabel",
  "description": "A text label at a pose, made in the Controller (dim-controller) by right-clicking the 3D view. action is add or delete (the id says which).",
  "type": "object",
  "properties": {
    "timestamp": { "type": "object", "properties": { "sec": { "type": "integer" }, "nsec": { "type": "integer" } }, "description": "when it was made" },
    "frame_id": { "type": "string", "description": "the viewer's fixed (root) frame the pose is in" },
    "id": { "type": "string" },
    "label": { "type": "string" },
    "action": { "type": "string", "enum": ["add", "delete"] },
    "pose": { "type": "object", "properties": {
      "position": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "z": { "type": "number" } } },
      "orientation": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "z": { "type": "number" }, "w": { "type": "number" } } }
    } }
  }
}"#;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Label {
    #[serde(default)]
    pub id: String,
    pub label: String,
    /// the frame position and orientation are in: the viewer's fixed frame
    pub frame_id: String,
    pub position: [f64; 3],
    /// quaternion x, y, z, w
    #[serde(default = "identity")]
    pub orientation: [f64; 4],
    /// ns since the epoch
    #[serde(default)]
    pub created: u64,
}

fn identity() -> [f64; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

#[derive(Default)]
pub struct Labels {
    items: Mutex<BTreeMap<String, Label>>,
    next: AtomicU64,
}

impl Labels {
    pub fn list(&self) -> Vec<Label> {
        let mut labels: Vec<Label> = self.items.lock().unwrap().values().cloned().collect();
        labels.sort_by_key(|label| label.created);
        labels
    }

    pub fn create(&self, mut label: Label) -> Result<Label, String> {
        if label.label.trim().is_empty() {
            return Err("a label needs text".into());
        }
        if label.frame_id.trim().is_empty() {
            return Err("a label needs a frame_id".into());
        }
        if !label
            .position
            .iter()
            .chain(label.orientation.iter())
            .all(|value| value.is_finite())
        {
            return Err("position and orientation must be finite".into());
        }
        let mut items = self.items.lock().unwrap();
        if label.id.is_empty() {
            label.id = format!("label-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
            while items.contains_key(&label.id) {
                label.id = format!("label-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
            }
        } else if items.contains_key(&label.id) {
            return Err(format!("id {} is taken", label.id));
        }
        if label.created == 0 {
            label.created = now_nanos();
        }
        items.insert(label.id.clone(), label.clone());
        Ok(label)
    }

    pub fn remove(&self, id: &str) -> Option<Label> {
        self.items.lock().unwrap().remove(id)
    }
}

fn pose(label: &Label) -> Value {
    let [x, y, z] = label.position;
    let [qx, qy, qz, qw] = label.orientation;
    json!({ "position": { "x": x, "y": y, "z": z }, "orientation": { "x": qx, "y": qy, "z": qz, "w": qw } })
}

/// The `/labels` record.
pub fn label_message(label: &Label, action: &str) -> Value {
    json!({ "timestamp": stamp(label.created), "frame_id": label.frame_id, "id": label.id, "label": label.label, "action": action, "pose": pose(label) })
}

/// The `/labels/scene` update: an entity per label (a sphere and its text above), or its deletion.
pub fn scene_update(label: &Label, action: &str, time: u64) -> Value {
    if action == "delete" {
        return json!({ "deletions": [{ "timestamp": stamp(time), "type": 0, "id": label.id }], "entities": [] });
    }
    let color = json!({ "r": 1.0, "g": 0.82, "b": 0.4, "a": 1.0 });
    let mut above = label.clone();
    above.position[2] += 0.3;
    json!({
        "deletions": [],
        "entities": [{
            "timestamp": stamp(label.created), "frame_id": label.frame_id, "id": label.id,
            "lifetime": { "sec": 0, "nsec": 0 }, "frame_locked": true, "metadata": [{ "key": "label", "value": label.label }],
            "arrows": [], "cubes": [], "cylinders": [], "lines": [], "triangles": [], "models": [],
            "spheres": [{ "pose": pose(label), "size": { "x": 0.15, "y": 0.15, "z": 0.15 }, "color": color }],
            "texts": [{ "pose": pose(&above), "billboard": true, "font_size": 14.0, "scale_invariant": true, "color": color, "text": label.label }],
        }],
    })
}

/// Writes one label change into a recording, on both topics.
pub fn write(recorder: &Recorder, label: &Label, action: &str) {
    let time = if action == "add" {
        label.created.max(1)
    } else {
        now_nanos()
    };
    let as_json = |value: Value| serde_json::to_vec(&value).unwrap_or_default();
    let mut message = label_message(label, action);
    // a deletion is stamped when it happened
    message["timestamp"] = stamp(time);
    recorder.write_encoded(
        LABEL_TOPIC,
        Encoded {
            schema_name: "dimos.LocationLabel",
            schema_encoding: "jsonschema",
            schema: LABEL_SCHEMA,
            message_encoding: "json",
            data: as_json(message),
        },
        time,
    );
    recorder.write_encoded(
        SCENE_TOPIC,
        Encoded {
            schema_name: "foxglove.SceneUpdate",
            schema_encoding: "jsonschema",
            schema: SCENE_SCHEMA,
            message_encoding: "json",
            data: as_json(scene_update(label, action, time)),
        },
        time,
    );
}

fn changed(api: &Api) {
    api.annotations
        .broadcast(json!({ "type": "labels", "labels": api.recorder.labels.list() }));
}

fn error(status: StatusCode, message: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": message.to_string() }))).into_response()
}

pub async fn list(Extract(api): Extract<Api>) -> Response {
    Json(json!({ "labels": api.recorder.labels.list() })).into_response()
}

pub async fn add(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    let label: Label = match serde_json::from_value(body) {
        Ok(label) => label,
        Err(problem) => return error(StatusCode::BAD_REQUEST, format!("label: {problem}")),
    };
    match api.recorder.labels.create(label) {
        Ok(label) => {
            let recorded = api.recorder.record_label(&label, "add").await;
            changed(&api);
            Json(json!({ "label": label, "recorded": recorded })).into_response()
        }
        Err(problem) => error(StatusCode::BAD_REQUEST, problem),
    }
}

pub async fn remove(Extract(api): Extract<Api>, Path(id): Path<String>) -> Response {
    match api.recorder.labels.remove(&id) {
        Some(label) => {
            api.recorder.record_label(&label, "delete").await;
            changed(&api);
            Json(json!({ "ok": true, "removed": id })).into_response()
        }
        None => error(StatusCode::NOT_FOUND, format!("no label {id}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_get_ids_and_are_validated() {
        let labels = Labels::default();
        let made = labels
            .create(Label {
                id: String::new(),
                label: "door".into(),
                frame_id: "world".into(),
                position: [1.0, 2.0, 0.0],
                orientation: identity(),
                created: 0,
            })
            .unwrap();
        assert_eq!(made.id, "label-1");
        assert!(made.created > 0);
        assert!(labels
            .create(Label {
                label: " ".into(),
                ..made.clone()
            })
            .is_err());
        assert!(labels
            .create(Label {
                id: String::new(),
                position: [f64::NAN, 0.0, 0.0],
                ..made.clone()
            })
            .is_err());
        assert!(labels.create(made.clone()).is_err(), "taken id");
        assert_eq!(labels.list().len(), 1);
        assert_eq!(labels.remove("label-1"), Some(made));
        assert!(labels.list().is_empty());
    }

    #[test]
    fn scene_updates_carry_the_text_and_deletions() {
        let label = Label {
            id: "label-3".into(),
            label: "stuck here".into(),
            frame_id: "map".into(),
            position: [1.0, 2.0, 0.5],
            orientation: identity(),
            created: 2_500_000_000,
        };
        let update = scene_update(&label, "add", 0);
        let entity = &update["entities"][0];
        assert_eq!(entity["frame_id"], "map");
        assert_eq!(entity["texts"][0]["text"], "stuck here");
        assert_eq!(entity["texts"][0]["pose"]["position"]["z"], 0.8);
        assert_eq!(
            entity["timestamp"],
            json!({ "sec": 2, "nsec": 500_000_000 })
        );
        let removed = scene_update(&label, "delete", 7);
        assert_eq!(removed["deletions"][0]["id"], "label-3");
        let message = label_message(&label, "add");
        assert_eq!(
            message["pose"]["position"],
            json!({ "x": 1.0, "y": 2.0, "z": 0.5 })
        );
        assert_eq!(message["pose"]["orientation"]["w"], 1.0);
    }
}
