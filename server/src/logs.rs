//! dimos's text logs into the recording. dimos writes structured logs as JSON lines (`main.jsonl`, ...) in each run's
//! log dir; the page asks Desktop where those are (`GET /dimos/runs`) and hands the dirs over. While a recording runs a
//! thread here tails every `*.jsonl` in them (new lines only, following new files and truncation/replacement) and
//! writes each line as a `foxglove.Log` (JSON encoding, so Foxglove's Log panel shows it) on `/dimos/logs/<file stem>`,
//! stamped with the line's own timestamp. The original record is kept whole in the extra `fields` key.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::record::{now_nanos, Encoded, Recorder};

pub const LOG_SCHEMA: &[u8] = include_bytes!("schemas/foxglove.Log.json");
pub const LOG_TOPIC_PREFIX: &str = "/dimos/logs/"; // a topic, not an endpoint (dimos-yaml-check: ignore)
/// an existing run dir under a logs root counts as live when one of its logs changed this recently
const LIVE_WITHIN: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(250);
const ROOT_POLL: Duration = Duration::from_secs(2);
/// a runaway line (a huge repr) is cut here rather than buffered forever
const MAX_LINE: usize = 1 << 20;

/// foxglove.LogLevel from a dimos (structlog / python logging) level name.
pub fn level(name: &str) -> u8 {
    match name.to_ascii_lowercase().as_str() {
        "debug" | "trace" => 1,
        "info" | "notset" => 2,
        "warn" | "warning" => 3,
        "error" | "exception" => 4,
        "critical" | "fatal" => 5,
        _ => 0,
    }
}

/// Nanoseconds since the epoch from an RFC 3339 / ISO 8601 time ("2026-09-24T13:45:45.848591Z", "+00:00" offsets, a
/// space for the T) or from epoch seconds as a number.
pub fn parse_time(value: &Value) -> Option<u64> {
    if let Some(seconds) = value.as_f64() {
        return (seconds >= 0.0).then(|| (seconds * 1e9) as u64);
    }
    let text = value.as_str()?.trim();
    let bytes = text.as_bytes();
    if bytes.len() < 19 || !matches!(bytes[10], b'T' | b't' | b' ') {
        return None;
    }
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    let mut rest = &text[19..];
    let mut nanos: i64 = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        let kept = &fraction[..digits.min(9)];
        nanos = format!("{kept:0<9}").parse().ok()?;
        rest = &fraction[digits..];
    }
    let offset_seconds = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = rest[1..].chars().filter(char::is_ascii_digit).collect();
            if digits.len() != 4 {
                return None;
            }
            sign * (digits[0..2].parse::<i64>().ok()? * 3600
                + digits[2..4].parse::<i64>().ok()? * 60)
        }
    };
    // days from the civil date (Howard Hinnant's algorithm)
    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * m + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146097 + day_of_era - 719468;
    let seconds = days * 86400 + hour * 3600 + minute * 60 + second - offset_seconds;
    (seconds >= 0).then(|| seconds as u64 * 1_000_000_000 + nanos as u64)
}

/// keys that become foxglove.Log's own fields; the rest are appended to the message as `key=value`
const KNOWN: &[&str] = &[
    "event",
    "message",
    "msg",
    "level",
    "levelname",
    "logger",
    "name",
    "timestamp",
    "func_name",
    "lineno",
    "exception_type",
    "exception_message",
    "exception",
    "exc_info",
];

fn text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

