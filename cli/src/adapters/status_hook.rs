use std::fs;
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};

use super::fsutil::{open_private_file, write_atomically};
use super::hook_process::ProcessIdentity;
use crate::domain::{ObservedState, StatusObservation, Tool};

#[derive(Deserialize)]
struct HookInput {
    session_id: String,
    hook_event_name: String,
    turn_id: Option<String>,
    prompt_id: Option<String>,
    agent_id: Option<String>,
    notification_type: Option<String>,
    last_assistant_message: Option<String>,
    #[serde(default)]
    stop_hook_active: bool,
    #[serde(default)]
    background_tasks: Vec<IgnoredAny>,
    #[serde(default)]
    session_crons: Vec<IgnoredAny>,
}

impl HookInput {
    fn evidence(&self, tool: Tool) -> Option<Evidence> {
        use ObservedState::{Running, Unknown, Waiting};
        // Subagent hooks can carry the parent's session_id.
        if self.agent_id.as_deref().is_some_and(|id| !id.is_empty()) {
            return None;
        }
        if tool == Tool::Codex && self.hook_event_name == "PermissionRequest" {
            let turn = self.turn_id.as_ref().filter(|id| valid_id(id))?;
            return Some(Evidence::PermissionRequest {
                pending_permission_turn: turn.clone(),
                last_confirmed: None,
            });
        }
        let state = match (tool, self.hook_event_name.as_str()) {
            (_, "UserPromptSubmit") => Running,
            // Another parallel tool may still be waiting when PostToolUse fires.
            (Tool::ClaudeCode, "PostToolBatch") | (Tool::Codex, "PreModelRequest") => Running,
            (Tool::ClaudeCode, "Notification") if self.notification_type.as_deref() == Some("permission_prompt") => {
                Waiting
            }
            (_, "Stop") => {
                if self
                    .last_assistant_message
                    .as_ref()
                    .is_some_and(|s| !s.trim().is_empty())
                    && self.background_tasks.is_empty()
                    && self.session_crons.is_empty()
                    && !self.stop_hook_active
                {
                    Waiting
                } else {
                    Unknown
                }
            }
            (Tool::Codex, "Interrupt") | (Tool::ClaudeCode, "StopFailure") => Unknown,
            _ => return None,
        };
        Some(Evidence::Observed { state, owner: None })
    }
}

// The hook protocols provide session IDs but no event timestamp. Capture receipt before
// reading the payload, which can be large. Keep nanoseconds locally to order bursts.
#[derive(Serialize, Deserialize)]
struct Snapshot {
    at_ns: u64,
    #[serde(flatten)]
    evidence: Evidence,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum Evidence {
    Observed {
        state: ObservedState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        owner: Option<RunningOwner>,
    },
    // Codex sends this before resolving approval hooks and choosing the reviewer.
    PermissionRequest {
        pending_permission_turn: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_confirmed: Option<TimedState>,
    },
}

#[derive(Clone, Serialize, Deserialize)]
struct RunningOwner {
    #[serde(flatten)]
    process: ProcessIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct TimedState {
    at_ns: u64,
    state: ObservedState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner: Option<RunningOwner>,
}

impl TimedState {
    pub(crate) fn observation(&self) -> StatusObservation {
        StatusObservation { state: self.state, at: (self.at_ns / 1_000_000) as i64 }
    }

    pub(crate) fn owner_exited(&self, current: StatusObservation, turn_id: Option<&str>) -> bool {
        let Some(owner) = &self.owner else { return false };
        // A later log-only turn can belong to an untracked client that resumed
        // this same session. Only extend the hook's evidence across matching turns.
        let matches_turn = match (owner.turn_id.as_deref(), turn_id) {
            (Some(hook), Some(log)) => hook == log,
            _ => current == self.observation(),
        };
        self.state == ObservedState::Running && current.state == ObservedState::Running
            && matches_turn && owner.process.exited()
    }
}

impl Snapshot {
    fn confirmed(&self) -> Option<TimedState> {
        match &self.evidence {
            Evidence::Observed { state, owner } => Some(TimedState {
                at_ns: self.at_ns,
                state: *state,
                owner: owner.clone(),
            }),
            Evidence::PermissionRequest { last_confirmed, .. } => last_confirmed.clone(),
        }
    }

