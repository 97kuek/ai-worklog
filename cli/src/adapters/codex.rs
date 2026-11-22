use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::value::RawValue;

use super::claude::modified_at_or_after;
use super::jsonl::for_each_matching_line;
use super::time::parse_ts;
use crate::domain::{RawSession, TokenEvent, TokenUsage, Tool};

const NEEDLES: &[&str] = &[
    r#""type":"session_meta""#,
    r#""type":"turn_context""#,
    r#""type":"response_item""#,
    r#""type":"event_msg""#,
];

/// Only the envelope is parsed eagerly; payloads are decoded on demand so an
/// unexpected payload shape never costs us the line's timestamp.
#[derive(Deserialize)]
struct Line<'a> {
    timestamp: Option<&'a str>,
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(borrow)]
    payload: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct SessionMeta {
    id: String,
    cwd: Option<String>,
    originator: Option<String>,
    thread_source: Option<String>,
    source: Option<serde_json::Value>,
    git: Option<GitInfo>,
}

#[derive(Deserialize)]
struct GitInfo {
    branch: Option<String>,
}

#[derive(Deserialize)]
struct TurnContext {
    model: Option<String>,
}

#[derive(Deserialize)]
struct TokenCount {
    #[serde(rename = "type")]
    kind: String,
    info: Option<TokenInfo>,
}

#[derive(Deserialize)]
struct TokenInfo {
    total_token_usage: Option<Totals>,
}

#[derive(Deserialize, Clone, Copy, Default)]
struct Totals {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cached_input_tokens: u64,
    #[serde(default)]
    cache_write_input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

impl Totals {
    fn to_usage(self) -> TokenUsage {
        TokenUsage {
            input: self.input_tokens.saturating_sub(self.cached_input_tokens),
            output: self.output_tokens,
            cache_read: self.cached_input_tokens,
            cache_write: self.cache_write_input_tokens,
        }
    }