/// One log line as a foxglove.Log JSON message, and its time (the record's, else `received`). A line that isn't a
/// JSON object is kept anyway: level UNKNOWN, the raw text as the message, `fields` null.
pub fn to_log(line: &str, source: &str, received: u64) -> (u64, Value) {
    let record = serde_json::from_str::<Value>(line)
        .ok()
        .filter(Value::is_object);
    let Some(record) = record else {
        let log = json!({
            "timestamp": stamp(received), "level": 0, "message": line.trim_end(), "name": "", "file": "", "line": 0,
            "source": source, "fields": Value::Null,
        });
        return (received, log);
    };
    let object: &Map<String, Value> = record.as_object().expect("filtered to objects");
    let get = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| object.get(*key))
            .filter(|value| !value.is_null())
    };
    let time = get(&["timestamp", "time", "ts"])
        .and_then(parse_time)
        .unwrap_or(received);
    let mut message = get(&["event", "message", "msg"])
        .map(text)
        .unwrap_or_default();
    for (key, value) in object
        .iter()
        .filter(|(key, _)| !KNOWN.contains(&key.as_str()))
    {
        message.push_str(&format!(" {key}={}", text(value)));
    }
    if let Some(kind) = get(&["exception_type"]) {
        message.push_str(&format!(
            "\n{}: {}",
            text(kind),
            get(&["exception_message"]).map(text).unwrap_or_default()
        ));
    } else if let Some(exception) = get(&["exception", "exc_info"]) {
        message.push_str(&format!("\n{}", text(exception)));
    }
    let logger = get(&["logger", "name"]).map(text).unwrap_or_default();
    let log = json!({
        "timestamp": stamp(time),
        "level": get(&["level", "levelname"]).map(|level_name| level(&text(level_name))).unwrap_or(0),
        "message": message,
        "name": logger,
        // dimos's logger names are the module's file path
        "file": if logger.ends_with(".py") { logger.as_str() } else { "" },
        "line": get(&["lineno", "line"]).and_then(Value::as_u64).unwrap_or(0),
        "source": source,
        "fields": record,
    });
    (time, log)
}

pub fn stamp(nanos: u64) -> Value {
    json!({ "sec": nanos / 1_000_000_000, "nsec": nanos % 1_000_000_000 })
}

/// `/dimos/logs/<stem>` for a log file, its stem cleaned to topic-safe characters.
pub fn topic_for(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let clean: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "{LOG_TOPIC_PREFIX}{}",
        if clean.is_empty() { "log" } else { &clean }
    )
}

pub fn encoded(log: &Value) -> Encoded {
    Encoded {
        schema_name: "foxglove.Log",
        schema_encoding: "jsonschema",
        schema: LOG_SCHEMA,
        message_encoding: "json",
        data: serde_json::to_vec(log).unwrap_or_default(),
    }
}

struct Tail {
    offset: u64,
    inode: u64,
    partial: Vec<u8>,
    /// lines from before the recording started are skipped (a file read from its start)
    skip_before: Option<u64>,
}

#[derive(Default)]
struct Watched {
    /// run log dirs: tail every *.jsonl directly in them
    dirs: BTreeSet<PathBuf>,
    /// logs roots (one subdir per run): subdirs that appear later, and the live ones at the start, become dirs
    roots: BTreeMap<PathBuf, BTreeSet<PathBuf>>,
    files: HashMap<PathBuf, Tail>,
}

