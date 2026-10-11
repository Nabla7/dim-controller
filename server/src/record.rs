//! A recording: rust-recorder (github.com/jeff-hykin/rust-recorder) does the writing, in the chosen format: a ROS 2
//! mcap (CDR that opens in Foxglove; raw LCM where no ROS 2 type fits, never dropped), a dimos-layout mcap, or a dimos
//! SqliteStore .db. This keeps the app's side: one stream per topic and type, the JSON log and label channels, the
//! status the page shows, and the recordings folder (listing, names, recovering a killed run's file).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rust_recorder::{Options, Stream, StreamSpec, StreamStats};
use serde::Serialize;

pub use rust_recorder::{now_nanos, Compression, Format, ImageFormat};

/// A message the caller encoded itself (JSON with a JSON Schema: the log and label channels).
pub struct Encoded {
    pub schema_name: &'static str,
    pub schema: &'static [u8],
    pub data: Vec<u8>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct RecordingStatus {
    pub active: bool,
    pub path: Option<String>,
    pub format: Option<Format>,
    /// records written
    pub messages: u64,
    pub bytes: u64,
    /// refused for a full queue
    pub dropped: u64,
    /// messages left out by a stream's max rate
    pub skipped: u64,
    /// messages that could not be written in this format (invalid payload or time)
    pub rejected: u64,
    /// ROS 2 recordings: messages kept as raw LCM because no ROS 2 type fits them
    pub fallback: u64,
    pub seconds: f64,
    /// what stopped the recording, if something did (disk full, ...)
    pub failure: Option<String>,
    /// per stream, while recording
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub streams: Vec<StreamStats>,
}

pub struct Recorder {
    path: PathBuf,
    format: Format,
    inner: Arc<rust_recorder::Recorder>,
    /// (topic, type) → stream
    streams: Mutex<HashMap<(String, String), Stream>>,
    json_streams: Mutex<HashMap<String, Stream>>,
}

impl Recorder {
    pub fn start(path: &Path, format: Format, compression: Compression, image_format: ImageFormat) -> Result<Self> {
        if path.extension().and_then(|end| end.to_str()) != Some(format.extension()) {
            anyhow::bail!("a {format:?} recording is a .{} file", format.extension());
        }
        let mut options = Options::new(format, path);
        options.compression = compression;
        options.image_format = image_format;
        let inner = rust_recorder::Recorder::open(options).with_context(|| format!("could not start recording to {}", path.display()))?;
        Ok(Recorder { path: path.to_path_buf(), format, inner: Arc::new(inner), streams: Mutex::default(), json_streams: Mutex::default() })
    }

    pub fn inner(&self) -> &Arc<rust_recorder::Recorder> {
        &self.inner
    }

    /// The stream for a dimos topic (`/odom`) and type (`nav_msgs.Odometry`), added on first use.
    pub fn stream(&self, topic: &str, msg_type: &str) -> Result<Stream> {
        let key = (topic.to_string(), msg_type.to_string());
        let mut streams = self.streams.lock().unwrap();
        if let Some(stream) = streams.get(&key) {
            return Ok(stream.clone());
        }
        let mut spec = StreamSpec::new(topic, msg_type);
        spec.port = Some(topic.trim_start_matches('/').to_string());
        let stream = self.inner.add_stream(spec)?;
        streams.insert(key, stream.clone());
        Ok(stream)
    }

    /// Records a wire message received now; a full queue drops it (counted). (The app records through zenoh_recording.)
    #[cfg(test)]
    pub fn offer(&self, topic: &str, msg_type: &str, payload: &[u8]) {
        if let Ok(stream) = self.stream(topic, msg_type) {
            self.inner.record(&stream, payload);
        }
    }

    /// Writes an already-encoded JSON message at `log_time` (ns since the epoch). Never shed for a full queue.
    pub fn write_encoded(&self, topic: &str, encoded: Encoded, log_time: u64) {
        let stream = {
            let mut streams = self.json_streams.lock().unwrap();
            match streams.get(topic) {
                Some(stream) => stream.clone(),
                None => match self.inner.add_json_stream(topic, encoded.schema_name, encoded.schema) {
                    Ok(stream) => {
                        streams.insert(topic.to_string(), stream.clone());
                        stream
                    }
                    Err(_) => return,
                },
            }
        };
        let _ = self.inner.record_json(&stream, encoded.data, log_time);
    }

    pub fn is_writing_to(&self, path: &Path) -> bool {
        self.path == path
    }

    fn to_status(&self, stats: rust_recorder::Stats, active: bool) -> RecordingStatus {
        RecordingStatus {
            active,
            path: Some(self.path.display().to_string()),
            format: Some(self.format),
            messages: stats.written,
            bytes: stats.bytes,
            dropped: stats.dropped,
            skipped: stats.skipped,
            rejected: stats.rejected,
            fallback: stats.fallback,
            seconds: stats.seconds,
            failure: stats.failure,
            streams: stats.streams,
        }
    }

