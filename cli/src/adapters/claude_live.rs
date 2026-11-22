//! Claude Code's local interactive-session registry updates when a permission
//! dialog closes, before the tool finishes. Its timestamps are Unix milliseconds.
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;
use std::process::Command;

use serde::Deserialize;

use crate::domain::{Millis, ObservedState, StatusObservation};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    pid: u32,
    proc_start: String,
    kind: String,
    session_id: String,
    status: String,
    status_updated_at: Millis,
}

fn read_entries(registry: &Path) -> io::Result<Vec<Entry>> {
    let entries = match fs::read_dir(registry) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut active = Vec::new();
    for item in entries {
        let item = item?;
        let path = item.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") || !item.file_type()?.is_file()
        {
            continue;
        }
        let Some(pid) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        // A concurrent exit may remove the file between listing and opening.
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let Ok(entry) = serde_json::from_slice::<Entry>(&bytes) else {
            continue;
        };
        if entry.pid == pid
            && entry.kind == "interactive"
            && !entry.session_id.is_empty()
            && entry.status_updated_at > 0
            && matches!(entry.status.as_str(), "waiting" | "busy")
        {
            active.push(entry);
        }
    }
    Ok(active)
}

fn observations(entries: Vec<Entry>, process_table: &str) -> HashMap<String, StatusObservation> {
    let processes: HashMap<u32, &str> = process_table
        .lines()
        .filter_map(|line| {
            let (id, start) = line.trim().split_once(char::is_whitespace)?;
            Some((id.parse().ok()?, start.trim()))
        })
        .collect();
    let mut latest: HashMap<String, StatusObservation> = HashMap::new();
    for entry in entries {
        // Crashed sessions can leave a registry file behind; even a live PID
        // is insufficient if macOS has since reused it for a different process.
        if processes.get(&entry.pid).copied() != Some(entry.proc_start.trim()) {
            continue;
        }
        let state = if entry.status == "waiting" {
            ObservedState::Waiting
        } else {
            ObservedState::Running
        };
        let obs = StatusObservation {
            state,
            at: entry.status_updated_at,
        };
        let saved = latest.entry(entry.session_id).or_insert(obs);
        if obs.at > saved.at {
            *saved = obs;
        }
    }
    latest
}

pub fn read_statuses(registry: &Path) -> io::Result<HashMap<String, StatusObservation>> {
    let entries = read_entries(registry)?;
    if entries.is_empty() {
        return Ok(HashMap::new());
    }
    // Claude records procStart using a C-locale UTC lstart string on macOS.
    // Only request process identity fields, never arguments or environment.
    let table = Command::new("/bin/ps")
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .args(["-axo", "pid=,lstart="])
        .output()?;
    if !table.status.success() {
        return Err(io::Error::other("cannot verify Claude session PIDs"));
    }
    Ok(observations(
        entries,
        &String::from_utf8_lossy(&table.stdout),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_live_permission_and_resume_but_skips_idle_and_reused_pids() {
        let dir =
            std::env::temp_dir().join(format!("taskfolio-claude-live-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut entry = json!({"pid":23,"kind":"interactive","procStart":"Sun Nov 22 07:50:41 2026",
            "sessionId":"session","status":"waiting","statusUpdatedAt":101});
        let file = dir.join("23.json");
        let table = "   23 Sun Nov 22 07:50:41 2026    \n";
        for (name, at, expected) in [
            ("waiting", 101, Some(ObservedState::Waiting)),
            ("busy", 102, Some(ObservedState::Running)),
            ("idle", 103, None),
        ] {
            entry["status"] = name.into();
            entry["statusUpdatedAt"] = at.into();
            fs::write(&file, entry.to_string()).unwrap();
            let result = observations(read_entries(&dir).unwrap(), table);
            assert_eq!(
                result.get("session").copied(),
                expected.map(|state| StatusObservation { state, at })
            );
        }
        entry["status"] = "busy".into();
        fs::write(file, entry.to_string()).unwrap();
        assert!(
            observations(read_entries(&dir).unwrap(), "23 Tue Nov 24 00:00:00 2026").is_empty()
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