/// Tails dimos's jsonl logs into a recording until stopped.
pub struct LogTailer {
    watched: Arc<Mutex<Watched>>,
    started: u64,
    stop: Arc<AtomicBool>,
    lines: Arc<AtomicU64>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl LogTailer {
    pub fn start(recorder: Arc<Recorder>) -> Self {
        let watched = Arc::new(Mutex::new(Watched::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let lines = Arc::new(AtomicU64::new(0));
        let started = now_nanos();
        let worker = {
            let (watched, stop, lines) = (watched.clone(), stop.clone(), lines.clone());
            std::thread::Builder::new()
                .name("log-tailer".into())
                .spawn(move || {
                    let mut last_roots = Instant::now() - ROOT_POLL;
                    loop {
                        let stopping = stop.load(Ordering::Relaxed);
                        if last_roots.elapsed() >= ROOT_POLL || stopping {
                            last_roots = Instant::now();
                            scan_roots(&watched);
                        }
                        // the last pass after stop picks up what was written up to the stop
                        poll(&watched, &recorder, &lines, started);
                        if stopping {
                            break;
                        }
                        std::thread::sleep(POLL);
                    }
                })
                .ok()
        };
        LogTailer {
            watched,
            started,
            stop,
            lines,
            worker: Mutex::new(worker),
        }
    }

    /// Watches run log dirs (`dirs`) and logs roots that hold one dir per run (`roots`). Files already in a dir are
    /// read from their end when it is added in the recording's first seconds, else from their start (lines older
    /// than the recording skipped), so a run that starts mid-recording is complete.
    pub fn watch(&self, dirs: &[PathBuf], roots: &[PathBuf]) {
        let early = now_nanos().saturating_sub(self.started) < 5_000_000_000;
        let mut watched = self.watched.lock().unwrap();
        for dir in dirs {
            if watched.dirs.insert(dir.clone()) {
                for file in jsonl_files(dir) {
                    let tail = if early {
                        from_end(&file)
                    } else {
                        from_start(self.started)
                    };
                    watched.files.entry(file).or_insert(tail);
                }
            }
        }
        for root in roots {
            if watched.roots.contains_key(root) {
                continue;
            }
            let existing: BTreeSet<PathBuf> = subdirs(root).into_iter().collect();
            let live: Vec<PathBuf> = existing
                .iter()
                .filter(|dir| recently_written(dir))
                .cloned()
                .collect();
            watched.roots.insert(root.clone(), existing);
            drop(watched);
            self.watch(&live, &[]);
            watched = self.watched.lock().unwrap();
        }
    }

    pub fn dirs(&self) -> Vec<String> {
        let watched = self.watched.lock().unwrap();
        watched
            .dirs
            .iter()
            .chain(watched.roots.keys())
            .map(|dir| dir.display().to_string())
            .collect()
    }

    pub fn lines(&self) -> u64 {
        self.lines.load(Ordering::Relaxed)
    }

    /// Reads what's left and stops; call before the recorder finishes.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

impl Drop for LogTailer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn from_end(file: &Path) -> Tail {
    let metadata = std::fs::metadata(file).ok();
    Tail {
        offset: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
        inode: metadata.map(|m| m.ino()).unwrap_or(0),
        partial: Vec::new(),
        skip_before: None,
    }
}

fn from_start(started: u64) -> Tail {
    Tail {
        offset: 0,
        inode: 0,
        partial: Vec::new(),
        skip_before: Some(started),
    }
}

fn jsonl_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|end| end == "jsonl") && path.is_file())
        .collect()
}

fn subdirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect()
}

fn recently_written(dir: &Path) -> bool {
    jsonl_files(dir).iter().any(|file| {
        std::fs::metadata(file)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|when| when.elapsed().ok())
            .is_some_and(|age| age < LIVE_WITHIN)
    })
}

/// New run dirs under the roots join (their files read from the start).
fn scan_roots(watched: &Mutex<Watched>) {
    let mut watched = watched.lock().unwrap();
    let mut fresh = Vec::new();
    for (root, known) in watched.roots.iter_mut() {
        for dir in subdirs(root) {
            if known.insert(dir.clone()) {
                fresh.push(dir);
            }
        }
    }
    for dir in fresh {
        watched.dirs.insert(dir);
    }
}

fn poll(watched: &Mutex<Watched>, recorder: &Recorder, lines: &AtomicU64, started: u64) {
    let mut watched = watched.lock().unwrap();
    let dirs: Vec<PathBuf> = watched.dirs.iter().cloned().collect();
    for dir in dirs {
        for file in jsonl_files(&dir) {
            // a file that appears after the dir was watched is new: all of it belongs to the recording
            let tail = watched
                .files
                .entry(file.clone())
                .or_insert_with(|| from_start(started));
            read_new(&file, tail, recorder, lines);
        }
    }
}

