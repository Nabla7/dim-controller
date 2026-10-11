//! The recorder and its zenoh side (routes in api.rs). A start names its keys, or leaves them out: then the topics on
//! the bus now are found here (liveliness tokens and a short listen, as Desktop's /api/topics does) minus rpc topics and
//! the ones unticked in the recorder panel (the `lv.record.topics` setting), and while it runs, new ones join (unless
//! `lv.record.options.recordNew` is off) and dimos runs that start later bring their log dirs (Desktop's /dimos/runs).
//! While a recording runs this process subscribes to exactly the recorded keys, so an idle recorder costs no bandwidth;
//! the stream meter (`GET api/recorder/streams`, each key's bytes/s) listens to everything only while someone asks.
//! The recorder's options (format, compression, folder, logs, per-stream max rates) are the `lv.record.options`
//! setting (`Options`), so they survive a restart and every page shows the same ones.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, State as Extract};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::image::ImageFormat;
use crate::labels::{self, Labels};
use crate::logs::LogTailer;
use crate::record::{self, Compression, Recorder};
use crate::settings::Settings as Store;

/// The setting key the recorder's options live under.
pub const OPTIONS_KEY: &str = "lv.record.options";

#[derive(Clone, Copy, Serialize, Deserialize, Debug, Default)]
pub struct Settings {
    pub compression: Compression,
    pub image_format: ImageFormat,
}

/// The recorder's options, read leniently from `lv.record.options`: a field that's missing or not understood takes
/// its default rather than throwing the rest away.
#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Options {
    /// topics that appear mid-recording join it
    #[serde(rename = "recordNew")]
    pub record_new: bool,
    pub compression: Compression,
    pub image_format: ImageFormat,
    /// "" = the default folder (Desktop's shared recordings folder)
    pub directory: String,
    /// the running dimos's jsonl logs go in too
    pub logs: bool,
    /// key → at most this many messages per second (the rest are skipped); absent or 0 = every message
    pub rates: BTreeMap<String, f64>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            record_new: true,
            compression: Compression::None,
            image_format: ImageFormat::Raw,
            directory: String::new(),
            logs: true,
            rates: BTreeMap::new(),
        }
    }
}