    pub fn status(&self) -> RecordingStatus {
        self.to_status(self.inner.stats(), true)
    }

    /// Writes the queued tail and finishes the file; the counts are read after, since the tail is written until then.
    pub fn finish(&self) -> Result<RecordingStatus> {
        self.inner.finish()?;
        Ok(self.to_status(self.inner.stats(), false))
    }
}

pub fn idle_status() -> RecordingStatus {
    RecordingStatus::default()
}

#[derive(Serialize)]
pub struct RecordingFile {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub seconds_old: f64,
}

fn is_recording_file(path: &Path) -> bool {
    path.extension().is_some_and(|end| end == "mcap" || end == "db")
}

pub fn list(directory: &Path) -> Vec<RecordingFile> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut files: Vec<RecordingFile> = entries
        .flatten()
        .filter(|entry| is_recording_file(&entry.path()))
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            Some(RecordingFile {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().display().to_string(),
                bytes: metadata.len(),
                seconds_old: metadata.modified().ok().and_then(|when| when.elapsed().ok()).map(|age| age.as_secs_f64()).unwrap_or(0.0),
            })
        })
        .collect();
    files.sort_by(|left, right| left.seconds_old.total_cmp(&right.seconds_old));
    files
}

/// Finishes what a killed run left in the folder (a .db's write-ahead log, an mcap without its summary), so every
/// listed file opens. `active` is skipped.
pub fn recover_folder(directory: &Path, active: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(directory) else { return };
    for path in entries.flatten().map(|entry| entry.path()).filter(|path| is_recording_file(path) && Some(path.as_path()) != active) {
        let unfinished = match path.extension().and_then(|end| end.to_str()) {
            Some("db") => !rust_recorder::is_finished(&path),
            _ => !mcap_has_end_magic(&path),
        };
        if unfinished {
            let _ = rust_recorder::recover(&path);
        }
    }
}

fn mcap_has_end_magic(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else { return true };
    let mut tail = [0u8; 8];
    file.seek(SeekFrom::End(-8)).is_err() || file.read_exact(&mut tail).is_err() || tail == *b"\x89MCAP0\r\n"
}

/// Resolves a client-supplied recording name against the recording directory. Anything with a path separator or
/// another extension than .mcap / .db is refused, so a browser cannot talk the server into touching an unrelated file.
pub fn resolve(directory: &Path, name: &str) -> Result<PathBuf> {
    let mut parts = Path::new(name).components();
    let Some(std::path::Component::Normal(single)) = parts.next() else {
        anyhow::bail!("recording name must be a plain file name");
    };
    if parts.next().is_some() {
        anyhow::bail!("recording name must be a plain file name");
    }
    let path = directory.join(single);
    if !is_recording_file(&path) {
        anyhow::bail!("recording name must end in .mcap or .db");
    }
    Ok(path)
}

