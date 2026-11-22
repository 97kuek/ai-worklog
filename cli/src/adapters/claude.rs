use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::jsonl::read_matching_lines_from;
use super::time::parse_ts;
use crate::domain::{Fnv1a, ObservedState, RawSession, StatusObservation, TokenEvent, TokenUsage, Tool};

const NEEDLES: &[&str] = &[r#""type":"user""#, r#""type":"assistant""#, r#""type":"custom-title""#];
const MAX_USER_TEXTS: usize = 3;
const MAX_USER_TEXT_CHARS: usize = 300;

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
    #[serde(rename = "isMeta", default)]
    is_meta: bool,
    #[serde(rename = "isSidechain", default)]
    is_sidechain: bool,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    #[serde(rename = "isCompactSummary", default)]
    is_compact_summary: bool,
    #[serde(rename = "isApiErrorMessage", default)]
    is_api_error: bool,
    #[serde(rename = "promptId")]
    prompt_id: Option<String>,
    #[serde(default)]
    effort: serde_json::Value,
    #[serde(default, rename = "perTurnEffort")]
    per_turn_effort: serde_json::Value,
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
    content: Option<Content>,
    stop_reason: Option<String>,
}

impl Message {
    fn observed_state(&self, api_error: bool) -> Option<ObservedState> {
        if api_error {
            return Some(ObservedState::Unknown);
        }
        if let Some(Content::Items(items)) = &self.content
            && items.iter().any(|i| i.kind.as_deref() == Some("tool_use"))
        {
            return Some(ObservedState::Running);
        }
        match self.stop_reason.as_deref()? {
            "end_turn" => Some(ObservedState::Waiting),
            "tool_use" => Some(ObservedState::Running),
            _ => Some(ObservedState::Unknown),
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Items(Vec<Item>),
    Other(serde::de::IgnoredAny),
}

#[derive(Deserialize)]
struct Item {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
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

/// 1つのファイルから読んだ分の途中結果。state ファイルに保存して続きから読むために使う
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ClaudeFileState {
    /// このファイルから読んだ分だけ
    pub raw: RawSession,
    /// (message.id, requestId) のハッシュ
    pub seen: HashSet<u64>,
    pub prompt_id: Option<String>,
    /// 作業名の材料。main のファイルだけ、最大3件、各300文字まで
    pub user_texts: Vec<String>,
}

pub struct ClaudeFile {
    pub path: PathBuf,
    pub session_id: String,
    pub is_main: bool,
}

/// Keep available child logs discoverable even if their main log is offline.
fn claude_file_groups(projects_dir: &Path) -> Vec<Vec<ClaudeFile>> {
    let mut groups = Vec::new();
    for project in read_dir_paths(projects_dir).into_iter().filter(|p| p.is_dir()) {
        let mut sessions = BTreeMap::<String, Vec<ClaudeFile>>::new();
        for path in read_dir_paths(&project) {
            if path.extension().is_some_and(|e| e == "jsonl") {
                if let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) {
                    sessions.entry(id.clone()).or_default().push(ClaudeFile { path, session_id: id, is_main: true });
                }
            } else if path.is_dir() && let Some(id) = path.file_name().and_then(|s| s.to_str()) {
                for child in read_dir_paths(&path.join("subagents"))
                    .into_iter().filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
                {
                    sessions.entry(id.to_owned()).or_default().push(ClaudeFile {
                        path: child, session_id: id.to_owned(), is_main: false,
                    });
                }
            }
        }
        for mut group in sessions.into_values() {
            group.sort_by_key(|f| !f.is_main);
            groups.push(group);
        }
    }
    groups
}

pub fn list_claude_files(projects_dir: &Path) -> Vec<ClaudeFile> {
    claude_file_groups(projects_dir).into_iter().flatten().collect()
}

/// Reads every `<project>/<sessionId>.jsonl` under `projects_dir` as one
/// session, merging `<project>/<sessionId>/subagents/*.jsonl` into it.
/// Only sessions where the main file or a subagent file was modified at or
/// after `modified_since` are read.
pub fn read_claude_sessions(projects_dir: &Path, modified_since: SystemTime) -> Vec<RawSession> {
    let mut sessions = Vec::new();
    for group in claude_file_groups(projects_dir) {
        if !group[0].is_main || !group.iter().any(|f| modified_at_or_after(&f.path, modified_since)) {
            continue;
        }
        let states: Vec<ClaudeFileState> = group
            .iter()
            .map(|f| {
                let mut st = ClaudeFileState::default();
                let _ = read_claude_file(f, 0, &mut st);
                st
            })
            .collect();
        let subs: Vec<&ClaudeFileState> = states[1..].iter().collect();
        sessions.extend(merge_claude(Some(&states[0]), &subs));
    }
    sessions
}

/// from から読み、st に足す。戻り値は新しい読み終えた位置
pub fn read_claude_file(file: &ClaudeFile, from: u64, st: &mut ClaudeFileState) -> std::io::Result<u64> {
    if st.raw.tool.is_none() {
        st.raw.tool = Some(Tool::ClaudeCode);
        st.raw.native_session_id = file.session_id.clone();
    }
    read_matching_lines_from(&file.path, from, NEEDLES, |bytes| {
        let Ok(line) = serde_json::from_slice::<Line>(bytes) else {
            return;
        };
        apply_line(st, file.is_main, line);
    })
}

fn apply_line(st: &mut ClaudeFileState, is_main: bool, line: Line) {
    let raw = &mut st.raw;
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
            let main_turn = is_main && !line.is_meta && !line.is_sidechain && !line.is_compact_summary
                && line.agent_id.is_none();
            if line.kind == "assistant" {
                if let Some(msg) = line.message {
                    if main_turn
                        && (line.prompt_id.is_none() || st.prompt_id.is_none() || line.prompt_id == st.prompt_id)
                        && let Some(state) = msg.observed_state(line.is_api_error)
                    {
                        StatusObservation { state, at }.merge_into(&mut raw.observed_status);
                    }
                    let effort = line.effort.as_str().or_else(|| line.per_turn_effort.as_str());
                    add_assistant_usage(st, at, line.request_id, msg, effort);
                }
            } else if main_turn && let Some(input) = line.message.and_then(|m| m.content).and_then(user_input) {
                let state = match input {
                    UserInput::Prompt(text) => {
                        if st.user_texts.len() < MAX_USER_TEXTS {
                            st.user_texts.extend(text);
                        }
                        if raw.observed_status.is_none_or(|last| at >= last.at) {
                            st.prompt_id = line.prompt_id;
                        }
                        ObservedState::Running
                    }
                    UserInput::Interrupted => ObservedState::Unknown,
                };
                StatusObservation { state, at }.merge_into(&mut raw.observed_status);
            }
        }
        _ => {}
    }
}

