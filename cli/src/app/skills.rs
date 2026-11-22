use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::collect::CollectReport;
use crate::adapters::fsutil::write_atomically;
use crate::adapters::http::{HttpSender, SendError};
use crate::adapters::skills::{Skill, TOOLS, discover};
use crate::domain::{Millis, fnv1a64};

const CHECK_INTERVAL_MS: Millis = 10 * 60_000;
const RETRY_INTERVAL_MS: Millis = 60_000;

#[derive(Default, Serialize, Deserialize)]
struct Checkpoints {
    destination: u64,
    #[serde(default)]
    codex_inventory_version: u32,
    tools: BTreeMap<String, Checkpoint>,
}

#[derive(Default, Serialize, Deserialize)]
struct Checkpoint {
    checked_at: Millis,
    retry: bool,
    sent_fingerprint: Option<u64>,
}

impl Checkpoint {
    fn due(&self, now: Millis) -> bool {
        let age = now.saturating_sub(self.checked_at);
        self.checked_at == 0
            || age < 0
            || age
                >= if self.retry {
                    RETRY_INTERVAL_MS
                } else {
                    CHECK_INTERVAL_MS
                }
    }

    fn send_changed(
        &mut self,
        tool: &str,
        skills: Vec<Skill>,
        send: impl FnOnce(&str, usize) -> Result<(), SendError>,
    ) -> Result<bool, SendError> {
        let body = json!({"tools":[tool],"skills":skills}).to_string();
        let fingerprint = fnv1a64(body.as_bytes());
        if self.sent_fingerprint == Some(fingerprint) {
            return Ok(false);
        }
        send(&body, skills.len())?;
        self.sent_fingerprint = Some(fingerprint);
        Ok(true)
    }
}

/// Called under collect.lock, after session data has been saved.
pub fn sync(home: &Path, cwd: &Path, now: Millis, sender: &HttpSender, report: &mut CollectReport) {
    let path = home.join("skill-sync.json");
    let mut checkpoints = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(e) if e.kind() == ErrorKind::NotFound => Checkpoints::default(),
        Err(_) => {
            report.errors.push("cannot read skill sync state".into());
            return;
        }
    };
    let destination = fnv1a64(
        json!([sender.url, sender.client_id, cwd])
            .to_string()
            .as_bytes(),
    );
    if checkpoints.destination != destination {
        checkpoints = Checkpoints {
            destination,
            ..Default::default()
        };
    }
    // Older inventories could be acknowledged while the remote plugins were still loading.
    // Recheck Codex immediately but preserve its last confirmed fingerprint for retries.
    let mut dirty = checkpoints.codex_inventory_version != 2;
    if dirty {
        checkpoints.codex_inventory_version = 2;
        if let Some(cp) = checkpoints.tools.get_mut("codex") {
            cp.checked_at = 0;
        }
    }
    for (tool, label) in TOOLS {
        if report.auth_failed {
            break;
        }
        let cp = checkpoints.tools.entry(label.to_string()).or_default();
        if !cp.due(now) {
            continue;
        }
        dirty = true;
        cp.checked_at = now;
        cp.retry = true;
        match discover(tool, cwd) {
            Err(reason) => report.errors.push(format!("{label} skills: {reason}")),
            Ok(rows) => {
                match cp.send_changed(label, rows, |body, count| sender.send_skills(body, count)) {
                    Ok(sent) => {
                        cp.retry = false;
                        if sent {
                            report.skill_inventories_sent += 1;
                        }
                    }
                    Err(err) => {
                        let reason = match err {
                            SendError::Auth(status) => {
                                report.auth_failed = true;
                                format!("authentication failed (HTTP {status})")
                            }
                            SendError::Rejected { status, .. } | SendError::Server(status) => {
                                format!("HTTP {status}")
                            }
                            SendError::Network(_) => "network error".into(),
                        };
                        report
                            .errors
                            .push(format!("{label} skills: upload failed: {reason}"));
                    }
                }
            }
        }
    }
    if dirty && write_atomically(&path, &serde_json::to_vec(&checkpoints).unwrap()).is_err() {
        report.errors.push("cannot save skill sync state".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Tool;

    #[test]
    fn retries_failed_replacements_and_records_successful_empty_snapshots() {
        let mut cp = Checkpoint::default();
        let rows = vec![Skill {
            tool: Tool::Codex,
            name: "alpha".into(),
            description: "description".into(),
        }];
        assert!(cp.send_changed("codex", rows, |_, _| Ok(())).unwrap());
        let first = cp.sent_fingerprint.unwrap();
        assert!(
            cp.send_changed("codex", vec![], |_, _| Err(SendError::Server(500)))
                .is_err()
        );
        assert_eq!(cp.sent_fingerprint, Some(first));
        assert!(
            cp.send_changed("codex", vec![], |body, count| {
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(body).unwrap(),
                    json!({"tools":["codex"],"skills":[]})
                );
                assert_eq!(count, 0);
                Ok(())
            })
            .unwrap()
        );
        assert!(
            !cp.send_changed("codex", vec![], |_, _| panic!("already sent"))
                .unwrap()
        );
    }
}
