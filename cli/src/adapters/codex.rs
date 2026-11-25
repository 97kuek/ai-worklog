use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use super::claude::modified_at_or_after;
use super::jsonl::{first_matching_line, for_each_matching_line, read_matching_lines_from};
use super::time::parse_ts;
use crate::domain::{Millis, ObservedState, RawSession, StatusObservation, TokenEvent, TokenUsage, Tool};

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

const MAX_USER_TEXTS: usize = 3;
const MAX_USER_TEXT_CHARS: usize = 300;

#[derive(Deserialize)]
struct UserMessage {
    #[serde(rename = "type")]
    kind: String,
    message: Option<String>,
}

#[derive(Deserialize)]
struct TurnContext {
    model: Option<String>,
    #[serde(default)]
    effort: serde_json::Value,
    turn_id: Option<String>,
    approvals_reviewer: Option<String>,
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

#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default)]
#[serde(default)]
pub struct Totals {
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum CodexRole {
    Main,
    Subagent { parent: String },
    Excluded,
}

/// 1つのrolloutファイルから読んだ分の途中結果。state ファイルに保存して続きから読むために使う
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CodexFileState {
    pub thread_id: Option<String>,
    /// 最初の session_meta で決まる
    pub role: Option<CodexRole>,
    /// Current task_started context, retained across incremental reads.
    pub turn_id: Option<String>,
    pub final_answer_at: Option<Millis>,
    /// The first synthetic turn provides a timestamp for import-only metadata.
    pub first_import_at: Option<Millis>,
    importing_turn: bool,
    review: Option<ReviewContext>,
    pub raw: RawSession,
    /// 累計値の前回の値（差分を出すため）
    pub last_totals: Totals,
    /// Main のファイルだけ、最大3件、各300文字まで
    pub user_texts: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReviewContext {
    pub turn_id: String,
    pub at: Millis,
    pub human_since: Option<Millis>,
}

impl CodexFileState {
    pub fn active_review(&self) -> Option<&ReviewContext> {
        if self.raw.observed_status?.state != ObservedState::Running {
            return None;
        }
        self.review.as_ref()
    }
}

pub fn list_codex_files(codex_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    // Archiving a conversation moves its rollout to archived_sessions/, and
    // its work should stay on the calendar.
    collect_jsonl(&codex_dir.join("sessions"), &mut files);
    collect_jsonl(&codex_dir.join("archived_sessions"), &mut files);
    files
}

/// from から読み、st に足す。戻り値は新しい読み終えた位置
pub fn read_codex_file(path: &Path, from: u64, st: &mut CodexFileState) -> std::io::Result<u64> {
    if st.raw.tool.is_none() {
        st.raw.tool = Some(Tool::Codex);
    }
    read_matching_lines_from(path, from, NEEDLES, |bytes| {
        let Ok(line) = serde_json::from_slice::<Line>(bytes) else { return };
        apply_line(st, line);
    })
}

fn apply_line(st: &mut CodexFileState, line: Line) {
    let at = line.timestamp.and_then(parse_ts);
    let payload = line.payload.map(RawValue::get).unwrap_or("null");
    if line.kind == "event_msg"
        && (st.importing_turn || payload.contains("external-import-turn-")
            || (st.first_import_at.is_some() && payload.contains("thread_settings_applied")))
        && let Ok(event) = serde_json::from_str::<TurnEvent>(payload)
    {
        if event.kind == "task_started" {
            st.importing_turn = event.turn_id.as_deref().is_some_and(|id| id.starts_with("external-import-turn-"));
            if st.importing_turn {
                st.first_import_at = st.first_import_at.or(at);
                return;
            }
        } else if event.kind == "task_complete" && st.importing_turn {
            st.importing_turn = false;
            return;
        } else if st.first_import_at.is_some() && event.kind == "thread_settings_applied" {
            return;
        }
    }
    if st.importing_turn {
        return;
    }
    match line.kind {
        // The first session_meta decides the thread; forks replay later ones.
        "session_meta" if st.role.is_none() => {
            if let Ok(meta) = serde_json::from_str::<SessionMeta>(payload) {
                st.thread_id = Some(meta.id.clone());
                st.role = Some(apply_meta(&mut st.raw, meta));
            }
        }
        "turn_context" => {
            if let Ok(tc) = serde_json::from_str::<TurnContext>(payload) {
                if let Some(model) = tc.model {
                    st.raw.record_model(model, tc.effort.as_str());
                }
                if matches!(st.role, Some(CodexRole::Main))
                    && (tc.turn_id.is_none() || tc.turn_id == st.turn_id)
                    && let Some(at) = at
                    && st.raw.observed_status.is_some_and(|s| s.state == ObservedState::Running && at >= s.at)
                    && st.review.as_ref().is_none_or(|last| at >= last.at)
                    && let Some(turn_id) = &st.turn_id
                {
                    let human = tc.turn_id.is_some() && tc.approvals_reviewer.as_deref() == Some("user");
                    let human_since = human.then(|| st.review.as_ref().and_then(|r| r.human_since).unwrap_or(at));
                    st.review = Some(ReviewContext { turn_id: turn_id.clone(), at, human_since });
                }
            }
        }
        "response_item" | "event_msg" => {
            let Some(at) = at else { return };
            st.raw.activity.push(at);
            if matches!(st.role, Some(CodexRole::Main)) {
                observe_turn(st, line.kind, at, payload);
            }
            if line.kind != "event_msg" {
                if matches!(st.role, Some(CodexRole::Main)) && st.user_texts.len() < MAX_USER_TEXTS
                    && payload.contains(r#""user""#)
                    && let Ok(event) = serde_json::from_str::<TurnEvent>(payload)
                    && event.kind == "message" && event.role.as_deref() == Some("user")
                {
                    let text = event.content.into_iter().flatten()
                        .filter(|part| part.kind == "input_text")
                        .filter_map(|part| part.text)
                        .filter(|text| is_user_request(text))
                        .collect::<Vec<_>>().join("\n");
                    record_user_text(st, &text);
                }
                return;
            }
            if payload.contains("\"token_count\"") {
                if let Ok(TokenCount { kind, info: Some(TokenInfo { total_token_usage: Some(t) }) }) =
                    serde_json::from_str::<TokenCount>(payload)
                    && kind == "token_count"
                {
                    st.raw.token_events.push(TokenEvent { at, usage: t.minus(st.last_totals) });
                    st.last_totals = t;
                }
            } else if matches!(st.role, Some(CodexRole::Main))
                && st.user_texts.len() < MAX_USER_TEXTS
                && payload.contains("\"user_message\"")
                && let Ok(UserMessage { kind, message: Some(m) }) = serde_json::from_str::<UserMessage>(payload)
                && kind == "user_message" && !m.trim().is_empty()
            {
                record_user_text(st, &m);
            }
        }
        _ => {}
    }
}

fn is_user_request(text: &str) -> bool {
    let text = text.trim_start();
    !text.is_empty() && !text.starts_with("# AGENTS.md")
        && !["<environment_context", "<instructions", "<INSTRUCTIONS", "<subagent_notification",
            "<turn_aborted", "<user_shell_command", "<permissions instructions", "<collaboration_mode",
            "<system-reminder"].iter().any(|prefix| text.starts_with(prefix))
}

fn record_user_text(st: &mut CodexFileState, text: &str) {
    if !is_user_request(text) { return; }
    let excerpt: String = text.trim().chars().take(MAX_USER_TEXT_CHARS).collect();
    // Some clients record the same user turn in both event envelopes.
    if st.user_texts.last() != Some(&excerpt) {
        st.user_texts.push(excerpt);
    }
}

#[derive(Deserialize)]
struct TurnEvent {
    #[serde(rename = "type")]
    kind: String,
    turn_id: Option<String>,
    role: Option<String>,
    phase: Option<String>,
    last_agent_message: Option<String>,
    message: Option<String>,
    content: Option<Vec<Part>>,
}
#[derive(Deserialize)]
struct Part {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

impl TurnEvent {
    fn is_final_answer(&self, envelope: &str) -> bool {
        if self.phase.as_deref() != Some("final_answer") {
            return false;
        }
        match (envelope, self.kind.as_str()) {
            ("event_msg", "agent_message") => self.message.as_deref().is_some_and(|m| !m.trim().is_empty()),
            ("response_item", "message") if self.role.as_deref() == Some("assistant") => {
                self.content.iter().flatten().any(|p| {
                    p.kind == "output_text" && p.text.as_deref().is_some_and(|text| !text.trim().is_empty())
                })
            }
            _ => false,
        }
    }
}

/// A final_answer is evidence for the current turn's completion. Commentary,
/// tool output and a final_answer alone do not indicate that the turn has stopped.
fn observe_turn(st: &mut CodexFileState, envelope: &str, at: Millis, payload: &str) {
    if st.raw.observed_status.is_some_and(|last| at < last.at)
        || !["\"task_started\"", "\"task_complete\"", "\"turn_aborted\"", "\"final_answer\""]
            .iter().any(|needle| payload.contains(needle))
    {
        return;
    }
    let Ok(event) = serde_json::from_str::<TurnEvent>(payload) else { return };
    let different_turn = st.turn_id.is_some() && event.turn_id.is_some() && event.turn_id != st.turn_id;
    let state = match (envelope, event.kind.as_str()) {
        ("event_msg", "task_started") => {
            st.turn_id = event.turn_id;
            st.review = None;
            st.final_answer_at = None;
            ObservedState::Running
        }
        _ if different_turn => return,
        ("event_msg", "turn_aborted") => {
            st.final_answer_at = None;
            ObservedState::Unknown
        }
        ("event_msg", "task_complete") => {
            let answered = event.last_agent_message.is_some_and(|m| !m.trim().is_empty())
                || st.final_answer_at.is_some_and(|final_at| final_at <= at);
            // A completion with no matching start may still carry its own final message.
            if st.turn_id.is_none() {
                st.turn_id = event.turn_id;
            }
            if answered { ObservedState::Waiting } else { ObservedState::Unknown }
        }
        _ if event.is_final_answer(envelope) => {
            if st.raw.observed_status.is_some_and(|s| s.state == ObservedState::Running) {
                st.final_answer_at = Some(st.final_answer_at.map_or(at, |old| old.min(at)));
            }
            return;
        }
        _ => return,
    };
    st.raw.observed_status = Some(StatusObservation { state, at });
}

pub fn read_thread_titles(codex_dir: &Path) -> HashMap<String, String> {
    let mut titles = read_titles(&codex_dir.join("session_index.jsonl"));
    let db = codex_dir.join("state_5.sqlite");
    if db.is_file() {
        // Desktop also puts the opening prompt in title when no name has been assigned.
        // Check both desktop and index candidates against that placeholder before using them.
        let sql = "WITH labels AS (
            SELECT id, trim(CASE WHEN trim(coalesce(name,'')) <> '' THEN name ELSE title END) AS candidate,
                trim(first_user_message) AS opening, name FROM threads
        ) SELECT id, CASE WHEN length(candidate) BETWEEN 1 AND 200
            AND (trim(coalesce(name,'')) <> '' OR coalesce(opening,'') <> '')
            AND instr(coalesce(opening,''),candidate) <> 1 THEN candidate END AS label,
            substr(opening,1,200) AS opening_prefix FROM labels";
        if let Ok(output) = Command::new("sqlite3").args(["-init", "/dev/null", "-readonly", "-json"])
            .arg(db).arg(sql).output()
            && output.status.success()
            && let Ok(rows) = serde_json::from_slice::<Vec<ThreadLabel>>(&output.stdout)
        {
            for row in rows {
                if let Some(label) = row.label.as_deref().and_then(valid_label) {
                    titles.insert(row.id, label.to_owned());
                } else if titles.get(&row.id).is_some_and(|name|
                    row.opening_prefix.as_deref().is_some_and(|opening| opening.starts_with(name))) {
                    titles.remove(&row.id);
                }
            }
        }
    }
    titles
}

/// Follows parent links up to 32 levels. None for Excluded threads and for
/// chains that never reach a Main thread.
fn root_in(roles: &HashMap<&str, &CodexRole>, id: &str) -> Option<String> {
    let mut cur = id;
    for _ in 0..32 {
        match roles.get(cur)? {
            CodexRole::Main => return Some(cur.to_owned()),
            CodexRole::Subagent { parent } => cur = parent,
            CodexRole::Excluded => return None,
        }
    }
    None
}

/// 親子をたどって根ごとにまとめる。Excluded と、根が見つからない子は除く。
/// session_meta をまだ読めていないファイル（role が None）は読み飛ばす
pub fn merge_codex(files: &[&CodexFileState], titles: &HashMap<String, String>) -> Vec<RawSession> {
    let known: Vec<(&str, &CodexRole, &CodexFileState)> = files
        .iter()
        .filter_map(|st| Some((st.thread_id.as_deref()?, st.role.as_ref()?, *st)))
        .collect();
    let roles: HashMap<&str, &CodexRole> = known.iter().map(|(id, r, _)| (*id, *r)).collect();
    let mut mains: HashMap<String, RawSession> = HashMap::new();
    let mut children: Vec<(String, &CodexFileState)> = Vec::new();
    for (id, _, st) in &known {
        let Some(root) = root_in(&roles, id) else { continue };
        if root == *id {
            mains.insert(root, st.raw.clone());
        } else {
            children.push((root, st));
        }
    }
    for (root, child) in children {
        if let Some(p) = mains.get_mut(&root) {
            p.absorb(child.raw.clone());
        }
    }
    let mut out: Vec<RawSession> = mains
        .into_values()
        .map(|mut m| {
            m.source_title = titles.get(&m.native_session_id).cloned();
            m
        })
        .collect();
    out.sort_by(|a, b| a.native_session_id.cmp(&b.native_session_id));
    out
}

/// Reads Codex sessions (from `sessions/` and `archived_sessions/`) that
/// have any file modified at or after `modified_since`. A parent and its subagent threads form one family that
/// is read whole whenever any of its files is in the window, so the result
/// for a session never depends on the window. Guardian review threads and
/// subagents whose root session is missing are dropped.
pub fn read_codex_sessions(codex_dir: &Path, modified_since: SystemTime) -> Vec<RawSession> {
    let titles = read_thread_titles(codex_dir);

    // Pass 1: read only each file's session_meta to learn the family tree.
    let headers: Vec<(PathBuf, String, CodexRole)> = list_codex_files(codex_dir)
        .into_iter()
        .filter_map(|path| {
            let (id, role) = read_header(&path)?;
            Some((path, id, role))
        })
        .collect();
    let roles: HashMap<&str, &CodexRole> = headers.iter().map(|(_, id, r)| (id.as_str(), r)).collect();
    let wanted: HashSet<String> = headers
        .iter()
        .filter(|(path, _, _)| modified_at_or_after(path, modified_since))
        .filter_map(|(_, id, _)| root_in(&roles, id))
        .collect();

    // Pass 2: read every file of every wanted family in full.
    let states: Vec<CodexFileState> = headers
        .iter()
        .filter(|(_, id, _)| root_in(&roles, id).is_some_and(|r| wanted.contains(&r)))
        .map(|(path, _, _)| {
            let mut st = CodexFileState::default();
            let _ = read_codex_file(path, 0, &mut st);
            st
        })
        .collect();
    let refs: Vec<&CodexFileState> = states.iter().collect();
    merge_codex(&refs, &titles)
}

fn read_header(path: &Path) -> Option<(String, CodexRole)> {
    let bytes = first_matching_line(path, r#""type":"session_meta""#).ok()??;
    let line = serde_json::from_slice::<Line>(&bytes).ok()?;
    let meta = serde_json::from_str::<SessionMeta>(line.payload?.get()).ok()?;
    let role = role_of(&meta);
    Some((meta.id, role))
}

fn apply_meta(raw: &mut RawSession, meta: SessionMeta) -> CodexRole {
    let role = role_of(&meta);
    raw.native_session_id = meta.id;
    raw.cwd = meta.cwd;
    raw.git_branch = meta.git.and_then(|g| g.branch).filter(|b| !b.is_empty());
    if meta.originator.as_deref() == Some("Claude Code") {
        raw.invoked_by = Some(Tool::ClaudeCode);
    }
    role
}

fn role_of(meta: &SessionMeta) -> CodexRole {
    let source = meta.source.as_ref().and_then(|s| s.get("subagent"));
    match meta.thread_source.as_deref() {
        Some("guardian_review") => CodexRole::Excluded,
        kind if kind == Some("subagent") || source.is_some() => meta
            .source
            .as_ref()
            .and_then(|s| s.pointer("/subagent/thread_spawn/parent_thread_id"))
            .and_then(|v| v.as_str())
            .map_or(CodexRole::Excluded, |p| CodexRole::Subagent { parent: p.to_owned() }),
        _ => CodexRole::Main,
    }
}

#[derive(Deserialize)]
struct ThreadLabel {
    id: String,
    label: Option<String>,
    opening_prefix: Option<String>,
}

fn valid_label(text: &str) -> Option<&str> {
    let label = text.trim();
    (!label.is_empty() && label.encode_utf16().count() <= 200 && !label.contains(char::is_control))
        .then_some(label)
}

fn read_titles(path: &Path) -> HashMap<String, String> {
    #[derive(Deserialize)]
    struct Entry {
        id: String,
        thread_name: Option<String>,
    }
    let mut titles = HashMap::new();
    let _ = for_each_matching_line(path, &[], |bytes| {
        if let Ok(Entry { id, thread_name: Some(name) }) = serde_json::from_slice::<Entry>(bytes)
            && let Some(label) = valid_label(&name)
        {
            titles.insert(id, label.to_owned());
        }
    });
    titles
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{build_session, TokenUsage, Tool};

    #[test]
    fn turn_completion_requires_a_final_response_from_the_same_turn() {
        use ObservedState::*;
        let mut st = CodexFileState::default();
        let started = |id: &str| format!(r#"{{"type":"task_started","turn_id":"{id}"}}"#);
        let completed = |id: &str| format!(r#"{{"type":"task_complete","turn_id":"{id}","last_agent_message":null}}"#);
        let final_msg = r#"{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"final"}]}"#;
        let commentary = r#"{"type":"agent_message","phase":"commentary","message":"progress"}"#;
        observe_turn(&mut st, "event_msg", 1, &started("first"));
        assert_eq!(st.raw.observed_status.unwrap().state, Running);
        observe_turn(&mut st, "response_item", 2, final_msg);
        assert_eq!(st.raw.observed_status.unwrap().state, Running);
        // A restart between final_answer and task_complete retains the evidence.
        st = serde_json::from_slice(&serde_json::to_vec(&st).unwrap()).unwrap();
        observe_turn(&mut st, "event_msg", 3, &completed("first"));
        assert_eq!(st.raw.observed_status.unwrap(), StatusObservation { state: Waiting, at: 3 });

        observe_turn(&mut st, "event_msg", 4, &started("second"));
        observe_turn(&mut st, "event_msg", 5, commentary);
        observe_turn(&mut st, "event_msg", 6, &completed("first"));
        observe_turn(&mut st, "response_item", 2, final_msg);
        assert_eq!(st.raw.observed_status.unwrap(), StatusObservation { state: Running, at: 4 });
        observe_turn(&mut st, "event_msg", 7, &completed("second"));
        assert_eq!(st.raw.observed_status.unwrap().state, Unknown);

        observe_turn(&mut st, "event_msg", 8, &started("third"));
        observe_turn(&mut st, "event_msg", 9, r#"{"type":"task_complete","turn_id":"third","last_agent_message":"done"}"#);
        assert_eq!(st.raw.observed_status.unwrap().state, Waiting);
        observe_turn(&mut st, "event_msg", 10, &started("fourth"));
        observe_turn(&mut st, "event_msg", 11, r#"{"type":"turn_aborted","turn_id":"fourth","reason":"interrupted"}"#);
        assert_eq!(st.raw.observed_status.unwrap().state, Unknown);
    }

    #[test]
    fn subagent_status_never_propagates_to_its_parent() {
        let mut main = CodexFileState::default();
        let mut child = CodexFileState::default();
        for (st, id, source) in [(&mut main, "main", serde_json::json!("cli")),
            (&mut child, "child", serde_json::json!({"subagent":{"thread_spawn":{"parent_thread_id":"main"}}}))]
        {
            let line = serde_json::json!({"type":"session_meta","payload":{"id":id,"source":source}}).to_string();
            apply_line(st, serde_json::from_str(&line).unwrap());
        }
        let done = r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}"#;
        apply_line(&mut child, serde_json::from_str(done).unwrap());
        let merged = merge_codex(&[&main, &child], &HashMap::new());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].native_session_id, "main");
        assert_eq!(merged[0].activity.len(), 1);
        assert_eq!(merged[0].observed_status, None);
    }

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

    /// Copies the Codex fixture into a fresh temp dir and makes the named
    /// rollout files look like they were last written in 2000.
    fn fixture_with_stale(name: &str, stale: &[&str]) -> std::path::PathBuf {
        let src = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/codex"));
        let dst = std::env::temp_dir().join(format!("aiwl-codex-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dst);
        copy_tree(src, &dst);
        let old = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(946_684_800);
        let recent = SystemTime::now();
        for file in std::fs::read_dir(dst.join("sessions/2026/11/20")).unwrap().flatten() {
            let name = file.file_name();
            let modified = if stale.iter().any(|&stale_name| name == stale_name) { old } else { recent };
            std::fs::File::options().write(true).open(file.path()).unwrap().set_modified(modified).unwrap();
        }
        dst
    }

    fn copy_tree(src: &Path, dst: &Path) {
        std::fs::create_dir_all(dst).unwrap();
        for e in std::fs::read_dir(src).unwrap().flatten() {
            let to = dst.join(e.file_name());
            if e.path().is_dir() { copy_tree(&e.path(), &to) } else { std::fs::copy(e.path(), to).unwrap(); }
        }
    }

    fn one_day_ago() -> SystemTime {
        SystemTime::now() - std::time::Duration::from_secs(86_400)
    }

    fn total(r: &RawSession) -> TokenUsage {
        let mut t = TokenUsage::default();
        for e in &r.token_events { t += e.usage; }
        t
    }

    #[test]
    fn includes_stale_subagent_of_recent_parent() {
        let dir = fixture_with_stale("stale-child", &["rollout-b.jsonl"]);
        let v = read_codex_sessions(&dir, one_day_ago());
        assert_eq!(v.len(), 1);
        assert_eq!(total(&v[0]), TokenUsage { input: 700, output: 90, cache_read: 900, cache_write: 0 });
    }

    #[test]
    fn includes_stale_parent_of_recent_subagent() {
        let dir = fixture_with_stale("stale-parent", &["rollout-a.jsonl"]);
        let v = read_codex_sessions(&dir, one_day_ago());
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].native_session_id, "c1");
        assert_eq!(total(&v[0]), TokenUsage { input: 700, output: 90, cache_read: 900, cache_write: 0 });
    }

    #[test]
    fn skips_families_entirely_outside_window() {
        let all = ["rollout-a.jsonl", "rollout-b.jsonl", "rollout-c.jsonl", "rollout-d.jsonl"];
        let dir = fixture_with_stale("all-stale", &all);
        assert!(read_codex_sessions(&dir, one_day_ago()).is_empty());
    }

    #[test]
    fn reads_archived_sessions() {
        let dir = fixture_with_stale("archived", &[]);
        std::fs::create_dir_all(dir.join("archived_sessions")).unwrap();
        std::fs::write(
            dir.join("archived_sessions/rollout-e.jsonl"),
            concat!(
                r#"{"timestamp":"2026-11-19T02:00:00.000Z","type":"session_meta","payload":{"id":"c5","cwd":"/tmp/old","originator":"Codex Desktop","thread_source":"user"}}"#, "\n",
                r#"{"timestamp":"2026-11-19T02:00:05.000Z","type":"response_item","payload":{"type":"message","role":"user"}}"#, "\n",
            ),
        )
        .unwrap();
        let ids: Vec<String> = read_codex_sessions(&dir, SystemTime::UNIX_EPOCH).into_iter().map(|r| r.native_session_id).collect();
        assert_eq!(ids, vec!["c1", "c5"]);
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

    fn fixture_dir() -> &'static Path {
        Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/codex/sessions/2026/11/20"))
    }

    fn temp_dir(test: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aiwl-codex-inc-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn append(path: &Path, bytes: &[u8]) {
        use std::io::Write;
        std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap().write_all(bytes).unwrap();
    }

    fn sorted(mut raws: Vec<RawSession>) -> Vec<RawSession> {
        for r in &mut raws {
            r.activity.sort();
            r.token_events.sort_by_key(|e| e.at);
        }
        raws
    }

    fn read_whole(path: &Path) -> CodexFileState {
        let mut st = CodexFileState::default();
        read_codex_file(path, 0, &mut st).unwrap();
        st
    }

    fn titles() -> HashMap<String, String> {
        read_thread_titles(Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/codex")))
    }

    #[test]
    fn incremental_equals_full_read_at_every_split() {
        let names = ["rollout-a.jsonl", "rollout-b.jsonl", "rollout-c.jsonl", "rollout-d.jsonl"];
        let bytes: Vec<Vec<u8>> = names.iter().map(|n| std::fs::read(fixture_dir().join(n)).unwrap()).collect();
        let dir = temp_dir("split");
        let paths: Vec<PathBuf> = names.iter().map(|n| dir.join(n)).collect();
        for (p, b) in paths.iter().zip(&bytes) {
            std::fs::write(p, b).unwrap();
        }
        let full: Vec<CodexFileState> = paths.iter().map(|p| read_whole(p)).collect();
        let refs: Vec<&CodexFileState> = full.iter().collect();
        let expected = sorted(merge_codex(&refs, &titles()));
        assert_eq!(expected.len(), 1);
        assert_eq!(expected[0].native_session_id, "c1");
        assert_eq!(total(&expected[0]), TokenUsage { input: 700, output: 90, cache_read: 900, cache_write: 0 });

        for i in 0..names.len() {
            for k in 0..=bytes[i].len() {
                std::fs::write(&paths[i], &bytes[i][..k]).unwrap();
                let mut st = CodexFileState::default();
                let off = read_codex_file(&paths[i], 0, &mut st).unwrap();
                append(&paths[i], &bytes[i][k..]);
                read_codex_file(&paths[i], off, &mut st).unwrap();
                let mut all: Vec<&CodexFileState> = full.iter().collect();
                all[i] = &st;
                assert_eq!(sorted(merge_codex(&all, &titles())), expected, "file {i} split at {k}");
                assert_eq!(st.user_texts, full[i].user_texts, "file {i} split at {k}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cumulative_totals_are_not_double_counted_across_resumes() {
        let bytes = std::fs::read(fixture_dir().join("rollout-a.jsonl")).unwrap();
        let dir = temp_dir("cumulative");
        let path = dir.join("a.jsonl");
        // Split right after each token_count line.
        let mut ends = Vec::new();
        for (i, b) in bytes.iter().enumerate() {
            if *b == b'\n' && bytes[..i].windows(11).any(|w| w == b"token_count") {
                ends.push(i + 1);
            }
        }
        assert!(!ends.is_empty());
        for k in ends {
            std::fs::write(&path, &bytes[..k]).unwrap();
            let mut st = CodexFileState::default();
            let off = read_codex_file(&path, 0, &mut st).unwrap();
            assert_eq!(off, k as u64);
            append(&path, &bytes[k..]);
            read_codex_file(&path, off, &mut st).unwrap();
            assert_eq!(total(&st.raw), TokenUsage { input: 600, output: 80, cache_read: 900, cache_write: 0 }, "split at {k}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn child_read_before_parent_still_merges() {
        let child = read_whole(&fixture_dir().join("rollout-b.jsonl"));
        assert!(merge_codex(&[&child], &titles()).is_empty());
        let parent = read_whole(&fixture_dir().join("rollout-a.jsonl"));
        let v = merge_codex(&[&child, &parent], &titles());
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].native_session_id, "c1");
        assert_eq!(total(&v[0]), TokenUsage { input: 700, output: 90, cache_read: 900, cache_write: 0 });
    }

    #[test]
    fn desktop_names_survive_a_missing_index_and_skip_prompt_placeholders() {
        let dir = temp_dir("thread-labels");
        let db = dir.join("state_5.sqlite");
        fs::write(dir.join("session_index.jsonl"), r#"{"id":"b","thread_name":"A short question"}"#).unwrap();
        let status = Command::new("sqlite3").arg(&db).arg(
            "CREATE TABLE threads(id TEXT, name TEXT, title TEXT, first_user_message TEXT);
             INSERT INTO threads VALUES ('a','Saved name','Question','Question'),
                ('b',NULL,'A short question','A short question with private context'),
                ('c',NULL,'Summarized title','Question'),
                ('d',NULL,'raw text',NULL);"
        ).status().unwrap();
        assert!(status.success());
        assert_eq!(read_thread_titles(&dir), HashMap::from([
            ("a".into(), "Saved name".into()), ("c".into(), "Summarized title".into()),
        ]));
    }

    #[test]
    fn desktop_user_turns_ignore_context_and_duplicate_envelopes() {
        let mut state = CodexFileState { role: Some(CodexRole::Main), ..Default::default() };
        for (envelope, payload) in [
            ("response_item", serde_json::json!({"type":"message","role":"user","content":[
                {"type":"input_text","text":"# AGENTS.md instructions"},
                {"type":"input_text","text":"<environment_context>metadata"},
                {"type":"input_text","text":"Fix calendar dates"}]})),
            ("event_msg", serde_json::json!({"type":"user_message","message":"Fix calendar dates"})),
        ] {
            let line = serde_json::json!({"timestamp":"2026-11-20T05:00:00Z","type":envelope,"payload":payload}).to_string();
            apply_line(&mut state, serde_json::from_str(&line).unwrap());
        }
        assert_eq!(state.user_texts, ["Fix calendar dates"]);
    }

    #[test]
    fn collects_user_texts_from_main_only() {
        let dir = temp_dir("texts");
        let meta = |id: &str, extra: &str| {
            format!("{{\"timestamp\":\"2026-11-20T01:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"{extra}}}}}\n")
        };
        let user = |t: &str| {
            format!("{{\"timestamp\":\"2026-11-20T01:00:01.000Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"{t}\"}}}}\n")
        };
        let long = "あ".repeat(400);
        let body: String = ["one", "two", &long, "four"].iter().map(|t| user(t)).collect();
        let main = dir.join("m.jsonl");
        let sub = dir.join("s.jsonl");
        let guard = dir.join("g.jsonl");
        std::fs::write(&main, meta("m", "") + &body).unwrap();
        std::fs::write(&sub, meta("s", r#","thread_source":"subagent","source":{"subagent":{"thread_spawn":{"parent_thread_id":"m"}}}"#) + &body).unwrap();
        std::fs::write(&guard, meta("g", r#","thread_source":"guardian_review""#) + &body).unwrap();

        let m = read_whole(&main);
        assert_eq!(m.user_texts.len(), 3);
        assert_eq!(m.user_texts[0], "one");
        assert_eq!(m.user_texts[1], "two");
        assert_eq!(m.user_texts[2].chars().count(), 300);
        assert!(read_whole(&sub).user_texts.is_empty());
        assert!(read_whole(&guard).user_texts.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_session_meta_wins_across_resumes() {
        let dir = temp_dir("meta");
        let path = dir.join("m.jsonl");
        let meta = |id: &str, cwd: &str| {
            format!("{{\"timestamp\":\"2026-11-20T01:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"{cwd}\"}}}}\n")
        };
        std::fs::write(&path, meta("m", "/first")).unwrap();
        let mut st = CodexFileState::default();
        let off = read_codex_file(&path, 0, &mut st).unwrap();
        append(&path, meta("other", "/second").as_bytes());
        read_codex_file(&path, off, &mut st).unwrap();
        assert_eq!(st.thread_id.as_deref(), Some("m"));
        assert_eq!(st.raw.cwd.as_deref(), Some("/first"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
