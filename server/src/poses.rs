//! Saved arm poses, per robot model: `<dimos home>/app_data/manip_data/<URDF name>/poses.yaml`, a `poses:` list of
//! `{name, color, target}` (target as api/manipulation/target takes it). The page shows each as a button that sets it as
//! the target; the whole list is written at once.
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

/// `$DIMOS_HOME`, else `~/.dimos`.
pub fn dimos_home() -> PathBuf {
    std::env::var("DIMOS_HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".dimos"))
}

/// A URDF name usable as a directory: letters, digits, `.`, `_` and `-` only (no path tricks).
pub fn valid_robot(robot: &str) -> bool {
    !robot.is_empty() && robot.len() <= 100 && !robot.starts_with('.') && robot.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

pub fn file(home: &Path, robot: &str) -> PathBuf {
    home.join("app_data").join("manip_data").join(robot).join("poses.yaml")
}

/// The saved poses (none when there's no file yet).
pub fn load(home: &Path, robot: &str) -> Result<Vec<Value>> {
    let path = file(home, robot);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(anyhow!("{}: {error}", path.display())),
    };
    let document: Value = serde_yaml::from_str(&text).map_err(|error| anyhow!("{}: {error}", path.display()))?;
    Ok(document["poses"].as_array().cloned().unwrap_or_default())
}

/// Each pose has a name and a target object; color is a string or absent.
pub fn validate(poses: &Value) -> Result<Vec<Value>> {
    let list = poses.as_array().ok_or_else(|| anyhow!("poses: a list"))?;
    for pose in list {
        if !pose["name"].is_string() || !pose["target"].is_object() || !(pose["color"].is_null() || pose["color"].is_string()) {
            return Err(anyhow!("each pose is {{name, color?, target}}"));
        }
    }
    Ok(list.clone())
}

pub fn save(home: &Path, robot: &str, poses: &[Value]) -> Result<PathBuf> {
    let path = file(home, robot);
    std::fs::create_dir_all(path.parent().unwrap())?;
    let text = serde_yaml::to_string(&json!({ "poses": poses }))?;
    std::fs::write(&path, format!("# saved arm poses for {robot} (dim-controller's Arm panel)\n{text}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poses_survive_a_save_and_load_and_names_cannot_escape() {
        let home = std::env::temp_dir().join(format!("poses-test-{}", std::process::id()));
        assert!(load(&home, "r1pro").unwrap().is_empty());
        let poses = validate(&json!([{ "name": "reach", "color": "#e5484d", "target": { "groups": ["left_arm"], "joints": { "r1pro/left_arm_joint1": -0.35 }, "poses": {}, "source": "joints" } }])).unwrap();
        let path = save(&home, "r1pro", &poses).unwrap();
        assert!(path.ends_with("app_data/manip_data/r1pro/poses.yaml"));
        assert_eq!(load(&home, "r1pro").unwrap(), poses);
        assert!(validate(&json!([{ "name": "no target" }])).is_err());
        for bad in ["", "..", "../etc", "a/b", ".hidden"] {
            assert!(!valid_robot(bad), "{bad}");
        }
        assert!(valid_robot("r1pro") && valid_robot("xarm7_description-v2.1"));
        let _ = std::fs::remove_dir_all(home);
    }
}
