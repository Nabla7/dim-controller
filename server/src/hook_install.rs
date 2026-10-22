//! Installing server/python/dim_controller_hook into a blueprint's venv: the server carries the hook's files (so an app
//! built into the nix store can still hand them out), writes them to a cache folder, and runs install_hook.py
//! from there, which finds the venvs (dimos's run registry) and copies the package in.
use std::path::PathBuf;

use anyhow::{bail, Context, Result};

const FILES: &[(&str, &str)] = &[
    ("install_hook.py", include_str!("../python/install_hook.py")),
    ("dim_controller_hook/__init__.py", include_str!("../python/dim_controller_hook/__init__.py")),
    ("dim_controller_hook/boot.py", include_str!("../python/dim_controller_hook/boot.py")),
    ("dim_controller_hook/tee.py", include_str!("../python/dim_controller_hook/tee.py")),
];

fn cache_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("dim-controller").join("hook")
}

/// Run install_hook.py with `args`; its output.
pub async fn run(args: &[&str]) -> Result<String> {
    let dir = cache_dir();
    for (path, contents) in FILES {
        let path = dir.join(path);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, contents).with_context(|| format!("writing {}", path.display()))?;
    }
    let output = tokio::process::Command::new("python3")
        .arg(dir.join("install_hook.py"))
        .args(args)
        .output()
        .await
        .context("running python3 (install_hook.py needs any python 3)")?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        bail!("{}{}", text, String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(text)
}
