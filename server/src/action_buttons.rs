//! Action buttons: this machine's own buttons, each a name and a shell command; a click runs the command (`sh -c`, from
//! the home directory). Kept in `action_buttons.json` in the app's data dir, so they belong to the machine the backend
//! runs on, not to a page. Agents add them (POST api/action_buttons); a page can delete them for good. A change is an
//! `{type: "action_buttons", buttons}` event on the page event stream.
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Path, State as Extract};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::{Api, Body};

/// a command running longer than this is killed
const RUN_TIMEOUT: Duration = Duration::from_secs(120);
/// what's kept of a command's stdout and stderr (each, its tail)
const OUTPUT_KEPT: usize = 8 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub struct ActionButton {
    pub id: String,
    pub label: String,
    pub command: String,
}

struct Store {
    file: Option<PathBuf>,
    buttons: Vec<ActionButton>,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

/// Reads the saved buttons (main.rs, at startup); `file` None keeps them in memory only.
pub fn load(file: Option<PathBuf>) {
    let buttons = file
        .as_ref()
        .and_then(|file| std::fs::read(file).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let _ = STORE.set(Mutex::new(Store { file, buttons }));
}

fn store() -> &'static Mutex<Store> {
    STORE.get_or_init(|| Mutex::new(Store { file: None, buttons: vec![] }))
}

fn save(store: &Store) {
    if let Some(file) = &store.file {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, serde_json::to_vec_pretty(&store.buttons).unwrap_or_default());
    }
}

fn changed(api: &Api, buttons: &[ActionButton]) {
    api.annotations.broadcast(json!({ "type": "action_buttons", "buttons": buttons }));
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

pub async fn list() -> Response {
    Json(json!({ "buttons": store().lock().unwrap().buttons })).into_response()
}

pub async fn add(Extract(api): Extract<Api>, Body(body): Body) -> Response {
    let label = body["label"].as_str().unwrap_or("").trim().to_string();
    let command = body["command"].as_str().unwrap_or("").trim().to_string();
    if label.is_empty() || command.is_empty() {
        return error(StatusCode::BAD_REQUEST, "label and command are required");
    }
    let buttons = {
        let mut store = store().lock().unwrap();
        let mut n = store.buttons.len() + 1;
        while store.buttons.iter().any(|button| button.id == format!("button-{n}")) {
            n += 1;
        }
        store.buttons.push(ActionButton { id: format!("button-{n}"), label, command });
        save(&store);
        store.buttons.clone()
    };
    changed(&api, &buttons);
    Json(json!({ "button": buttons.last(), "buttons": buttons })).into_response()
}

pub async fn delete(Extract(api): Extract<Api>, Path(id): Path<String>) -> Response {
    let buttons = {
        let mut store = store().lock().unwrap();
        let before = store.buttons.len();
        store.buttons.retain(|button| button.id != id);
        if store.buttons.len() == before {
            return error(StatusCode::NOT_FOUND, "no such button");
        }
        save(&store);
        store.buttons.clone()
    };
    changed(&api, &buttons);
    Json(json!({ "ok": true, "removed": id, "buttons": buttons })).into_response()
}

/// the last `OUTPUT_KEPT` bytes, as text
fn tail(bytes: &[u8]) -> String {
    let start = bytes.len().saturating_sub(OUTPUT_KEPT);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

pub async fn run(Path(id): Path<String>) -> Response {
    let Some(button) = store().lock().unwrap().buttons.iter().find(|button| button.id == id).cloned() else {
        return error(StatusCode::NOT_FOUND, "no such button");
    };
    let started = Instant::now();
    let mut command = tokio::process::Command::new("sh");
    command.arg("-c").arg(&button.command).kill_on_drop(true).stdin(std::process::Stdio::null());
    if let Some(home) = std::env::var_os("HOME") {
        command.current_dir(home);
    }
    let output = match tokio::time::timeout(RUN_TIMEOUT, command.output()).await {
        Err(_) => return error(StatusCode::GATEWAY_TIMEOUT, &format!("{} ran over {} s and was stopped", button.label, RUN_TIMEOUT.as_secs())),
        Ok(Err(failed)) => return error(StatusCode::INTERNAL_SERVER_ERROR, &format!("couldn't start sh: {failed}")),
        Ok(Ok(output)) => output,
    };
    Json(json!({
        "id": button.id,
        "label": button.label,
        "exitCode": output.status.code(),
        "ok": output.status.success(),
        "stdout": tail(&output.stdout),
        "stderr": tail(&output.stderr),
        "ms": started.elapsed().as_millis() as u64,
    }))
    .into_response()
}