fn read_new(path: &Path, tail: &mut Tail, recorder: &Recorder, lines: &AtomicU64) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    // replaced (rotation) or truncated: start over
    if (tail.inode != 0 && metadata.ino() != tail.inode) || metadata.len() < tail.offset {
        tail.offset = 0;
        tail.partial.clear();
    }
    tail.inode = metadata.ino();
    if metadata.len() == tail.offset {
        return;
    }
    let Ok(mut file) = File::open(path) else {
        return;
    };
    if file.seek(SeekFrom::Start(tail.offset)).is_err() {
        return;
    }
    let mut fresh = Vec::new();
    let Ok(read) = file
        .take(metadata.len() - tail.offset)
        .read_to_end(&mut fresh)
    else {
        return;
    };
    tail.offset += read as u64;
    tail.partial.extend_from_slice(&fresh);
    let source = path.display().to_string();
    let topic = topic_for(path);
    let received = now_nanos();
    let mut consumed = 0;
    while let Some(end) = tail.partial[consumed..]
        .iter()
        .position(|&byte| byte == b'\n')
    {
        let line = String::from_utf8_lossy(&tail.partial[consumed..consumed + end]).into_owned();
        consumed += end + 1;
        if line.trim().is_empty() {
            continue;
        }
        let (time, log) = to_log(&line, &source, received);
        if tail.skip_before.is_some_and(|started| time < started) {
            continue;
        }
        recorder.write_encoded(&topic, encoded(&log), time);
        lines.fetch_add(1, Ordering::Relaxed);
    }
    tail.partial.drain(..consumed);
    if tail.partial.len() > MAX_LINE {
        tail.partial.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::ImageFormat;
    use crate::record::Compression;

    #[test]
    fn levels_map_to_foxglove() {
        assert_eq!(level("debug"), 1);
        assert_eq!(level("info"), 2);
        assert_eq!(level("WARNING"), 3);
        assert_eq!(level("warn"), 3);
        assert_eq!(level("error"), 4);
        assert_eq!(level("critical"), 5);
        assert_eq!(level("chatty"), 0);
    }

    #[test]
    fn times_parse_to_epoch_nanos() {
        assert_eq!(
            parse_time(&json!("1970-01-01T00:00:01Z")),
            Some(1_000_000_000)
        );
        assert_eq!(
            parse_time(&json!("2026-09-24T13:45:45.848591Z")),
            Some(1_790_257_545_848_591_000)
        );
        assert_eq!(
            parse_time(&json!("2026-09-24 15:45:45.848591+02:00")),
            Some(1_790_257_545_848_591_000)
        );
        assert_eq!(
            parse_time(&json!("2026-09-24T13:45:45")),
            Some(1_790_257_545_000_000_000)
        );
        assert_eq!(parse_time(&json!(1.5)), Some(1_500_000_000));
        assert_eq!(parse_time(&json!("yesterday")), None);
        assert_eq!(parse_time(&json!("2026-13-24T13:45:45Z")), None);
    }

    #[test]
    fn a_dimos_line_becomes_a_foxglove_log_with_its_record() {
        let line = r#"{"module": "MovementManager", "worker_id": 7, "event": "Deployed module.", "level": "info", "logger": "dimos/core/coordination/python_worker.py", "timestamp": "2026-09-24T13:45:46.663730Z", "func_name": "deploy_module", "lineno": 242}"#;
        let (time, log) = to_log(line, "/logs/run/main.jsonl", 5);
        assert_eq!(time, 1_790_257_546_663_730_000);
        assert_eq!(
            log["timestamp"],
            json!({ "sec": 1_790_257_546u64, "nsec": 663_730_000u64 })
        );
        assert_eq!(log["level"], 2);
        assert_eq!(
            log["message"],
            "Deployed module. module=MovementManager worker_id=7"
        );
        assert_eq!(log["name"], "dimos/core/coordination/python_worker.py");
        assert_eq!(log["file"], "dimos/core/coordination/python_worker.py");
        assert_eq!(log["line"], 242);
        assert_eq!(log["source"], "/logs/run/main.jsonl");
        assert_eq!(log["fields"]["worker_id"], 7);
        assert_eq!(log["fields"]["func_name"], "deploy_module");
    }

    #[test]
    fn exceptions_are_appended_to_the_message() {
        let line = r#"{"exception_type": "RuntimeError", "exception_message": "boom\nTraceback ...", "event": "Failed", "level": "error", "timestamp": "2026-09-24T13:45:46Z"}"#;
        let (_, log) = to_log(line, "x", 0);
        assert_eq!(log["level"], 4);
        assert_eq!(log["message"], "Failed\nRuntimeError: boom\nTraceback ...");
    }

    #[test]
    fn malformed_lines_are_kept_at_receive_time() {
        for line in ["not json at all", "[1, 2, 3]", r#"{"event": "cut off"#] {
            let (time, log) = to_log(line, "x", 42);
            assert_eq!(time, 42, "{line}");
            assert_eq!(log["level"], 0);
            assert_eq!(log["message"], line);
            assert!(log["fields"].is_null());
        }
        // JSON without a usable timestamp: receive time, fields kept
        let (time, log) = to_log(r#"{"event": "hi", "timestamp": "soon"}"#, "x", 42);
        assert_eq!(time, 42);
        assert_eq!(log["fields"]["event"], "hi");
    }

    #[test]
    fn topics_come_from_the_file_stem() {
        assert_eq!(topic_for(Path::new("/a/b/main.jsonl")), "/dimos/logs/main");
        assert_eq!(
            topic_for(Path::new("/a/b/dimos_2026.v2.jsonl")),
            "/dimos/logs/dimos_2026_v2"
        );
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("controller_logs_{label}_{}", now_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn append(path: &Path, text: &str) {
        use std::io::Write;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }

    fn read_logs(path: &Path) -> Vec<(String, Value)> {
        let bytes = std::fs::read(path).unwrap();
        mcap::MessageStream::new(&bytes)
            .unwrap()
            .map(|message| message.unwrap())
            .filter(|message| message.channel.topic.starts_with(LOG_TOPIC_PREFIX))
            .map(|message| {
                assert_eq!(message.channel.message_encoding, "json");
                assert_eq!(
                    message.channel.schema.as_ref().unwrap().name,
                    "foxglove.Log"
                );
                (
                    message.channel.topic.clone(),
                    serde_json::from_slice(&message.data).unwrap(),
                )
            })
            .collect()
    }

    /// Only lines written during the recording land, from files present at the start, new files, a new run dir under
    /// a root, and a truncated file; a half-written line waits for its newline.
    #[test]
    fn tails_new_lines_into_the_recording() {
        let dir = scratch("tail");
        let root = scratch("root");
        let run = dir.join("run");
        std::fs::create_dir_all(&run).unwrap();
        append(
            &run.join("main.jsonl"),
            "{\"event\": \"before\", \"level\": \"info\"}\n",
        );
        let path = dir.join("out.mcap");
        let recorder =
            Arc::new(Recorder::start(&path, Compression::None, ImageFormat::Raw).unwrap());
        let tailer = LogTailer::start(recorder.clone());
        tailer.watch(&[run.clone()], &[root.clone()]);
        append(
            &run.join("main.jsonl"),
            "{\"event\": \"during\", \"level\": \"warning\"}\n{\"event\": \"half",
        );
        append(&run.join("other.jsonl"), "garbage line\n");
        std::thread::sleep(Duration::from_millis(600));
        append(&run.join("main.jsonl"), "\", \"level\": \"error\"}\n");
        let later = root.join("20261003-run");
        std::fs::create_dir_all(&later).unwrap();
        append(
            &later.join("main.jsonl"),
            "{\"event\": \"new run\", \"level\": \"debug\"}\n",
        );
        std::thread::sleep(Duration::from_millis(2600));
        std::fs::write(run.join("other.jsonl"), "cut\n").unwrap();
        tailer.stop();
        assert_eq!(tailer.lines(), 5);
        recorder.finish().unwrap();

        let logs = read_logs(&path);
        let messages: Vec<(&str, &str)> = logs
            .iter()
            .map(|(topic, log)| (topic.as_str(), log["message"].as_str().unwrap()))
            .collect();
        for expected in [
            ("/dimos/logs/main", "during"),
            ("/dimos/logs/other", "garbage line"),
            ("/dimos/logs/main", "half"),
            ("/dimos/logs/main", "new run"),
            ("/dimos/logs/other", "cut"),
        ] {
            assert!(
                messages.contains(&expected),
                "{expected:?} missing from {messages:?}"
            );
        }
        assert!(!messages.iter().any(|(_, message)| *message == "before"));
        let half = logs
            .iter()
            .find(|(_, log)| log["message"] == "half")
            .unwrap();
        assert_eq!(half.1["level"], 4);
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }
}