pub fn default_name(format: Format) -> String {
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|age| age.as_secs()).unwrap_or(0);
    format!("controller_{seconds}.{}", format.extension())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msgs;

    fn scratch(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("web_ctrl_test_{label}_{}", now_nanos()));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn known_types_get_a_ros2_schema_and_unknown_ones_survive_as_lcm() {
        let directory = scratch("mixed");
        let path = directory.join("out.mcap");
        let recorder = Recorder::start(&path, Format::Ros2Mcap, Compression::None, ImageFormat::Raw).unwrap();
        recorder.offer("/tele_cmd_vel", msgs::TWIST_TYPE, &msgs::encode_twist([1.0, 0.0, 0.0], [0.0, 0.0, 0.0]));
        recorder.offer("/mystery", "std_msgs.Float64MultiArray", &[7u8; 16]);
        // a type we do map, but whose bytes do not decode, must also survive
        recorder.offer("/garbled", "nav_msgs.Odometry", &[9u8; 16]);
        let status = recorder.finish().unwrap();
        assert_eq!(status.messages, 3);
        assert_eq!(status.fallback, 2);
        assert!(!status.active);

        let bytes = std::fs::read(&path).unwrap();
        let mut seen = HashMap::new();
        for message in mcap::MessageStream::new(&bytes).unwrap() {
            let message = message.unwrap();
            seen.insert(
                message.channel.topic.clone(),
                (message.channel.message_encoding.clone(), message.channel.schema.as_ref().map(|s| s.name.clone()), message.data.to_vec()),
            );
        }
        let (encoding, schema, data) = &seen["/tele_cmd_vel"];
        assert_eq!(encoding, "cdr");
        assert_eq!(schema.as_deref(), Some("geometry_msgs/msg/Twist"));
        assert_eq!(&data[4..12], &1.0f64.to_le_bytes());
        let (encoding, schema, data) = &seen["/mystery"];
        assert_eq!((encoding.as_str(), schema), ("lcm", &None));
        assert_eq!(data, &vec![7u8; 16]);
        let (encoding, schema, data) = &seen["/garbled"];
        assert_eq!((encoding.as_str(), schema), ("lcm", &None));
        assert_eq!(data, &vec![9u8; 16]);
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn every_format_records_and_reads_back() {
        let directory = scratch("formats");
        for format in [Format::Ros2Mcap, Format::DimosMcap, Format::Sqlite] {
            let path = directory.join(format!("out.{}", format.extension()));
            let recorder = Recorder::start(&path, format, Compression::Zstd, ImageFormat::Raw).unwrap();
            for _ in 0..64 {
                recorder.offer("/tele_cmd_vel", msgs::TWIST_TYPE, &msgs::encode_twist([1.0, 0.0, 0.0], [0.0, 0.0, 0.0]));
            }
            let status = recorder.finish().unwrap();
            assert_eq!(status.messages, 64, "{format:?}");
            if format == Format::Sqlite {
                let connection = rusqlite::Connection::open(&path).unwrap();
                let rows: i64 = connection.query_row(r#"SELECT count(*) FROM "tele_cmd_vel""#, [], |row| row.get(0)).unwrap();
                assert_eq!(rows, 64);
                assert!(rust_recorder::is_finished(&path));
            } else {
                let bytes = std::fs::read(&path).unwrap();
                assert_eq!(mcap::MessageStream::new(&bytes).unwrap().count(), 64, "{format:?}");
            }
        }
        assert!(Recorder::start(&directory.join("wrong.mcap"), Format::Sqlite, Compression::None, ImageFormat::Raw).is_err());
        std::fs::remove_dir_all(&directory).unwrap();
    }

    /// The LCM bytes of a `sensor_msgs.Image`, since the recorder only ever sees a topic plus a wire payload.
    fn lcm_image(encoding: &str, bytes_per_pixel: usize) -> Vec<u8> {
        let (width, height) = (8usize, 4usize);
        let pixels = width * height * bytes_per_pixel;
        let mut payload = Vec::new();
        payload.extend_from_slice(&msgs::IMAGE_FINGERPRINT);
        payload.extend_from_slice(&(pixels as i32).to_be_bytes());
        for field in [0i32, 0, 0] {
            payload.extend_from_slice(&field.to_be_bytes());
        }
        let push_string = |value: &str, payload: &mut Vec<u8>| {
            payload.extend_from_slice(&((value.len() + 1) as u32).to_be_bytes());
            payload.extend_from_slice(value.as_bytes());
            payload.push(0);
        };
        push_string("camera_link", &mut payload);
        payload.extend_from_slice(&(height as i32).to_be_bytes());
        payload.extend_from_slice(&(width as i32).to_be_bytes());
        push_string(encoding, &mut payload);
        payload.push(0);
        payload.extend_from_slice(&((width * bytes_per_pixel) as i32).to_be_bytes());
        payload.extend((0..pixels).map(|index| (index * 11) as u8));
        payload
    }

    #[test]
    fn a_chosen_image_format_applies_only_where_it_fits() {
        let directory = scratch("image_format");
        let path = directory.join("out.mcap");
        let recorder = Recorder::start(&path, Format::Ros2Mcap, Compression::None, ImageFormat::Webp).unwrap();
        recorder.offer("/camera", msgs::IMAGE_TYPE, &lcm_image("rgb8", 3));
        recorder.offer("/depth", msgs::IMAGE_TYPE, &lcm_image("16UC1", 2));
        recorder.finish().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let mut seen = HashMap::new();
        for message in mcap::MessageStream::new(&bytes).unwrap() {
            let message = message.unwrap();
            seen.insert(message.channel.topic.clone(), message.channel.schema.as_ref().map(|s| s.name.clone()));
        }
        assert_eq!(seen["/camera"].as_deref(), Some("sensor_msgs/msg/CompressedImage"));
        // webp cannot hold 16-bit samples, so depth keeps its full precision
        assert_eq!(seen["/depth"].as_deref(), Some("sensor_msgs/msg/Image"));
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn resolve_refuses_to_escape_the_recording_directory() {
        let directory = Path::new("/tmp/recordings");
        assert!(resolve(directory, "../../etc/passwd.mcap").is_err());
        assert!(resolve(directory, "nested/run.mcap").is_err());
        assert!(resolve(directory, "run.txt").is_err());
        assert_eq!(resolve(directory, "run.mcap").unwrap(), Path::new("/tmp/recordings/run.mcap"));
        assert_eq!(resolve(directory, "run.db").unwrap(), Path::new("/tmp/recordings/run.db"));
    }

    #[test]
    fn listing_reports_size_and_ignores_other_files() {
        let directory = scratch("listing");
        std::fs::write(directory.join("a.mcap"), [0u8; 12]).unwrap();
        std::fs::write(directory.join("b.db"), [0u8; 5]).unwrap();
        std::fs::write(directory.join("b.db-wal"), [0u8; 3]).unwrap();
        std::fs::write(directory.join("notes.txt"), [0u8; 3]).unwrap();
        let mut names: Vec<String> = list(&directory).into_iter().map(|file| file.name).collect();
        names.sort();
        assert_eq!(names, vec!["a.mcap", "b.db"]);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
