//! The machine the backend runs on (the robot's computer): its CPU load, sampled every SAMPLE_SECS in the background
//! (Linux: one small file read; macOS: one kernel call), so serving it costs nothing. The page's CPU chip polls it.
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

const SAMPLE_SECS: u64 = 5;

#[derive(Clone, Copy)]
struct Sample {
    /// percent of all cores busy over the last SAMPLE_SECS
    busy_percent: f64,
    /// unix ms
    at: u128,
}

static CPU: Mutex<Option<Sample>> = Mutex::new(None);

pub fn spawn() {
    tokio::spawn(async move {
        let mut previous = cpu_times();
        loop {
            tokio::time::sleep(Duration::from_secs(SAMPLE_SECS)).await;
            let current = cpu_times();
            // a counter that went backwards (macOS's 32-bit ticks wrap) skips that sample
            if let (Some((busy0, total0)), Some((busy1, total1))) = (previous, current) {
                if total1 > total0 && busy1 >= busy0 {
                    let busy_percent = 100.0 * (busy1 - busy0) as f64 / (total1 - total0) as f64;
                    let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                    *CPU.lock().unwrap() = Some(Sample { busy_percent, at });
                }
            }
            previous = current;
        }
    });
}

/// Linux (x86 and ARM alike): /proc/stat's first line, every core's (busy jiffies, all jiffies)
#[cfg(target_os = "linux")]
fn cpu_times() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let fields: Vec<u64> = stat.lines().next()?.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    // user nice system idle iowait irq softirq steal (guest time is already inside user)
    let total: u64 = fields.iter().take(8).sum();
    let idle = fields.get(3)? + fields.get(4).unwrap_or(&0);
    Some((total - idle, total))
}

#[cfg(target_os = "macos")]
extern "C" {
    fn mach_host_self() -> u32;
    fn host_statistics(host: u32, flavor: i32, info: *mut u32, count: *mut u32) -> i32;
}

/// macOS: the kernel's CPU ticks summed over every core (HOST_CPU_LOAD_INFO: user, system, idle, nice)
#[cfg(target_os = "macos")]
fn cpu_times() -> Option<(u64, u64)> {
    const HOST_CPU_LOAD_INFO: i32 = 3;
    static HOST: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    // SAFETY: mach_host_self takes nothing; asked once, as each call adds a reference to the port
    let host = *HOST.get_or_init(|| unsafe { mach_host_self() });
    let mut ticks = [0u32; 4];
    let mut count = ticks.len() as u32;
    // SAFETY: the buffer holds `count` naturals, which host_statistics fills at most
    let status = unsafe { host_statistics(host, HOST_CPU_LOAD_INFO, ticks.as_mut_ptr(), &mut count) };
    if status != 0 {
        return None;
    }
    let [user, system, idle, nice] = ticks.map(u64::from);
    Some((user + system + nice, user + system + idle + nice))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn cpu_times() -> Option<(u64, u64)> {
    None
}

pub async fn get() -> Response {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let sample = *CPU.lock().unwrap();
    Json(json!({
        "cpu": sample.map(|s| json!({ "busyPercent": (s.busy_percent * 10.0).round() / 10.0, "cores": cores, "sampledAt": s.at, "everySecs": SAMPLE_SECS })),
    }))
    .into_response()
}