enum UserInput {
    Prompt(Option<String>),
    Interrupted,
}

/// A prompt can contain only an attachment. Only actual user text is naming material.
fn user_input(content: Content) -> Option<UserInput> {
    let (text, attachment) = match content {
        Content::Text(t) => (t, false),
        Content::Items(items) => {
            if items.iter().any(|i| i.kind.as_deref() == Some("tool_result")) {
                return None;
            }
            let attachment = items.iter().any(|i| matches!(i.kind.as_deref(), Some("image" | "document")));
            let text = items.into_iter().filter(|i| i.kind.as_deref() == Some("text"))
                .filter_map(|i| i.text).collect::<Vec<_>>().join("\n");
            (text, attachment)
        }
        Content::Other(_) => return None,
    };
    let text = text.trim();
    if text.is_empty() {
        return attachment.then_some(UserInput::Prompt(None));
    }
    if text.starts_with("[Request interrupted by user") {
        return Some(UserInput::Interrupted);
    }
    let control = ["<command-", "<local-command", "<system-reminder", "<task-notification", "<teammate-message"];
    if control.iter().any(|prefix| text.starts_with(prefix)) {
        return None;
    }
    Some(UserInput::Prompt(Some(text.chars().take(MAX_USER_TEXT_CHARS).collect())))
}

