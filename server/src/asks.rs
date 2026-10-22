//! What a recording needs that dimos only sends when asked: the robot's meshes (UrdfManager answers each `package://`
//! name on /file_request with the file on /file_info) and a simulated world (a SceneData module answers
//! /scene_data_request on /scene_data). A recording of /robot_description or /scene_info also records the answer stream, and
//! this asks for what the announcement names, so the file can draw the robot and the world with no robot around.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::msgs::{Reader, STRING_FINGERPRINT};

/// meshes asked for at once: a reply can be several MB
const MESHES_IN_FLIGHT: usize = 2;
/// a mesh asked for this long ago without a reply is asked for again
const MESH_RETRY: Duration = Duration::from_secs(30);
const MESH_ATTEMPTS: u32 = 3;
const SCENE_ASK_EVERY: Duration = Duration::from_secs(2);
const TICK: Duration = Duration::from_millis(250);
/// how long a stopping recording waits for what it asked for: as long as a mesh is asked for before it's given up on
pub const SETTLE_LIMIT: Duration = Duration::from_secs(MESH_RETRY.as_secs() * MESH_ATTEMPTS as u64);

/// an empty /file_request has the robot's UrdfManager send /robot_description now
const URDF_NOW_KEY: &str = "dimos/file_request/std_msgs.String";

/// `dimos/<ns>/<name>/<type>` → `dimos/<ns>/<sibling>`, for a key whose topic ends in `name`.
fn sibling(key: &str, name: &str, type_name: &str, sibling: &str) -> Option<String> {
    let prefix = key.strip_suffix(&format!("{name}/{type_name}"))?;
    prefix.ends_with('/').then(|| format!("{prefix}{sibling}"))
}