    fn minus(self, prev: Totals) -> TokenUsage {
        let cur = self.to_usage();
        let prev = prev.to_usage();
        TokenUsage {
            input: cur.input.saturating_sub(prev.input),
            output: cur.output.saturating_sub(prev.output),
            cache_read: cur.cache_read.saturating_sub(prev.cache_read),
            cache_write: cur.cache_write.saturating_sub(prev.cache_write),
        }
    }
}

enum Role {
    Main,
    Subagent { parent: String },
    Excluded,
}

struct FileSession {
    raw: RawSession,
    role: Role,
}

/// Reads every `*.jsonl` under `codex_dir/sessions` modified at or after
/// `modified_since`. Guardian review threads are dropped, subagent threads
/// are merged into their parent, and orphan subagents are dropped.
pub fn read_codex_sessions(codex_dir: &Path, modified_since: SystemTime) -> Vec<RawSession> {
    let titles = read_titles(&codex_dir.join("session_index.jsonl"));
    let mut files = Vec::new();
    collect_jsonl(&codex_dir.join("sessions"), modified_since, &mut files);

    let mut mains: Vec<RawSession> = Vec::new();
    let mut children: Vec<(String, RawSession)> = Vec::new();
    for path in files {
        let Some(fs) = read_file(&path) else { continue };
        match fs.role {
            Role::Main => mains.push(fs.raw),
            Role::Subagent { parent } => children.push((parent, fs.raw)),
            Role::Excluded => {}
        }
    }

    let index: HashMap<String, usize> =
        mains.iter().enumerate().map(|(i, r)| (r.native_session_id.clone(), i)).collect();
    for (parent, child) in children {
        if let Some(&i) = index.get(&parent) {
            let p = &mut mains[i];
            p.activity.extend(child.activity);
            p.token_events.extend(child.token_events);
            p.models.extend(child.models);
        }
    }
    for m in &mut mains {
        m.source_title = titles.get(&m.native_session_id).cloned();
    }
    mains
}

fn read_file(path: &Path) -> Option<FileSession> {
    let mut raw = RawSession { tool: Some(Tool::Codex), ..Default::default() };
    let mut role = None;
    let mut prev = Totals::default();
    let _ = for_each_matching_line(path, NEEDLES, |bytes| {
        let Ok(line) = serde_json::from_slice::<Line>(bytes) else { return };
        let at = line.timestamp.and_then(parse_ts);
        let payload = line.payload.map(RawValue::get).unwrap_or("null");
        match line.kind {
            "session_meta" if role.is_none() => {
                if let Ok(meta) = serde_json::from_str::<SessionMeta>(payload) {
                    role = Some(apply_meta(&mut raw, meta));
                }
            }
            "turn_context" => {
                if let Ok(tc) = serde_json::from_str::<TurnContext>(payload) {
                    raw.models.extend(tc.model);
                }
            }
            "response_item" | "event_msg" => {
                let Some(at) = at else { return };
                raw.activity.push(at);
                if line.kind == "event_msg" && payload.contains("\"token_count\"") {
                    if let Ok(TokenCount { kind, info: Some(TokenInfo { total_token_usage: Some(t) }) }) =
                        serde_json::from_str::<TokenCount>(payload)
                    {
                        if kind == "token_count" {
                            raw.token_events.push(TokenEvent { at, usage: t.minus(prev) });
                            prev = t;
                        }
                    }
                }
            }
            _ => {}
        }
    });
    Some(FileSession { raw, role: role? })
}

fn apply_meta(raw: &mut RawSession, meta: SessionMeta) -> Role {
    raw.native_session_id = meta.id;
    raw.cwd = meta.cwd;
    raw.git_branch = meta.git.and_then(|g| g.branch).filter(|b| !b.is_empty());
    if meta.originator.as_deref() == Some("Claude Code") {
        raw.invoked_by = Some(Tool::ClaudeCode);
    }
    match meta.thread_source.as_deref() {
        Some("guardian_review") => Role::Excluded,
        Some("subagent") => {
            let parent = meta
                .source
                .as_ref()
                .and_then(|s| s.pointer("/subagent/thread_spawn/parent_thread_id"))
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            match parent {
                Some(parent) => Role::Subagent { parent },
                None => Role::Excluded,
            }
        }
        _ => Role::Main,
    }
}

fn read_titles(path: &Path) -> HashMap<String, String> {
    #[derive(Deserialize)]
    struct Entry {
        id: String,
        thread_name: Option<String>,
    }
    let mut titles = HashMap::new();
    let _ = for_each_matching_line(path, &[], |bytes| {
        if let Ok(Entry { id, thread_name: Some(name) }) = serde_json::from_slice::<Entry>(bytes) {
            titles.insert(id, name);
        }
    });
    titles
}

fn collect_jsonl(dir: &Path, since: SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, since, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") && modified_at_or_after(&path, since) {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{build_session, TokenUsage, Tool};

    fn load() -> Vec<RawSession> {
        let dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/codex"));
        read_codex_sessions(dir, SystemTime::UNIX_EPOCH)
    }

    #[test]
    fn drops_guardian_and_orphan_subagent_and_merges_child() {
        let v = load();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].native_session_id, "c1");
    }

    #[test]
    fn converts_cumulative_totals_to_events_and_adds_subagent() {
        let mut total = TokenUsage::default();
        for e in &load()[0].token_events {
            total += e.usage;
        }
        assert_eq!(total, TokenUsage { input: 700, output: 90, cache_read: 900, cache_write: 0 });
    }

    #[test]
    fn subagent_activity_bridges_the_gap() {
        let s = build_session(load()[0].clone(), 30 * 60_000).unwrap();
        assert_eq!(s.blocks.len(), 1);
        assert_eq!(s.blocks[0].message_count, 5);
    }

    #[test]
    fn reads_metadata() {
        let r = &load()[0];
        assert_eq!(r.tool, Some(Tool::Codex));
        assert_eq!(r.invoked_by, Some(Tool::ClaudeCode));
        assert_eq!(r.git_branch.as_deref(), Some("feat/x"));
        assert_eq!(r.source_title.as_deref(), Some("Codex task"));
        assert_eq!(r.models.iter().cloned().collect::<Vec<_>>(), vec!["gpt-5.5-codex"]);
    }
}