    fn remember_confirmed(&mut self, old: &Self) -> bool {
        let Evidence::PermissionRequest { last_confirmed, .. } = &mut self.evidence else {
            return false;
        };
        let Some(confirmed) = old.confirmed() else { return false };
        if last_confirmed.as_ref().is_some_and(|prior| prior.at_ns >= confirmed.at_ns) {
            return false;
        }
        *last_confirmed = Some(confirmed);
        true
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn path_for(home: &Path, tool: Tool, id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    let dir = match tool {
        Tool::ClaudeCode => "claude",
        Tool::Codex => "codex",
    };
    Some(home.join("status").join(dir).join(format!("{id}.json")))
}

fn read_snapshot(path: &Path) -> io::Result<Option<Snapshot>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Latest confirmed hook state, including the state immediately before a permission request.
pub fn read_latest(home: &Path, tool: Tool, session_id: &str) -> io::Result<Option<StatusObservation>> {
    Ok(read_confirmed(home, tool, session_id)?.map(|snap| snap.observation()))
}

pub(crate) fn read_confirmed(home: &Path, tool: Tool, session_id: &str) -> io::Result<Option<TimedState>> {
    let Some(path) = path_for(home, tool, session_id) else { return Ok(None) };
    Ok(read_snapshot(&path)?.and_then(|snap| snap.confirmed()))
}

/// Returns only a pending permission request for the specified human-reviewed turn.
pub fn read_for_turn(
    home: &Path,
    tool: Tool,
    session_id: &str,
    human_review_turn: Option<&str>,
) -> io::Result<Option<StatusObservation>> {
    let Some(path) = path_for(home, tool, session_id) else {
        return Ok(None);
    };
    Ok(read_snapshot(&path)?.and_then(|snap| {
        let Evidence::PermissionRequest {
            pending_permission_turn,
            ..
        } = snap.evidence
        else {
            return None;
        };
        (human_review_turn == Some(pending_permission_turn.as_str())).then_some(StatusObservation {
            state: ObservedState::Waiting,
            at: (snap.at_ns / 1_000_000) as i64,
        })
    }))
}

pub fn collect_queue(home: &Path) -> PathBuf {
    home.join("collect-queue")
}

/// Consume the single wakeup before reading any snapshots. Events arriving during
/// a slow collection then leave the queue nonempty for launchd's next run.
pub(crate) fn take_collect_request(home: &Path) -> io::Result<()> {
    match fs::remove_file(collect_queue(home).join("pending")) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub fn record(home: &Path, tool: Tool, input: impl Read) -> io::Result<()> {
    let time = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(io::Error::other)?;
    let at_ns = u64::try_from(time.as_nanos()).map_err(io::Error::other)?;
    let event: HookInput = serde_json::from_reader(BufReader::new(input))?;
    let Some(mut evidence) = event.evidence(tool) else {
        return Ok(());
    };
    let Some(path) = path_for(home, tool, &event.session_id) else {
        return Ok(());
    };
    if let Evidence::Observed { state: ObservedState::Running, owner } = &mut evidence {
        let turn_id = match tool { Tool::ClaudeCode => event.prompt_id, Tool::Codex => event.turn_id };
        *owner = ProcessIdentity::for_hook(tool).map(|process| RunningOwner {
            process, turn_id: turn_id.filter(|id| valid_id(id)),
        });
    }
    update(&path, Snapshot { evidence, at_ns })?;
    open_private_file(&collect_queue(home), "pending")?;
    Ok(())
}

fn update(path: &Path, mut next: Snapshot) -> io::Result<()> {
    let dir = path.parent().expect("snapshot path has a parent");
    // Lock a stable inode: the snapshot itself is replaced atomically for lock-free readers.
    let lock = open_private_file(dir, "write.lock")?;
    lock.lock()?;
    if let Some(mut old) = read_snapshot(path)? {
        if old.at_ns > next.at_ns {
            // An older confirmed event can finish reading stdin after a newer permission request.
            if !old.remember_confirmed(&next) {
                return Ok(());
            }
            next = old;
        } else {
            next.remember_confirmed(&old);
        }
    }
    write_atomically(path, &serde_json::to_vec(&next)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ObservedState::{Running, Unknown, Waiting};
    use Tool::{ClaudeCode, Codex};
    use serde_json::{Value, json};

    fn state(tool: Tool, event: &str, mut fields: Value) -> Option<ObservedState> {
        fields["hook_event_name"] = event.into();
        fields["session_id"] = "session".into();
        match serde_json::from_value::<HookInput>(fields).unwrap().evidence(tool)? {
            Evidence::Observed { state, .. } => Some(state),
            Evidence::PermissionRequest { .. } => None,
        }
    }

    #[test]
    fn observes_permission_only_after_the_dialog_notification() {
        for tool in [ClaudeCode, Codex] {
            assert_eq!(state(tool, "PermissionRequest", json!({})), None);
        }
        assert_eq!(
            state(
                ClaudeCode,
                "Notification",
                json!({"notification_type":"permission_prompt"})
            ),
            Some(Waiting)
        );
        assert_eq!(
            state(Codex, "Notification", json!({"notification_type":"permission_prompt"})),
            None
        );
        assert_eq!(
            state(ClaudeCode, "Notification", json!({"notification_type":"auth_success"})),
            None
        );
        assert_eq!(state(ClaudeCode, "PostToolUse", json!({})), None);
        assert_eq!(state(ClaudeCode, "PostToolBatch", json!({})), Some(Running));
        assert_eq!(state(Codex, "PreModelRequest", json!({})), Some(Running));
    }

    #[test]
    fn observes_a_response_without_overwriting_it_on_session_end() {
        for tool in [ClaudeCode, Codex] {
            assert_eq!(state(tool, "UserPromptSubmit", json!({})), Some(Running));
            assert_eq!(
                state(
                    tool,
                    "Stop",
                    json!({"last_assistant_message":"done", "background_tasks":[], "session_crons":[]})
                ),
                Some(Waiting)
            );
            assert_eq!(
                state(tool, "Stop", json!({"last_assistant_message":"  "})),
                Some(Unknown)
            );
            assert_eq!(
                state(
                    tool,
                    "Stop",
                    json!({"last_assistant_message":"done", "stop_hook_active":true})
                ),
                Some(Unknown)
            );
            assert_eq!(state(tool, "SessionEnd", json!({})), None);
        }
        assert_eq!(
            state(
                ClaudeCode,
                "Stop",
                json!({"last_assistant_message":"later", "background_tasks":[{}]})
            ),
            Some(Unknown)
        );
        assert_eq!(
            state(
                ClaudeCode,
                "Stop",
                json!({"last_assistant_message":"later", "session_crons":[{}]})
            ),
            Some(Unknown)
        );
        assert_eq!(state(ClaudeCode, "StopFailure", json!({})), Some(Unknown));
        assert_eq!(state(Codex, "Interrupt", json!({})), Some(Unknown));
        assert_eq!(state(ClaudeCode, "PostToolBatch", json!({"agent_id":"other"})), None);
        assert_eq!(state(Codex, "PreModelRequest", json!({"agent_id":"other"})), None);
        assert_eq!(state(Codex, "PreModelRequest", json!({"agent_id":"session"})), None);
    }

    #[test]
    fn codex_permission_candidate_requires_a_matching_human_review_turn() {
        let home = std::env::temp_dir().join(format!("aiw-permission-{}", std::process::id()));
        let observe = |event, id| {
            let input = json!({"session_id":"s", "hook_event_name":event, "turn_id":"turn-1",
                "tool_use_id":id, "tool_input":{"command":"private command"}});
            record(&home, Codex, input.to_string().as_bytes()).unwrap();
        };
        observe("PermissionRequest", "one");
        observe("PermissionRequest", "two");
        let persisted: Value =
            serde_json::from_slice(&fs::read(path_for(&home, Codex, "s").unwrap()).unwrap()).unwrap();
        assert_eq!(persisted.as_object().unwrap().len(), 2);
        assert_eq!(persisted["pending_permission_turn"], "turn-1");
        assert!(persisted["at_ns"].is_u64());
        assert_eq!(read_latest(&home, Codex, "s").unwrap(), None);
        assert_eq!(read_for_turn(&home, Codex, "s", Some("turn-2")).unwrap(), None);
        let matching = || {
            read_for_turn(&home, Codex, "s", Some("turn-1"))
                .unwrap()
                .map(|s| s.state)
        };
        assert_eq!(matching(), Some(Waiting));
        observe("PostToolUse", "one");
        assert_eq!(matching(), Some(Waiting));
        observe("PreModelRequest", "");
        assert_eq!(matching(), None);
        let last_confirmed = read_latest(&home, Codex, "s").unwrap().unwrap();
        assert_eq!(last_confirmed.state, Running);
        observe("PermissionRequest", "three");
        assert_eq!(matching(), Some(Waiting));
        assert_eq!(read_for_turn(&home, Codex, "s", None).unwrap(), None);
        assert_eq!(read_latest(&home, Codex, "s").unwrap(), Some(last_confirmed));
        let stop = json!({"session_id":"s", "hook_event_name":"Stop", "turn_id":"turn-1", "last_assistant_message":"finished"});
        record(&home, Codex, stop.to_string().as_bytes()).unwrap();
        assert_eq!(matching(), None);
        assert_eq!(read_latest(&home, Codex, "s").unwrap().unwrap().state, Waiting);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_delayed_writer_preserves_the_candidate_and_the_latest_confirmed_state() {
        let home = std::env::temp_dir().join(format!("aiw-pending-order-{}", std::process::id()));
        let path = path_for(&home, Codex, "session").unwrap();
        update(
            &path,
            Snapshot {
                at_ns: 3_000_000,
                evidence: Evidence::PermissionRequest {
                    pending_permission_turn: "turn".into(),
                    last_confirmed: None,
                },
            },
        )
        .unwrap();
        for (at_ns, state) in [(2_000_000, Running), (1_000_000, Unknown)] {
            update(
                &path,
                Snapshot {
                    at_ns,
                    evidence: Evidence::Observed { state, owner: None },
                },
            )
            .unwrap();
        }
        assert_eq!(
            read_latest(&home, Codex, "session").unwrap(),
            Some(StatusObservation { state: Running, at: 2 })
        );
        assert_eq!(
            read_for_turn(&home, Codex, "session", Some("turn")).unwrap(),
            Some(StatusObservation { state: Waiting, at: 3 })
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn snapshots_are_ordered_across_concurrent_writers() {
        let home = std::env::temp_dir().join(format!("aiw-order-{}", std::process::id()));
        let path = path_for(&home, ClaudeCode, "session").unwrap();
        std::thread::scope(|scope| {
            for n in (1..=12).rev() {
                let path = &path;
                scope.spawn(move || {
                    update(
                        path,
                        Snapshot {
                            evidence: Evidence::Observed {
                                owner: None,
                                state: if n == 12 { Waiting } else { Running },
                            },
                            at_ns: n * 1_000_000,
                        },
                    )
                    .unwrap()
                });
            }
        });
        assert_eq!(
            read_latest(&home, ClaudeCode, "session").unwrap(),
            Some(StatusObservation { state: Waiting, at: 12 })
        );
        assert_eq!(read_latest(&home, Codex, "session").unwrap(), None);
        for invalid in ["", "/tmp/x", "../x", "a/b", "a\0b", &"x".repeat(129)] {
            assert_eq!(path_for(&home, ClaudeCode, invalid), None);
        }
        fs::remove_dir_all(home).unwrap();
    }
}