impl Options {
    pub fn from_value(value: &Value) -> Options {
        let defaults = Options::default();
        fn parse<T: serde::de::DeserializeOwned>(value: &Value, field: &str) -> Option<T> {
            serde_json::from_value(value[field].clone()).ok()
        }
        Options {
            record_new: value["recordNew"].as_bool().unwrap_or(defaults.record_new),
            compression: parse(value, "compression").unwrap_or(defaults.compression),
            image_format: parse(value, "image_format").unwrap_or(defaults.image_format),
            directory: value["directory"]
                .as_str()
                .map(|directory| directory.trim().to_string())
                .unwrap_or_default(),
            logs: value["logs"].as_bool().unwrap_or(defaults.logs),
            rates: value["rates"]
                .as_object()
                .map(|rates| {
                    rates
                        .iter()
                        .filter_map(|(key, hz)| Some((key.clone(), hz.as_f64()?)))
                        .filter(|(_, hz)| hz.is_finite() && *hz > 0.0)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    pub fn load(store: &Store) -> Options {
        store.read(OPTIONS_KEY, Options::from_value)
    }
}

/// The most messages per second `key` is recorded at (None = every message).
fn max_rate(store: &Store, key: &str) -> Option<f64> {
    store.read(OPTIONS_KEY, |options| {
        options["rates"][key]
            .as_f64()
            .filter(|hz| hz.is_finite() && *hz > 0.0)
    })
}

/// Keeps a stream to `max_hz` on average: each message let through books the next slot 1/max_hz later (with a fifth
/// of that as slack, so a 10 Hz source kept to 10 Hz loses nothing to jitter); a long gap starts the schedule over.
#[derive(Default)]
pub struct Throttle {
    next_ns: AtomicU64,
}

impl Throttle {
    pub fn admit(&self, now_ns: u64, max_hz: Option<f64>) -> bool {
        let Some(hz) = max_hz else {
            return true;
        };
        let gap = (1e9 / hz) as u64;
        let next = self.next_ns.load(Ordering::Relaxed);
        if now_ns.saturating_add(gap / 5) < next {
            return false;
        }
        let booked = if now_ns.saturating_sub(next) > gap {
            now_ns + gap
        } else {
            next + gap
        };
        self.next_ns.store(booked, Ordering::Relaxed);
        true
    }
}

/// Each key's traffic on the bus, measured while someone looks (the recorder popover): bytes and messages per second.
struct Meter {
    subscriber: zenoh::pubsub::Subscriber<()>,
    /// key → (bytes, messages) since the last tick
    counts: Arc<Mutex<HashMap<String, (u64, u64)>>>,
    /// key → (bytes/s, messages/s), smoothed
    rates: Arc<Mutex<HashMap<String, (f64, f64)>>>,
    asked: Arc<Mutex<Instant>>,
    started: Instant,
}

/// A meter nobody asked for in this long stops listening.
const METER_IDLE: Duration = Duration::from_secs(15);

struct Active {
    recorder: Arc<Recorder>,
    subscribers: Vec<zenoh::pubsub::Subscriber<()>>,
    keys: BTreeSet<String>,
    logs: LogTailer,
}

/// Where dimos's jsonl logs are: run log dirs, and logs roots holding one dir per run (logs.rs).
#[derive(Deserialize, Default, Debug)]
pub struct LogDirs {
    #[serde(default)]
    pub log_dirs: Vec<String>,
    #[serde(default)]
    pub log_roots: Vec<String>,
}

impl LogDirs {
    fn paths(list: &[String]) -> Vec<PathBuf> {
        list.iter()
            .map(|dir| dir.trim())
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .collect()
    }

    fn watch(&self, tailer: &LogTailer) {
        tailer.watch(&Self::paths(&self.log_dirs), &Self::paths(&self.log_roots));
    }
}

pub struct State {
    /// the default folder (Desktop's shared one); `Options::directory` overrides it
    record_dir: PathBuf,
    /// the app's settings, where `Options` live (shared with api.rs)
    pub settings: Arc<Store>,
    zenoh_connect: String,
    session: AsyncMutex<Option<zenoh::Session>>,
    active: AsyncMutex<Option<Active>>,
    meter: AsyncMutex<Option<Meter>>,
    /// the session's location labels (labels.rs); written into recordings
    pub labels: Labels,
}

/// `dimos/<topic>/<pkg.Type>` → ("/<topic>", "pkg.Type"); anything else is not a dimos channel.
pub fn split_key(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix("dimos/")?;
    let (topic, msg_type) = rest.rsplit_once('/')?;
    let (package, name) = msg_type.split_once('.')?;
    if topic.is_empty() || package.is_empty() || name.is_empty() || key.contains('*') {
        return None;
    }
    Some((format!("/{topic}"), msg_type.to_string()))
}

impl State {
    /// With settings of its own that aren't saved (tests); the app uses `with_settings`.
    pub fn new(record_dir: PathBuf, zenoh_connect: String) -> Self {
        Self::with_settings(record_dir, zenoh_connect, Arc::new(Store::load(None)))
    }

    pub fn with_settings(record_dir: PathBuf, zenoh_connect: String, settings: Arc<Store>) -> Self {
        State {
            record_dir,
            settings,
            zenoh_connect,
            session: AsyncMutex::new(None),
            active: AsyncMutex::new(None),
            meter: AsyncMutex::new(None),
            labels: Labels::default(),
        }
    }

    pub fn options(&self) -> Options {
        Options::load(&self.settings)
    }

    /// Where the next recording goes: the chosen folder, else the default.
    pub fn directory(&self) -> PathBuf {
        let chosen = self.options().directory;
        if chosen.is_empty() {
            self.record_dir.clone()
        } else {
            PathBuf::from(chosen)
        }
    }

    pub async fn session(&self) -> anyhow::Result<zenoh::Session> {
        let mut session = self.session.lock().await;
        if let Some(open) = session.as_ref() {
            return Ok(open.clone());
        }
        let mut config = zenoh::Config::default();
        if !self.zenoh_connect.is_empty() {
            // an explicit endpoint is the whole story: no multicast scouting of the LAN
            for (key, value) in [
                (
                    "connect/endpoints",
                    serde_json::to_string(&[&self.zenoh_connect])?,
                ),
                ("scouting/multicast/enabled", "false".into()),
            ] {
                config
                    .insert_json5(key, &value)
                    .map_err(|error| anyhow::anyhow!("zenoh config {key}: {error}"))?;
            }
        }
        let open = zenoh::open(config)
            .await
            .map_err(|error| anyhow::anyhow!("zenoh: {error}"))?;
        *session = Some(open.clone());
        Ok(open)
    }

    async fn subscribe(
        &self,
        recorder: &Arc<Recorder>,
        key: &str,
    ) -> anyhow::Result<zenoh::pubsub::Subscriber<()>> {
        let (topic, msg_type) =
            split_key(key).ok_or_else(|| anyhow::anyhow!("not a dimos key: {key}"))?;
        let recorder = recorder.clone();
        let session = self.session().await?;
        let (store, throttle, owned_key) =
            (self.settings.clone(), Throttle::default(), key.to_string());
        session
            .declare_subscriber(key.to_string())
            .callback(move |sample| {
                // the rate is read per message, so a change applies to a running recording
                if throttle.admit(record::now_nanos(), max_rate(&store, &owned_key)) {
                    recorder.offer(&topic, Some(&msg_type), &sample.payload().to_bytes())
                } else {
                    recorder.skip();
                }
            })
            .await
            .map_err(|error| anyhow::anyhow!("subscribe {key}: {error}"))
    }

    pub async fn start(
        &self,
        keys: Vec<String>,
        name: Option<String>,
        logs: LogDirs,
    ) -> anyhow::Result<record::RecordingStatus> {
        let mut active = self.active.lock().await;
        if active.is_some() {
            anyhow::bail!("already recording");
        }
        let directory = self.directory();
        let path = record::resolve(&directory, &name.unwrap_or_else(record::default_name))?;
        let options = self.options();
        let recorder = Arc::new(Recorder::start(
            &path,
            options.compression,
            options.image_format,
        )?);
        // the labels made so far are part of the picture: they open the recording
        for label in self.labels.list() {
            labels::write(&recorder, &label, "add");
        }
        let tailer = LogTailer::start(recorder.clone());
        logs.watch(&tailer);
        let mut started = Active {
            recorder: recorder.clone(),
            subscribers: Vec::new(),
            keys: BTreeSet::new(),
            logs: tailer,
        };
        for key in keys {
            if started.keys.insert(key.clone()) {
                started
                    .subscribers
                    .push(self.subscribe(&recorder, &key).await?);
            }
        }
        let status = recorder.status();
        *active = Some(started);
        Ok(status)
    }

    /// Topics that appeared mid-recording join it.
    pub async fn add(&self, keys: Vec<String>) -> anyhow::Result<usize> {
        let mut active = self.active.lock().await;
        let Some(active) = active.as_mut() else {
            anyhow::bail!("not recording");
        };
        let mut added = 0;
        for key in keys {
            if active.keys.insert(key.clone()) {
                active
                    .subscribers
                    .push(self.subscribe(&active.recorder, &key).await?);
                added += 1;
            }
        }
        Ok(added)
    }

    /// Log dirs found mid-recording (a run that started after it) join it.
    pub async fn add_logs(&self, logs: LogDirs) -> anyhow::Result<Vec<String>> {
        let active = self.active.lock().await;
        let Some(active) = active.as_ref() else {
            anyhow::bail!("not recording");
        };
        logs.watch(&active.logs);
        Ok(active.logs.dirs())
    }

    /// Writes a label change into the recording if one is running; says whether it did.
    pub async fn record_label(&self, label: &labels::Label, action: &str) -> bool {
        match self.active.lock().await.as_ref() {
            Some(active) => {
                labels::write(&active.recorder, label, action);
                true
            }
            None => false,
        }
    }

    pub async fn stop(&self) -> anyhow::Result<record::RecordingStatus> {
        let Some(active) = self.active.lock().await.take() else {
            anyhow::bail!("not recording");
        };
        // undeclare first so nothing is offered after the writer closes
        for subscriber in active.subscribers {
            let _ = subscriber.undeclare().await;
        }
        let (recorder, logs) = (active.recorder, active.logs);
        tokio::task::spawn_blocking(move || {
            // the log tail's last pass writes into the recorder, so it stops first
            logs.stop();
            recorder.finish()
        })
        .await?
    }

    /// The dimos keys on the bus now: liveliness tokens, plus what is heard in a short listen.
    pub async fn discover(&self) -> anyhow::Result<Vec<String>> {
        let session = self.session().await?;
        let found: Arc<Mutex<BTreeSet<String>>> = Arc::default();
        let sink = found.clone();
        let listener = session
            .declare_subscriber("dimos/**")
            .callback(move |sample| {
                sink.lock()
                    .unwrap()
                    .insert(sample.key_expr().as_str().to_string());
            })
            .await
            .map_err(|error| anyhow::anyhow!("zenoh: {error}"))?;
        for selector in ["dimos/**", "dimos/**/@adv/pub/**"] {
            if let Ok(replies) = session
                .liveliness()
                .get(selector)
                .timeout(std::time::Duration::from_millis(400))
                .await
            {
                while let Ok(reply) = replies.recv_async().await {
                    if let Ok(sample) = reply.result() {
                        let token = sample.key_expr().as_str();
                        found.lock().unwrap().insert(
                            token
                                .split_once("/@adv/pub/")
                                .map_or(token, |(key, _)| key)
                                .to_string(),
                        );
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let _ = listener.undeclare().await;
        let keys = found
            .lock()
            .unwrap()
            .iter()
            .filter(|key| split_key(key).is_some())
            .cloned()
            .collect();
        Ok(keys)
    }

    pub async fn is_recording(&self, path: &Option<String>) -> bool {
        self.active
            .lock()
            .await
            .as_ref()
            .is_some_and(|active| active.recorder.status().path == *path)
    }

    pub async fn status(&self) -> Status {
        let active = self.active.lock().await;
        let directory = self.directory();
        let options = self.options();
        Status {
            recording: active
                .as_ref()
                .map(|active| active.recorder.status())
                .unwrap_or_else(record::idle_status),
            keys: active
                .as_ref()
                .map(|active| active.keys.iter().cloned().collect())
                .unwrap_or_default(),
            logs: active
                .as_ref()
                .map(|active| LogStatus {
                    dirs: active.logs.dirs(),
                    lines: active.logs.lines(),
                })
                .unwrap_or_default(),
            files: record::list(&directory),
            settings: Settings {
                compression: options.compression,
                image_format: options.image_format,
            },
            directory: directory.display().to_string(),
            default_directory: self.record_dir.display().to_string(),
            recordings_root: crate::dimos_app::field(|app| app.recordings_dir.as_ref()),
            options,
        }
    }

    /// Each key's bytes and messages per second on the bus, from the meter (started by the first ask; it keeps
    /// listening while asked at least every `METER_IDLE`). `seconds` = how long it has measured.
    pub async fn streams(self: &Arc<Self>) -> anyhow::Result<(Vec<(String, f64, f64)>, f64)> {
        let mut meter = self.meter.lock().await;
        if meter.is_none() {
            *meter = Some(self.start_meter().await?);
        }
        let open = meter.as_ref().unwrap();
        *open.asked.lock().unwrap() = Instant::now();
        let mut streams: Vec<(String, f64, f64)> = open
            .rates
            .lock()
            .unwrap()
            .iter()
            .map(|(key, (bytes, messages))| (key.clone(), *bytes, *messages))
            .collect();
        streams.sort_by(|left, right| right.1.total_cmp(&left.1));
        Ok((streams, open.started.elapsed().as_secs_f64()))
    }

    async fn start_meter(self: &Arc<Self>) -> anyhow::Result<Meter> {
        let session = self.session().await?;
        let counts: Arc<Mutex<HashMap<String, (u64, u64)>>> = Arc::default();
        let sink = counts.clone();
        let subscriber = session
            .declare_subscriber("dimos/**")
            .callback(move |sample| {
                let key = sample.key_expr().as_str();
                if split_key(key).is_none() {
                    return;
                }
                let mut counts = sink.lock().unwrap();
                let entry = counts.entry(key.to_string()).or_default();
                entry.0 += sample.payload().len() as u64;
                entry.1 += 1;
            })
            .await
            .map_err(|error| anyhow::anyhow!("zenoh: {error}"))?;
        let meter = Meter {
            subscriber,
            counts,
            rates: Arc::default(),
            asked: Arc::new(Mutex::new(Instant::now())),
            started: Instant::now(),
        };
        let (counts, rates, asked) = (
            meter.counts.clone(),
            meter.rates.clone(),
            meter.asked.clone(),
        );
        let state = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            tick.tick().await;
            let mut last = Instant::now();
            loop {
                tick.tick().await;
                let seconds = last.elapsed().as_secs_f64().max(0.001);
                last = Instant::now();
                let fresh = std::mem::take(&mut *counts.lock().unwrap());
                {
                    let mut rates = rates.lock().unwrap();
                    for rate in rates.values_mut() {
                        *rate = (rate.0 * 0.5, rate.1 * 0.5);
                    }
                    for (key, (bytes, messages)) in fresh {
                        let rate = rates.entry(key).or_insert((0.0, 0.0));
                        rate.0 += 0.5 * bytes as f64 / seconds;
                        rate.1 += 0.5 * messages as f64 / seconds;
                    }
                    // a key quiet for a while drops out
                    rates.retain(|_, rate| rate.1 > 0.01);
                }
                if asked.lock().unwrap().elapsed() > METER_IDLE {
                    if let Some(meter) = state.meter.lock().await.take() {
                        let _ = meter.subscriber.undeclare().await;
                    }
                    return;
                }
            }
        });
        Ok(meter)
    }
}

#[derive(Serialize)]
pub struct Status {
    pub recording: record::RecordingStatus,
    pub keys: Vec<String>,
    /// the log dirs being tailed and the lines written so far (while recording)
    logs: LogStatus,
    files: Vec<record::RecordingFile>,
    settings: Settings,
    /// where recordings go now
    directory: String,
    /// where they go when no folder is chosen
    default_directory: String,
    /// Desktop's shared recordings folder (what the Recordings app lists), if Desktop said
    recordings_root: Option<String>,
    options: Options,
}

#[derive(Serialize, Default)]
struct LogStatus {
    dirs: Vec<String>,
    lines: u64,
}

#[derive(Deserialize)]
pub struct SettingsBody {
    compression: Option<Compression>,
    image_format: Option<ImageFormat>,
    /// "" = back to the default folder
    directory: Option<String>,
    #[serde(rename = "recordNew")]
    record_new: Option<bool>,
    logs: Option<bool>,
    /// key → max messages per second (0 or null = every message)
    rates: Option<BTreeMap<String, Option<f64>>>,
}

fn error(status: StatusCode, error: impl std::fmt::Display) -> Response {
    (status, Json(json!({ "error": error.to_string() }))).into_response()
}

/// The keys a start without keys records: everything on the bus except the ones turned off in the recorder popover.
pub fn wanted(keys: &[String], chosen: &Value) -> Vec<String> {
    keys.iter()
        .filter(|key| chosen[key.as_str()].as_bool().unwrap_or(true))
        .cloned()
        .collect()
}

pub async fn status(Extract(state): Extract<Arc<State>>) -> Response {
    Json(state.status().await).into_response()
}

pub async fn start(
    Extract(api): Extract<crate::api::Api>,
    crate::api::Body(body): crate::api::Body,
) -> Response {
    let state = api.recorder.clone();
    let explicit: Option<Vec<String>> = match body.get("keys") {
        None | Some(Value::Null) => None,
        Some(keys) => match serde_json::from_value(keys.clone()) {
            Ok(keys) => Some(keys),
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "keys: a list of dimos keys (dimos/<topic>/<pkg.Type>)",
                )
            }
        },
    };
    let follow = explicit.is_none();
    let keys = match explicit {
        Some(keys) => keys,
        None => match state.discover().await {
            Ok(keys) => wanted(&keys, &api.settings.get("lv.record.topics")),
            Err(problem) => return error(StatusCode::SERVICE_UNAVAILABLE, problem),
        },
    };
    let given: Option<LogDirs> =
        if body.get("log_dirs").is_some() || body.get("log_roots").is_some() {
            serde_json::from_value(body.clone()).ok()
        } else {
            None
        };
    let with_logs = state.options().logs;
    let logs = match given {
        Some(logs) => logs,
        None if with_logs => crate::desktop::log_dirs(&api.desktop_url, true).await,
        None => LogDirs::default(),
    };
    let name = body["name"].as_str().map(str::to_string);
    match state.start(keys, name, logs).await {
        Ok(status) => {
            follow_recording(api, status.path.clone(), follow, with_logs);
            Json(status).into_response()
        }
        Err(problem) => error(StatusCode::CONFLICT, problem),
    }
}

/// While this recording runs: dimos runs that start later bring their log dirs; with `topics`, new topics join.
fn follow_recording(api: crate::api::Api, path: Option<String>, topics: bool, logs: bool) {
    tokio::spawn(async move {
        let mut tick = 0u64;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            if !api.recorder.is_recording(&path).await {
                return;
            }
            tick += 1;
            if topics && api.recorder.options().record_new {
                if let Ok(keys) = api.recorder.discover().await {
                    let _ = api
                        .recorder
                        .add(wanted(&keys, &api.settings.get("lv.record.topics")))
                        .await;
                }
            }
            if logs && tick % 2 == 0 {
                let dirs = crate::desktop::log_dirs(&api.desktop_url, false).await;
                if !dirs.log_dirs.is_empty() {
                    let _ = api.recorder.add_logs(dirs).await;
                }
            }
        }
    });
}

pub async fn add(
    Extract(state): Extract<Arc<State>>,
    crate::api::Body(body): crate::api::Body,
) -> Response {
    let keys: Vec<String> = match serde_json::from_value(body["keys"].clone()) {
        Ok(keys) => keys,
        Err(_) => return error(StatusCode::BAD_REQUEST, "keys: a list of dimos keys"),
    };
    match state.add(keys).await {
        Ok(added) => Json(json!({ "added": added })).into_response(),
        Err(problem) => error(StatusCode::CONFLICT, problem),
    }
}

pub async fn add_logs(
    Extract(state): Extract<Arc<State>>,
    crate::api::Body(body): crate::api::Body,
) -> Response {
    let logs: LogDirs = serde_json::from_value(body).unwrap_or_default();
    match state.add_logs(logs).await {
        Ok(dirs) => Json(json!({ "dirs": dirs })).into_response(),
        Err(problem) => error(StatusCode::CONFLICT, problem),
    }
}

pub async fn stop(Extract(state): Extract<Arc<State>>) -> Response {
    match state.stop().await {
        Ok(status) => Json(status).into_response(),
        Err(problem) => error(StatusCode::CONFLICT, problem),
    }
}

pub async fn settings(
    Extract(api): Extract<crate::api::Api>,
    crate::api::Body(body): crate::api::Body,
) -> Response {
    let state = api.recorder.clone();
    let body: SettingsBody = match serde_json::from_value(body) {
        Ok(body) => body,
        Err(problem) => return error(StatusCode::BAD_REQUEST, problem),
    };
    let changes_file =
        body.compression.is_some() || body.image_format.is_some() || body.directory.is_some();
    if changes_file && state.active.lock().await.is_some() {
        return error(
            StatusCode::CONFLICT,
            "can't change the format or folder while recording",
        );
    }
    if let Some(rates) = &body.rates {
        if let Some((key, _)) = rates
            .iter()
            .find(|(_, hz)| hz.is_some_and(|hz| !hz.is_finite() || hz < 0.0))
        {
            return error(
                StatusCode::BAD_REQUEST,
                format!("rates.{key}: messages per second, 0 or more"),
            );
        }
    }
    let mut patch = serde_json::Map::new();
    if let Some(compression) = body.compression {
        patch.insert("compression".into(), json!(compression));
    }
    if let Some(format) = body.image_format {
        patch.insert("image_format".into(), json!(format));
    }
    if let Some(directory) = body.directory {
        let directory = directory.trim();
        patch.insert(
            "directory".into(),
            if directory.is_empty() {
                Value::Null
            } else {
                json!(directory)
            },
        );
    }
    if let Some(record_new) = body.record_new {
        patch.insert("recordNew".into(), json!(record_new));
    }
    if let Some(logs) = body.logs {
        patch.insert("logs".into(), json!(logs));
    }
    if let Some(rates) = body.rates {
        let mut merged = api.settings.get(OPTIONS_KEY)["rates"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        for (key, hz) in rates {
            match hz.filter(|hz| *hz > 0.0) {
                Some(hz) => merged.insert(key, json!(hz)),
                None => merged.remove(&key),
            };
        }
        patch.insert("rates".into(), Value::Object(merged));
    }
    if !patch.is_empty() {
        let value = api.settings.merge(OPTIONS_KEY, &patch);
        api.annotations
            .broadcast(json!({ "type": "settings", "key": OPTIONS_KEY, "value": value }));
    }
    Json(state.status().await).into_response()
}

/// Each stream's bytes and messages per second on the bus right now (the meter listens while this is polled).
pub async fn streams(Extract(state): Extract<Arc<State>>) -> Response {
    match state.streams().await {
        Ok((streams, seconds)) => {
            let options = state.options();
            let chosen = state.settings.get("lv.record.topics");
            let list: Vec<Value> = streams
                .into_iter()
                .filter_map(|(key, bytes, messages)| {
                    let (topic, msg_type) = split_key(&key)?;
                    Some(json!({
                        "key": key,
                        "topic": topic,
                        "type": msg_type,
                        "bytesPerSecond": bytes.round(),
                        "messagesPerSecond": (messages * 10.0).round() / 10.0,
                        "recorded": chosen[key.as_str()].as_bool().unwrap_or(true),
                        "maxRate": options.rates.get(&key),
                    }))
                })
                .collect();
            Json(json!({ "streams": list, "seconds": seconds })).into_response()
        }
        Err(problem) => error(StatusCode::SERVICE_UNAVAILABLE, problem),
    }
}

pub async fn delete_file(
    Extract(state): Extract<Arc<State>>,
    Path(name): Path<String>,
) -> Response {
    let directory = state.directory();
    let path = match record::resolve(&directory, &name) {
        Ok(path) => path,
        Err(problem) => return error(StatusCode::BAD_REQUEST, problem),
    };
    if let Some(active) = state.active.lock().await.as_ref() {
        if active.recorder.is_writing_to(&path) {
            return error(StatusCode::CONFLICT, "that recording is still running");
        }
    }
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Json(json!({ "ok": true, "removed": name })).into_response(),
        Err(problem) => error(StatusCode::NOT_FOUND, problem),
    }
}

pub async fn download_file(
    Extract(state): Extract<Arc<State>>,
    Path(name): Path<String>,
) -> Response {
    let directory = state.directory();
    let path = match record::resolve(&directory, &name) {
        Ok(path) => path,
        Err(problem) => return error(StatusCode::BAD_REQUEST, problem),
    };
    match tokio::fs::File::open(&path).await {
        Ok(file) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{name}\""),
                ),
            ],
            Body::from_stream(tokio_util::io::ReaderStream::new(file)),
        )
            .into_response(),
        Err(problem) => error(StatusCode::NOT_FOUND, problem),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    #[test]
    fn dimos_keys_split_into_topic_and_type() {
        assert_eq!(
            split_key("dimos/odom/nav_msgs.Odometry"),
            Some(("/odom".into(), "nav_msgs.Odometry".into()))
        );
        assert_eq!(
            split_key("dimos/head/left/image/sensor_msgs.Image"),
            Some(("/head/left/image".into(), "sensor_msgs.Image".into()))
        );
        assert_eq!(split_key("dimos/**"), None);
        assert_eq!(split_key("other/odom/nav_msgs.Odometry"), None);
        assert_eq!(split_key("dimos/odom/notatype"), None);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("controller_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn call(
        app: &axum::Router,
        method: &str,
        uri: &str,
        body: &str,
    ) -> (StatusCode, serde_json::Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    #[tokio::test]
    async fn status_lists_files_and_refuses_paths_outside_the_directory() {
        let dir = temp_dir("status");
        std::fs::write(dir.join("a.mcap"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        let app = crate::api::test_router(Arc::new(State::new(dir.clone(), String::new())));
        let (status, body) = call(&app, "GET", "/api/recorder", "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["recording"]["active"], false);
        let names: Vec<_> = body["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["a.mcap"]);
        let (status, _) = call(&app, "DELETE", "/api/recorder/files/..%2Fnotes.txt", "").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = call(&app, "DELETE", "/api/recorder/files/a.mcap", "").await;
        assert_eq!(status, StatusCode::OK);
        assert!(!dir.join("a.mcap").exists());
        let (status, _) = call(&app, "POST", "/api/recorder/stop", "").await;
        assert_eq!(status, StatusCode::CONFLICT);
    }

    /// A real zenoh round trip on loopback: what's published on a chosen key lands in the mcap under its topic.
    #[tokio::test(flavor = "multi_thread")]
    async fn records_chosen_keys_from_zenoh_into_an_mcap() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut config = zenoh::Config::default();
        config
            .insert_json5("listen/endpoints", &format!(r#"["tcp/127.0.0.1:{port}"]"#))
            .unwrap();
        config
            .insert_json5("scouting/multicast/enabled", "false")
            .unwrap();
        let robot = zenoh::open(config).await.unwrap();
        let dir = temp_dir("zenoh");
        let state = Arc::new(State::new(dir.clone(), format!("tcp/127.0.0.1:{port}")));
        let app = crate::api::test_router(state.clone());
        let (status, body) = call(
            &app,
            "POST",
            "/api/recorder/start",
            r#"{"keys":["dimos/test_cmd/geometry_msgs.Twist"],"name":"zenoh.mcap"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let twist = crate::msgs::encode_twist([0.5, 0.0, 0.0], [0.0, 0.0, 0.25]);
        for _ in 0..5 {
            robot
                .put("dimos/test_cmd/geometry_msgs.Twist", twist.clone())
                .await
                .unwrap();
            robot
                .put("dimos/not_chosen/geometry_msgs.Twist", twist.clone())
                .await
                .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let (status, body) = call(&app, "POST", "/api/recorder/stop", "").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["messages"], 5);
        let bytes = std::fs::read(dir.join("zenoh.mcap")).unwrap();
        let topics: Vec<String> = mcap::MessageStream::new(&bytes)
            .unwrap()
            .map(|message| message.unwrap().channel.topic.clone())
            .collect();
        assert_eq!(topics, vec!["/test_cmd"; 5]);
        robot.close().await.unwrap();
    }

    /// Through the HTTP API: a label made before the recording, one during it, one deleted, and dimos log lines written
    /// during it all land in the mcap on their own channels.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_recording_holds_the_logs_and_the_labels() {
        let dir = temp_dir("logs_labels");
        let run = dir.join("run");
        std::fs::create_dir_all(&run).unwrap();
        std::fs::write(
            run.join("main.jsonl"),
            "{\"event\": \"old\", \"level\": \"info\"}\n",
        )
        .unwrap();
        let state = Arc::new(State::new(dir.clone(), String::new()));
        let annotations = Arc::new(crate::annotations::Annotations::default());
        let _ = annotations;
        let app = crate::api::test_router(state.clone());
        let label =
            |text: &str| format!(r#"{{"label":"{text}","frame_id":"world","position":[1,2,0]}}"#);
        let (status, body) = call(&app, "POST", "/api/labels", &label("before")).await;
        assert_eq!(
            (status, &body["recorded"]),
            (StatusCode::OK, &serde_json::json!(false))
        );
        let start = serde_json::json!({ "keys": [], "name": "full.mcap", "log_dirs": [run.display().to_string()] }).to_string();
        let (status, body) = call(&app, "POST", "/api/recorder/start", &start).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (_, body) = call(&app, "POST", "/api/labels", &label("during")).await;
        assert_eq!(body["recorded"], true);
        let id = body["label"]["id"].as_str().unwrap().to_string();
        let (status, _) = call(&app, "DELETE", &format!("/api/labels/{id}"), "").await;
        assert_eq!(status, StatusCode::OK);
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(run.join("main.jsonl"))
                .unwrap();
            writeln!(file, r#"{{"event": "went wrong", "level": "error", "logger": "dimos/x.py", "timestamp": "2026-10-03T08:00:00Z", "lineno": 3}}"#).unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let (_, body) = call(&app, "GET", "/api/recorder", "").await;
        assert_eq!(body["logs"]["lines"], 1, "{body}");
        let (status, body) = call(&app, "POST", "/api/recorder/stop", "").await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let bytes = std::fs::read(dir.join("full.mcap")).unwrap();
        let mut seen: Vec<(String, String, String, serde_json::Value)> = Vec::new();
        for message in mcap::MessageStream::new(&bytes).unwrap() {
            let message = message.unwrap();
            let schema = message
                .channel
                .schema
                .as_ref()
                .map(|schema| schema.name.clone())
                .unwrap_or_default();
            seen.push((
                message.channel.topic.clone(),
                schema,
                message.channel.message_encoding.clone(),
                serde_json::from_slice(&message.data).unwrap(),
            ));
        }
        let on = |topic: &str| {
            seen.iter()
                .filter(|seen| seen.0 == topic)
                .collect::<Vec<_>>()
        };
        let logs = on("/dimos/logs/main");
        assert_eq!(logs.len(), 1);
        assert_eq!(
            (logs[0].1.as_str(), logs[0].2.as_str()),
            ("foxglove.Log", "json")
        );
        assert_eq!(logs[0].3["message"], "went wrong");
        assert_eq!(logs[0].3["level"], 4);
        let labels: Vec<(String, String)> = on("/labels")
            .iter()
            .map(|seen| {
                (
                    seen.3["label"].as_str().unwrap().to_string(),
                    seen.3["action"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(
            labels,
            vec![
                ("before".into(), "add".into()),
                ("during".into(), "add".into()),
                ("during".into(), "delete".into())
            ]
        );
        assert!(on("/labels")
            .iter()
            .all(|seen| seen.1 == "dimos.LocationLabel" && seen.3["frame_id"] == "world"));
        let scene = on("/labels/scene");
        assert_eq!(scene.len(), 3);
        assert_eq!(scene[0].1, "foxglove.SceneUpdate");
        assert_eq!(scene[2].3["deletions"][0]["id"], id.as_str());
        // the log line keeps its own time, which is before this recording: mcap's summary still covers it
        let summary = mcap::Summary::read(&bytes).unwrap().unwrap();
        assert_eq!(summary.stats.unwrap().message_count, 7);
    }

    #[test]
    fn options_read_leniently() {
        let options = Options::from_value(&json!({
            "recordNew": false,
            "compression": "zstd",
            "image_format": "bogus",
            "directory": "  /tmp/x ",
            "rates": { "dimos/a/x.Y": 5, "dimos/b/x.Y": 0, "dimos/c/x.Y": "fast", "dimos/d/x.Y": -1 },
        }));
        assert!(!options.record_new);
        assert_eq!(options.compression, Compression::Zstd);
        assert_eq!(
            options.image_format,
            ImageFormat::Raw,
            "a format it doesn't know keeps the default"
        );
        assert_eq!(options.directory, "/tmp/x");
        assert!(options.logs);
        assert_eq!(
            options.rates.into_iter().collect::<Vec<_>>(),
            vec![("dimos/a/x.Y".to_string(), 5.0)]
        );
        assert_eq!(Options::from_value(&Value::Null), Options::default());
    }

    #[test]
    fn a_max_rate_keeps_one_message_per_interval() {
        let throttle = Throttle::default();
        let ms = 1_000_000u64;
        // a 100 Hz source kept to 10 Hz: one in ten
        let kept = (1..=300u64)
            .filter(|tick| throttle.admit(tick * 10 * ms, Some(10.0)))
            .count();
        assert!((30..=31).contains(&kept), "{kept}");
        // a 10 Hz source at 10 Hz loses nothing to jitter
        let throttle = Throttle::default();
        let kept = (1..=50u64)
            .filter(|tick| throttle.admit(tick * 100 * ms + (tick % 3) * 4 * ms, Some(10.0)))
            .count();
        assert_eq!(kept, 50);
        assert!((0..5).all(|_| throttle.admit(0, None)));
    }

    #[test]
    fn everything_is_recorded_unless_turned_off() {
        let keys = vec![
            "dimos/odom/nav_msgs.Odometry".to_string(),
            "dimos/rpc/x/req/std_msgs.String".to_string(),
            "dimos/color_image/sensor_msgs.Image".to_string(),
        ];
        let chosen = json!({ "dimos/color_image/sensor_msgs.Image": false });
        assert_eq!(wanted(&keys, &chosen), keys[..2].to_vec());
        assert_eq!(wanted(&keys, &Value::Null), keys);
    }

    /// The options are the lv.record.options setting: saved, reported, validated, and only the file's format and folder
    /// are held still while recording.
    #[tokio::test]
    async fn options_are_saved_and_the_folder_waits_for_the_recording_to_end() {
        let dir = temp_dir("options");
        let state = Arc::new(State::new(dir.clone(), String::new()));
        let app = crate::api::test_router(state.clone());
        let elsewhere = dir.join("elsewhere");
        let body = json!({ "directory": elsewhere.display().to_string(), "logs": false, "rates": { "dimos/a/x.Y": 2.5 } });
        let (status, body) = call(&app, "PUT", "/api/recorder/settings", &body.to_string()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["directory"], elsewhere.display().to_string());
        assert_eq!(body["default_directory"], dir.display().to_string());
        assert_eq!(body["options"]["logs"], false);
        assert_eq!(body["options"]["rates"]["dimos/a/x.Y"], 2.5);
        assert_eq!(
            state.settings.get(OPTIONS_KEY)["directory"],
            elsewhere.display().to_string()
        );
        let (status, _) = call(
            &app,
            "PUT",
            "/api/recorder/settings",
            r#"{"rates":{"dimos/a/x.Y":-3}}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let start = json!({ "keys": [], "name": "held.mcap", "log_dirs": [] }).to_string();
        let (status, body) = call(&app, "POST", "/api/recorder/start", &start).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            elsewhere.join("held.mcap").exists(),
            "it records into the chosen folder"
        );
        let (status, _) = call(&app, "PUT", "/api/recorder/settings", r#"{"directory":""}"#).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, body) = call(
            &app,
            "PUT",
            "/api/recorder/settings",
            r#"{"rates":{"dimos/a/x.Y":null},"recordNew":false}"#,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "rates and recordNew change any time: {body}"
        );
        assert_eq!(body["options"]["rates"], json!({}));
        assert_eq!(body["options"]["recordNew"], false);
        let (status, _) = call(&app, "POST", "/api/recorder/stop", "").await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) =
            call(&app, "PUT", "/api/recorder/settings", r#"{"directory":""}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["directory"],
            dir.display().to_string(),
            "\"\" goes back to the default"
        );
    }

    /// The meter hears what's on the bus and ranks it by bytes per second.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_meter_ranks_streams_by_bandwidth() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut config = zenoh::Config::default();
        config
            .insert_json5("listen/endpoints", &format!(r#"["tcp/127.0.0.1:{port}"]"#))
            .unwrap();
        config
            .insert_json5("scouting/multicast/enabled", "false")
            .unwrap();
        let robot = zenoh::open(config).await.unwrap();
        let state = Arc::new(State::new(
            temp_dir("meter"),
            format!("tcp/127.0.0.1:{port}"),
        ));
        let app = crate::api::test_router(state.clone());
        let (status, _) = call(&app, "GET", "/api/recorder/streams", "").await;
        assert_eq!(status, StatusCode::OK);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        for _ in 0..25 {
            robot
                .put("dimos/big/sensor_msgs.Image", vec![0u8; 20_000])
                .await
                .unwrap();
            robot
                .put("dimos/small/nav_msgs.Odometry", vec![0u8; 100])
                .await
                .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let (status, body) = call(&app, "GET", "/api/recorder/streams", "").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let streams = body["streams"].as_array().unwrap();
        let topics: Vec<_> = streams
            .iter()
            .map(|stream| stream["topic"].as_str().unwrap())
            .collect();
        assert_eq!(topics, vec!["/big", "/small"], "{body}");
        let big = streams[0]["bytesPerSecond"].as_f64().unwrap();
        assert!(big > 50_000.0 && big < 400_000.0, "{big}");
        assert_eq!(streams[0]["recorded"], true);
        robot.close().await.unwrap();
    }

    #[tokio::test]
    async fn settings_change_and_are_reported() {
        let app =
            crate::api::test_router(Arc::new(State::new(temp_dir("settings"), String::new())));
        let (status, body) = call(
            &app,
            "PUT",
            "/api/recorder/settings",
            r#"{"compression":"zstd","image_format":"png"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["settings"]["compression"], "zstd");
        assert_eq!(body["settings"]["image_format"], "png");
    }
}
