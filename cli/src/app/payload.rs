use std::ops::Range;

use serde::Serialize;

use super::output::StatusOut;
use crate::adapters::time::format_ts;
use crate::domain::{fnv1a64, ModelEffort, Session, TokenUsage, Tool};

pub struct Outgoing<'a> {
    pub session: &'a Session,
    pub title: Option<&'a str>,
}

#[derive(Serialize)]
struct SessionOut<'a> {
    tool: Tool,
    native_session_id: &'a str,
    title: Option<&'a str>,
    project: Option<&'a str>,
    cwd: Option<&'a str>,
    git_branch: Option<&'a str>,
    models: &'a [String],
    #[serde(skip_serializing_if = "<[ModelEffort]>::is_empty")]
    model_efforts: &'a [ModelEffort],
    invoked_by: Option<Tool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observed_status: Option<StatusOut>,
    started_at: String,
    ended_at: String,
    active_minutes: f64,
    tokens: TokenUsage,
    blocks: Vec<BlockOut>,
}

#[derive(Serialize)]
struct BlockOut {
    seq: u32,
    started_at: String,
    ended_at: String,
    message_count: u32,
    tokens: TokenUsage,
}

#[derive(Serialize)]
struct Body<'a> {
    machine_name: &'a str,
    sessions: Vec<SessionOut<'a>>,
}

fn session_out<'a>(item: &Outgoing<'a>) -> SessionOut<'a> {
    let s = item.session;
    SessionOut {
        tool: s.tool,
        native_session_id: &s.native_session_id,
        title: item.title,
        project: s.project.as_deref(),
        cwd: s.cwd.as_deref(),
        git_branch: s.git_branch.as_deref(),
        models: &s.models,
        model_efforts: &s.model_efforts,
        invoked_by: s.invoked_by,
        observed_status: s.observed_status.map(Into::into),
        started_at: format_ts(s.started_at),
        ended_at: format_ts(s.ended_at),
        active_minutes: (s.active_minutes * 100.0).round() / 100.0,
        tokens: s.tokens,
        blocks: s
            .blocks
            .iter()
            .map(|b| BlockOut {
                seq: b.seq,
                started_at: format_ts(b.started_at),
                ended_at: format_ts(b.ended_at),
                message_count: b.message_count,
                tokens: b.tokens,
            })
            .collect(),
    }
}

