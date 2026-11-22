use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;

use super::jsonl::for_each_matching_line;
use super::time::parse_ts;
use crate::domain::{RawSession, TokenEvent, TokenUsage, Tool};

const NEEDLES: &[&str] = &[r#""type":"user""#, r#""type":"assistant""#, r#""type":"custom-title""#];

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: String,
    timestamp: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    #[serde(rename = "customTitle")]
    custom_title: Option<String>,
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

/// Reads every `<project>/<sessionId>.jsonl` under `projects_dir` as one
/// session, merging `<project>/<sessionId>/subagents/*.jsonl` into it.
/// Only sessions where the main file or a subagent file was modified at or
/// after `modified_since` are read.
pub fn read_claude_sessions(projects_dir: &Path, modified_since: SystemTime) -> Vec<RawSession> {
    let mut sessions = Vec::new();
    for project in read_dir_paths(projects_dir).into_iter().filter(|p| p.is_dir()) {
        for main in read_dir_paths(&project) {
            if main.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let Some(id) = main.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
                continue;
            };
            let subagents: Vec<PathBuf> = read_dir_paths(&project.join(&id).join("subagents"))
                .into_iter()
                .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
                .collect();
            if !std::iter::once(&main).chain(&subagents).any(|p| modified_at_or_after(p, modified_since)) {
                continue;
            }
            let mut raw = RawSession { tool: Some(Tool::ClaudeCode), native_session_id: id, ..Default::default() };
            let mut seen = HashSet::new();
            read_file(&main, &mut raw, &mut seen, true);
            for sub in &subagents {
                read_file(sub, &mut raw, &mut seen, false);
            }
            sessions.push(raw);
        }
    }
    sessions
}

fn read_file(path: &Path, raw: &mut RawSession, seen: &mut HashSet<(String, String)>, is_main: bool) {
    let _ = for_each_matching_line(path, NEEDLES, |bytes| {
        let Ok(line) = serde_json::from_slice::<Line>(bytes) else {
            return;
        };
        match line.kind.as_str() {
            "custom-title" => {
                if let Some(t) = line.custom_title {
                    raw.source_title = Some(t);
                }
            }
            "user" | "assistant" => {
                let Some(at) = line.timestamp.as_deref().and_then(parse_ts) else {
                    return;
                };
                raw.activity.push(at);
                if is_main {
                    // Claude Code records the shell's current directory, which
                    // moves with `cd`. The first value is where the session
                    // was started, which is what identifies the project.
                    if raw.cwd.is_none() {
                        raw.cwd = line.cwd;
                    }
                    if let Some(branch) = line.git_branch {
                        raw.git_branch = (!branch.is_empty() && branch != "HEAD").then_some(branch);
                    }
                }
                if line.kind == "assistant" {
                    if let Some(msg) = line.message {
                        add_assistant_usage(raw, seen, at, line.request_id, msg);
                    }
                }
            }
            _ => {}
        }
    });
}

fn add_assistant_usage(
    raw: &mut RawSession,
    seen: &mut HashSet<(String, String)>,
    at: i64,
    request_id: Option<String>,
    msg: Message,
) {
    if let Some(model) = msg.model.filter(|m| !m.starts_with('<')) {
        raw.models.insert(model);
    }
    let Some(u) = msg.usage else {
        return;
    };
    let key = (msg.id.unwrap_or_default(), request_id.unwrap_or_default());
    if !(key.0.is_empty() && key.1.is_empty()) && !seen.insert(key) {
        return;
    }
    raw.token_events.push(TokenEvent {
        at,
        usage: TokenUsage {
            input: u.input_tokens,
            output: u.output_tokens,
            cache_read: u.cache_read_input_tokens,
            cache_write: u.cache_creation_input_tokens,
        },
    });
}

fn read_dir_paths(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default()
}

pub(crate) fn modified_at_or_after(path: &Path, since: SystemTime) -> bool {
    fs::metadata(path).and_then(|m| m.modified()).is_ok_and(|t| t >= since)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{build_session, TokenUsage, Tool};

    fn load() -> Vec<RawSession> {
        let dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude/projects"));
        let mut v = read_claude_sessions(dir, SystemTime::UNIX_EPOCH);
        v.sort_by(|a, b| a.native_session_id.cmp(&b.native_session_id));
        v
    }

    #[test]
    fn reads_two_sessions() {
        assert_eq!(load().len(), 2);
    }

    #[test]
    fn dedupes_usage_by_message_and_request_id() {
        let s1 = &load()[0];
        let mut total = TokenUsage::default();
        for e in &s1.token_events {
            total += e.usage;
        }
        assert_eq!(total, TokenUsage { input: 14, output: 8, cache_read: 100, cache_write: 20 });
    }

    #[test]
    fn merges_subagent_activity_and_skips_broken_and_partial_lines() {
        let s1 = &load()[0];
        assert_eq!(s1.activity.len(), 7);
        let s = build_session(s1.clone(), 30 * 60_000).unwrap();
        assert_eq!(s.blocks.len(), 1);
    }

    #[test]
    fn reads_metadata() {
        let v = load();
        assert_eq!(v[0].source_title.as_deref(), Some("デモ作業"));
        assert_eq!(v[0].git_branch.as_deref(), Some("main"));
        assert_eq!(v[0].cwd.as_deref(), Some("/tmp/demo")); // the first cwd, not a later `cd`
        assert_eq!(v[0].models.iter().cloned().collect::<Vec<_>>(), vec!["claude-haiku-5-5", "claude-opus-5-5"]);
        assert_eq!(v[1].git_branch, None);
        assert_eq!(v[1].tool, Some(Tool::ClaudeCode));
    }
}