/// 同じ応答の usage を二度数えないための印
/// 保存するので、Rust の版で値が変わらない FNV-1a で作る。id の長さを先に入れて区切りを一意にする
fn usage_key(id: &str, request_id: &str) -> u64 {
    let mut h = Fnv1a::default();
    h.write(&(id.len() as u64).to_le_bytes());
    h.write(id.as_bytes());
    h.write(request_id.as_bytes());
    h.finish()
}

fn add_assistant_usage(st: &mut ClaudeFileState, at: i64, request_id: Option<String>, msg: Message, effort: Option<&str>) {
    if let Some(model) = msg.model.filter(|m| !m.starts_with('<')) {
        st.raw.record_model(model, effort);
    }
    let Some(u) = msg.usage else {
        return;
    };
    let (id, request_id) = (msg.id.unwrap_or_default(), request_id.unwrap_or_default());
    if !(id.is_empty() && request_id.is_empty()) && !st.seen.insert(usage_key(&id, &request_id)) {
        return;
    }
    st.raw.token_events.push(TokenEvent {
        at,
        usage: TokenUsage {
            input: u.input_tokens,
            output: u.output_tokens,
            cache_read: u.cache_read_input_tokens,
            cache_write: u.cache_creation_input_tokens,
        },
    });
}

/// 1つのセッションのファイル群（main とサブエージェント）の途中結果をまとめる
pub fn merge_claude(main: Option<&ClaudeFileState>, subagents: &[&ClaudeFileState]) -> Option<RawSession> {
    let mut raw = main?.raw.clone();
    raw.tool = Some(Tool::ClaudeCode);
    for sub in subagents {
        raw.absorb(sub.raw.clone());
    }
    Some(raw)
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

    #[test]
    fn usage_key_is_a_stable_fnv1a_hash() {
        // 保存する値なので、Rust の版で変わらないこと
        assert_eq!(usage_key("msg_1", "req_1"), 0x0ffd3b0b3d30e173);
        assert_ne!(usage_key("ab", "c"), usage_key("a", "bc"));
    }

    #[test]
    fn observes_only_main_prompts_tool_work_and_confirmed_turn_end() {
        use ObservedState::*;
        let mut st = ClaudeFileState::default();
        let mut event = |is_main: bool, kind: &str, second: u8, prompt: &str, message: serde_json::Value| {
            let line = serde_json::json!({"type":kind, "timestamp":format!("2026-01-01T00:00:{second:02}Z"),
                "promptId":prompt, "message":message});
            apply_line(&mut st, is_main, serde_json::from_value(line).unwrap());
            st.raw.observed_status.map(|s| s.state)
        };
        let user = |text: &str| serde_json::json!({"content": text});
        let stop = || serde_json::json!({"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]});
        assert_eq!(event(true, "user", 1, "a", user("begin")), Some(Running));
        assert_eq!(event(true, "assistant", 2, "a", stop()), Some(Waiting));
        assert_eq!(event(false, "user", 3, "a", user("subagent")), Some(Waiting));
        let result = serde_json::json!({"content":[{"type":"text","text":"metadata"},{"type":"tool_result"}]});
        assert_eq!(event(true, "user", 4, "a", result), Some(Waiting));
        assert_eq!(event(true, "user", 5, "a", user("<task-notification>")), Some(Waiting));
        assert_eq!(event(true, "user", 6, "b", user("next")), Some(Running));
        assert_eq!(event(true, "assistant", 7, "a", stop()), Some(Running));
        let tool = serde_json::json!({"stop_reason":"tool_use", "content":[{"type":"tool_use"}]});
        assert_eq!(event(true, "assistant", 8, "b", tool), Some(Running));
        assert_eq!(event(true, "assistant", 3, "b", stop()), Some(Running));
        assert_eq!(event(true, "user", 9, "b", user("[Request interrupted by user]")), Some(Unknown));
        let image = serde_json::json!({"content":[{"type":"image"}]});
        assert_eq!(event(true, "user", 10, "c", image), Some(Running));
        assert_eq!(st.user_texts, ["begin", "next"]);
    }

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

    fn s1_bytes() -> Vec<u8> {
        std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude/projects/-tmp-demo/s1.jsonl")).unwrap()
    }

    fn temp_dir(test: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aiwl-claude-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn main_file(path: PathBuf) -> ClaudeFile {
        ClaudeFile { path, session_id: "s1".into(), is_main: true }
    }

    fn append(path: &Path, bytes: &[u8]) {
        use std::io::Write;
        std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap().write_all(bytes).unwrap();
    }

    fn sorted(mut raw: RawSession) -> RawSession {
        raw.activity.sort();
        raw.token_events.sort_by_key(|e| e.at);
        raw
    }

    #[test]
    fn incremental_equals_full_read_at_every_split() {
        let bytes = s1_bytes();
        let dir = temp_dir("split");
        let path = dir.join("s1.jsonl");
        let file = main_file(path.clone());

        std::fs::write(&path, &bytes).unwrap();
        let mut full = ClaudeFileState::default();
        read_claude_file(&file, 0, &mut full).unwrap();
        let expected = sorted(merge_claude(Some(&full), &[]).unwrap());

        for k in 0..=bytes.len() {
            std::fs::write(&path, &bytes[..k]).unwrap();
            let mut st = ClaudeFileState::default();
            let off = read_claude_file(&file, 0, &mut st).unwrap();
            append(&path, &bytes[k..]);
            read_claude_file(&file, off, &mut st).unwrap();
            assert_eq!(sorted(merge_claude(Some(&st), &[]).unwrap()), expected, "split at {k}");
            assert_eq!(st.user_texts, full.user_texts, "split at {k}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_first_cwd_across_resumes() {
        let dir = temp_dir("cwd");
        let path = dir.join("s1.jsonl");
        let file = main_file(path.clone());
        let line = |ts: &str, cwd: &str| {
            format!("{{\"type\":\"user\",\"timestamp\":\"{ts}\",\"cwd\":\"{cwd}\",\"message\":{{\"content\":\"x\"}}}}\n")
        };
        std::fs::write(&path, line("2026-11-20T01:00:00.000Z", "/first")).unwrap();
        let mut st = ClaudeFileState::default();
        let off = read_claude_file(&file, 0, &mut st).unwrap();
        append(&path, line("2026-11-20T01:01:00.000Z", "/second").as_bytes());
        read_claude_file(&file, off, &mut st).unwrap();
        assert_eq!(st.raw.cwd.as_deref(), Some("/first"));
        assert_eq!(st.raw.activity.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collects_up_to_three_user_texts_from_main_only() {
        let dir = temp_dir("texts");
        let main = dir.join("s1.jsonl");
        let sub = dir.join("agent-a.jsonl");
        let user = |content: &str, extra: &str| {
            format!("{{\"type\":\"user\",\"timestamp\":\"2026-11-20T01:00:00.000Z\"{extra},\"message\":{{\"content\":{content}}}}}\n")
        };
        let long = "あ".repeat(400);
        let mut text = String::new();
        text += &user("\"one\"", "");
        text += &user(r#"[{"type":"tool_result","content":"secret"}]"#, "");
        text += &user("\"meta\"", r#","isMeta":true"#);
        text += &user("\"<command-name>/x</command-name>\"", "");
        text += &user("\"<local-command-stdout>y</local-command-stdout>\"", "");
        text += &user(r#"[{"type":"text","text":"two"},{"type":"text","text":"parts"}]"#, "");
        text += &user(&format!("\"{long}\""), "");
        text += &user("\"four\"", "");
        std::fs::write(&main, &text).unwrap();
        std::fs::write(&sub, user("\"from sub\"", "")).unwrap();

        let mut m = ClaudeFileState::default();
        read_claude_file(&main_file(main), 0, &mut m).unwrap();
        assert_eq!(m.user_texts.len(), 3);
        assert_eq!(m.user_texts[0], "one");
        assert_eq!(m.user_texts[1], "two\nparts");
        assert_eq!(m.user_texts[2].chars().count(), 300);

        let mut s = ClaudeFileState::default();
        read_claude_file(&ClaudeFile { path: sub, session_id: "s1".into(), is_main: false }, 0, &mut s).unwrap();
        assert!(s.user_texts.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