/// The answer streams a recorded key brings along (/robot_description → /file_info and /file_info/**, /scene_info → /scene_data).
pub fn answer_keys(key: &str) -> Vec<String> {
    [
        sibling(
            key,
            "robot_description",
            "std_msgs.String",
            "file_info/**/files.MeshFile",
        ),
        sibling(
            key,
            "scene_info",
            "std_msgs.String",
            "scene_data/std_msgs.String",
        ),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// std_msgs.String's LCM wire form.
pub fn encode_string(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(13 + text.len());
    out.extend_from_slice(&STRING_FINGERPRINT);
    out.extend_from_slice(&(text.len() as u32 + 1).to_be_bytes());
    out.extend_from_slice(text.as_bytes());
    out.push(0);
    out
}

fn decode_string(payload: &[u8]) -> Option<String> {
    let mut reader = Reader::new(payload);
    reader.expect_fingerprint(&STRING_FINGERPRINT).ok()?;
    reader.string().ok()
}

/// Every `<mesh filename="...">` in a URDF, once each.
pub fn mesh_uris(urdf: &str) -> BTreeSet<String> {
    let mut uris = BTreeSet::new();
    for (start, _) in urdf.match_indices("<mesh") {
        let tag = &urdf[start
            ..urdf[start..]
                .find('>')
                .map_or(urdf.len(), |end| start + end)];
        let Some(at) = tag.find("filename=") else {
            continue;
        };
        let rest = &tag[at + "filename=".len()..];
        let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            continue;
        };
        if let Some(end) = rest[1..].find(quote) {
            uris.insert(rest[1..1 + end].to_string());
        }
    }
    uris
}

/// files.MeshFile's uri: `<f64 ts><u32 uri length LE><uri><file bytes>` (dimos/msgs/files/MeshFile.py).
pub fn mesh_file_uri(payload: &[u8]) -> Option<String> {
    let length = u32::from_le_bytes(payload.get(8..12)?.try_into().ok()?) as usize;
    Some(String::from_utf8_lossy(payload.get(12..12 + length)?).into_owned())
}

#[derive(Default)]
struct Meshes {
    /// where to ask (the /file_request beside the /robot_description heard)
    request_key: String,
    wanted: BTreeSet<String>,
    got: HashSet<String>,
    /// uri → (last asked, times asked)
    asked: HashMap<String, (Instant, u32)>,
}

#[derive(Default)]
struct Wanted {
    meshes: Meshes,
    /// /scene_data_request key → when last asked (until a /scene_data arrives)
    scenes: HashMap<String, Option<Instant>>,
    scene_answered: bool,
}

#[derive(Default)]
pub struct Asks {
    done: AtomicBool,
    asking: AtomicBool,
    wanted: Mutex<Wanted>,
}

impl Asks {
    /// Starts asking on `session` (every TICK, until `stop`): once, when an announcement is first recorded, so a
    /// recording without one opens no session for it.
    pub fn ask_on(self: &Arc<Self>, session: zenoh::Session) {
        if self.asking.swap(true, Ordering::Relaxed) {
            return;
        }
        let looping = self.clone();
        tokio::spawn(async move {
            let _ = session.put(URDF_NOW_KEY, encode_string("")).await;
            while !looping.done.load(Ordering::Relaxed) {
                for (key, payload) in looping.due(Instant::now()) {
                    let _ = session.put(key, payload).await;
                }
                tokio::time::sleep(TICK).await;
            }
        });
    }

    /// Whether a recorded key is an announcement (its answers are asked for).
    pub fn announces(key: &str) -> bool {
        !answer_keys(key).is_empty()
    }

    pub fn stop(&self) {
        self.done.store(true, Ordering::Relaxed);
    }

    /// Whether everything asked for has come or been given up on (each mesh after MESH_ATTEMPTS, a scene once one came).
    pub fn settled(&self, now: Instant) -> bool {
        let wanted = self.wanted.lock().unwrap();
        let meshes = &wanted.meshes;
        let meshes_done = meshes.wanted.iter().all(|uri| {
            meshes.got.contains(uri)
                || meshes.asked.get(uri).is_some_and(|(when, times)| {
                    *times >= MESH_ATTEMPTS && now.duration_since(*when) >= MESH_RETRY
                })
        });
        meshes_done && (wanted.scenes.is_empty() || wanted.scene_answered)
    }

    /// A recorded message: an announcement says what to ask for, an answer checks it off.
    pub fn heard(&self, key: &str, payload: &[u8]) {
        let mut wanted = self.wanted.lock().unwrap();
        if let Some(request_key) = sibling(
            key,
            "robot_description",
            "std_msgs.String",
            "file_request/std_msgs.String",
        ) {
            // the URDF is re-sent every few seconds: read it once (a different one, e.g. a restart, adds its meshes)
            if let Some(urdf) = decode_string(payload) {
                let meshes = &mut wanted.meshes;
                meshes.request_key = request_key;
                meshes.wanted.extend(mesh_uris(&urdf));
            }
        } else if key.ends_with("/files.MeshFile") && key.contains("/file_info/") {
            if let Some(uri) = mesh_file_uri(payload) {
                wanted.meshes.got.insert(uri);
            }
        } else if let Some(request_key) = sibling(
            key,
            "scene_info",
            "std_msgs.String",
            "scene_data_request/std_msgs.String",
        ) {
            wanted.scenes.entry(request_key).or_insert(None);
        } else if key.ends_with("/scene_data/std_msgs.String") {
            wanted.scene_answered = true;
        }
    }

    /// The requests to send now.
    fn due(&self, now: Instant) -> Vec<(String, Vec<u8>)> {
        let mut wanted = self.wanted.lock().unwrap();
        let mut out = Vec::new();
        let meshes = &mut wanted.meshes;
        let in_flight = meshes
            .asked
            .iter()
            .filter(|(uri, (when, _))| {
                !meshes.got.contains(*uri) && now.duration_since(*when) < MESH_RETRY
            })
            .count();
        let next: Vec<String> = meshes
            .wanted
            .iter()
            .filter(|uri| !meshes.got.contains(*uri))
            .filter(|uri| match meshes.asked.get(*uri) {
                None => true,
                Some((when, times)) => {
                    *times < MESH_ATTEMPTS && now.duration_since(*when) >= MESH_RETRY
                }
            })
            .take(MESHES_IN_FLIGHT.saturating_sub(in_flight))
            .cloned()
            .collect();
        for uri in next {
            let times = meshes.asked.get(&uri).map_or(0, |(_, times)| *times);
            meshes.asked.insert(uri.clone(), (now, times + 1));
            out.push((meshes.request_key.clone(), encode_string(&uri)));
        }
        if !wanted.scene_answered {
            for (key, last) in wanted.scenes.iter_mut() {
                if last.is_none_or(|when| now.duration_since(when) >= SCENE_ASK_EVERY) {
                    *last = Some(now);
                    out.push((key.clone(), encode_string("dim-recorder")));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn announcements_bring_their_answer_streams() {
        assert_eq!(
            answer_keys("dimos/robot_description/std_msgs.String"),
            vec!["dimos/file_info/**/files.MeshFile"]
        );
        assert_eq!(
            answer_keys("dimos/r1/scene_info/std_msgs.String"),
            vec!["dimos/r1/scene_data/std_msgs.String"]
        );
        assert!(answer_keys("dimos/odom/nav_msgs.Odometry").is_empty());
        assert!(answer_keys("dimos/not_robot_description/std_msgs.String").is_empty());
    }

    #[test]
    fn mesh_names_come_from_the_urdf() {
        let urdf = r#"<robot name="r"><link name="a"><visual><geometry><mesh filename="package://r/a.STL" scale="1 1 1"/></geometry></visual>
            <collision><geometry><mesh filename='package://r/b.obj'/></geometry></collision></link>
            <link name="c"><visual><geometry><mesh filename="package://r/a.STL"/></geometry></visual></link></robot>"#;
        assert_eq!(
            mesh_uris(urdf).into_iter().collect::<Vec<_>>(),
            vec!["package://r/a.STL", "package://r/b.obj"]
        );
    }

    #[test]
    fn a_string_round_trips() {
        assert_eq!(
            decode_string(&encode_string("package://x.stl")).as_deref(),
            Some("package://x.stl")
        );
    }
}