/// JSON string in the shape of `contract/ingest.example.json`.
pub fn to_ingest_json(machine_name: &str, items: &[Outgoing<'_>]) -> String {
    let body = Body { machine_name, sessions: items.iter().map(session_out).collect() };
    serde_json::to_string(&body).unwrap_or_else(|_| "{}".into())
}

/// FNV-1a hash of the session's ingest JSON; used to tell whether it was already sent.
/// It is persisted, so it must not depend on the Rust version (unlike `DefaultHasher`).
pub fn session_fingerprint(item: &Outgoing<'_>) -> u64 {
    let json = serde_json::to_string(&session_out(item)).unwrap_or_default();
    fnv1a64(json.as_bytes())
}

pub struct ChunkLimits {
    pub max_sessions: usize,
    pub max_blocks: usize,
}

pub const DEFAULT_CHUNK: ChunkLimits = ChunkLimits { max_sessions: 10, max_blocks: 100 };

/// Splits sessions (given by block count) into ranges, keeping order.
/// A single session over the block limit gets a range of its own.
pub fn chunk(block_counts: &[usize], limits: &ChunkLimits) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut blocks = 0;
    for (i, &n) in block_counts.iter().enumerate() {
        let count = i - start;
        if count > 0 && (count + 1 > limits.max_sessions || blocks + n > limits.max_blocks) {
            out.push(start..i);
            start = i;
            blocks = 0;
        }
        blocks += n;
    }
    if start < block_counts.len() {
        out.push(start..block_counts.len());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::time::parse_ts;
    use crate::domain::{Block, ObservedState, StatusObservation};

    fn ts(s: &str) -> i64 {
        parse_ts(s).unwrap()
    }

    fn tok(input: u64, output: u64, cache_read: u64, cache_write: u64) -> TokenUsage {
        TokenUsage { input, output, cache_read, cache_write }
    }

    fn claude() -> Session {
        Session {
            tool: Tool::ClaudeCode,
            native_session_id: "example-claude-1".into(),
            source_title: None,
            project: Some("demo".into()),
            cwd: Some("/tmp/demo".into()),
            git_branch: Some("main".into()),
            models: vec!["claude-opus-5-5".into()],
            model_efforts: vec![ModelEffort { model: "claude-opus-5-5".into(), effort: None }],
            invoked_by: None,
            observed_status: Some(StatusObservation { state: ObservedState::Waiting, at: ts("2026-11-20T02:10:00Z") }),
            started_at: ts("2026-11-20T01:00:00.000Z"),
            ended_at: ts("2026-11-20T02:10:00.000Z"),
            active_minutes: 30.0,
            tokens: tok(120, 80, 1000, 200),
            blocks: vec![
                Block {
                    seq: 0,
                    started_at: ts("2026-11-20T01:00:00.000Z"),
                    ended_at: ts("2026-11-20T01:20:00.000Z"),
                    message_count: 6,
                    tokens: tok(100, 60, 800, 200),
                },
                Block {
                    seq: 1,
                    started_at: ts("2026-11-20T02:00:00.000Z"),
                    ended_at: ts("2026-11-20T02:10:00.000Z"),
                    message_count: 3,
                    tokens: tok(20, 20, 200, 0),
                },
            ],
        }
    }

    fn codex() -> Session {
        let t = ts("2026-11-20T01:05:00.000Z");
        Session {
            tool: Tool::Codex,
            native_session_id: "example-codex-1".into(),
            source_title: None,
            project: Some("demo".into()),
            cwd: Some("/tmp/demo".into()),
            git_branch: None,
            models: vec!["gpt-5.5".into()],
            model_efforts: vec![ModelEffort { model: "gpt-5.5".into(), effort: Some("high".into()) }],
            invoked_by: Some(Tool::ClaudeCode),
            observed_status: None,
            started_at: t,
            ended_at: t,
            active_minutes: 0.0,
            tokens: tok(10, 5, 0, 0),
            blocks: vec![Block { seq: 0, started_at: t, ended_at: t, message_count: 1, tokens: tok(10, 5, 0, 0) }],
        }
    }

    #[test]
    fn matches_the_contract_example() {
        let (a, b) = (claude(), codex());
        let items = [
            Outgoing { session: &a, title: Some("見本の作業") },
            Outgoing { session: &b, title: None },
        ];
        let got: serde_json::Value = serde_json::from_str(&to_ingest_json("example-mac", &items)).unwrap();
        let want: serde_json::Value =
            serde_json::from_str(include_str!("../../../contract/ingest.example.json")).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn never_emits_source_title() {
        let mut s = claude();
        s.source_title = Some("スレッド名".into());
        let json = to_ingest_json("m", &[Outgoing { session: &s, title: None }]);
        assert!(!json.contains("source_title"));
        assert!(!json.contains("スレッド名"));
    }

    #[test]
    fn fingerprint_changes_with_content_and_title() {
        let s = claude();
        let base = session_fingerprint(&Outgoing { session: &s, title: Some("a") });
        assert_eq!(base, session_fingerprint(&Outgoing { session: &claude(), title: Some("a") }));

        let mut status = claude();
        status.observed_status.as_mut().unwrap().state = ObservedState::Running;
        assert_ne!(base, session_fingerprint(&Outgoing { session: &status, title: Some("a") }));
        status.observed_status = s.observed_status;
        status.observed_status.as_mut().unwrap().at += 1;
        assert_ne!(base, session_fingerprint(&Outgoing { session: &status, title: Some("a") }));

        let mut ended = claude();
        ended.blocks[1].ended_at += 1000;
        assert_ne!(base, session_fingerprint(&Outgoing { session: &ended, title: Some("a") }));

        let mut tokens = claude();
        tokens.blocks[0].tokens.output += 1;
        assert_ne!(base, session_fingerprint(&Outgoing { session: &tokens, title: Some("a") }));

        assert_ne!(base, session_fingerprint(&Outgoing { session: &s, title: Some("b") }));
        assert_ne!(base, session_fingerprint(&Outgoing { session: &s, title: None }));
    }

    #[test]
    fn fingerprint_is_fnv1a_of_the_session_json() {
        // 保存する値なので、Rust の版で変わらないハッシュを使う
        let s = claude();
        let item = Outgoing { session: &s, title: Some("a") };
        let json = serde_json::to_string(&session_out(&item)).unwrap();
        assert_eq!(session_fingerprint(&item), crate::domain::fnv1a64(json.as_bytes()));
    }

    #[test]
    fn chunks_by_session_and_block_limits() {
        let l = ChunkLimits { max_sessions: 3, max_blocks: 10 };
        assert_eq!(chunk(&[1, 1, 1, 1], &l), vec![0..3, 3..4]);
        assert_eq!(chunk(&[6, 5, 4], &l), vec![0..1, 1..3]);
        assert_eq!(chunk(&[25, 1], &l), vec![0..1, 1..2]); // 上限を超える1セッションは単独で送る
        assert_eq!(chunk(&[], &l), Vec::<std::ops::Range<usize>>::new());
    }
}
