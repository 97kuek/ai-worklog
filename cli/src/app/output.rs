use jiff::tz::TimeZone;
use jiff::Timestamp;
use serde::Serialize;

use crate::adapters::time::format_ts;
use crate::domain::{ModelEffort, ObservedState, Session, StatusObservation, TokenUsage, Tool};

#[derive(Serialize)]
pub(super) struct StatusOut {
    state: ObservedState,
    at: String,
}

impl From<StatusObservation> for StatusOut {
    fn from(status: StatusObservation) -> Self {
        Self { state: status.state, at: format_ts(status.at) }
    }
}

#[derive(Serialize)]
struct SessionOut<'a> {
    tool: Tool,
    native_session_id: &'a str,
    source_title: Option<&'a str>,
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

/// Serializes sessions as a JSON array with RFC 3339 UTC timestamps.
pub fn to_json(sessions: &[Session]) -> String {
    let out: Vec<SessionOut<'_>> = sessions
        .iter()
        .map(|s| SessionOut {
            tool: s.tool,
            native_session_id: &s.native_session_id,
            source_title: s.source_title.as_deref(),
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
        })
        .collect();
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

/// One tab-separated line per block, in the given time zone.
pub fn to_table(sessions: &[Session], tz: &TimeZone) -> String {
    let fmt = |ms: i64, pattern: &str| {
        Timestamp::from_millisecond(ms)
            .map(|t| t.to_zoned_datetime(tz.clone()).strftime(pattern).to_string())
            .unwrap_or_default()
    };
    let mut out = String::new();
    for s in sessions {
        let tool = match s.tool {
            Tool::ClaudeCode => "claude_code",
            Tool::Codex => "codex",
        };
        let name = s.source_title.as_deref().unwrap_or(&s.native_session_id);
        for b in &s.blocks {
            let minutes = ((b.ended_at - b.started_at) as f64 / 60_000.0).round() as i64;
            out.push_str(&format!(
                "{}–{}\t{}m\t{}\t{}\t{}\n",
                fmt(b.started_at, "%Y-%m-%d %H:%M"),
                fmt(b.ended_at, "%H:%M"),
                minutes,
                tool,
                s.project.as_deref().unwrap_or("-"),
                name,
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::time::parse_ts;
    use crate::domain::{Block, TokenUsage, Tool};

    fn sample() -> Session {
        let t = TokenUsage { input: 14, output: 8, cache_read: 100, cache_write: 20 };
        let start = parse_ts("2026-11-20T01:00:00.000Z").unwrap();
        let end = parse_ts("2026-11-20T02:00:05.000Z").unwrap();
        Session {
            tool: Tool::ClaudeCode,
            native_session_id: "s1".into(),
            source_title: Some("デモ作業".into()),
            project: Some("demo".into()),
            cwd: Some("/tmp/demo".into()),
            git_branch: Some("main".into()),
            models: vec!["claude-haiku-5-5".into(), "claude-opus-5-5".into()],
            model_efforts: vec![],
            invoked_by: None,
            observed_status: None,
            started_at: start,
            ended_at: end,
            active_minutes: 60.083_333,
            tokens: t,
            blocks: vec![Block { seq: 0, started_at: start, ended_at: end, message_count: 7, tokens: t }],
        }
    }

    #[test]
    fn json_has_fixed_shape() {
        let v: serde_json::Value = serde_json::from_str(&to_json(&[sample()])).unwrap();
        assert_eq!(v[0]["tool"], "claude_code");
        assert_eq!(v[0]["started_at"], "2026-11-20T01:00:00.000Z");
        assert_eq!(v[0]["active_minutes"], 60.08);
        assert!(v[0]["invoked_by"].is_null());
        assert_eq!(v[0]["blocks"][0]["message_count"], 7);
        assert_eq!(v[0]["blocks"][0]["ended_at"], "2026-11-20T02:00:05.000Z");
        assert_eq!(v[0]["tokens"]["cache_write"], 20);
    }

    #[test]
    fn table_uses_given_timezone() {
        let tz = jiff::tz::TimeZone::get("Asia/Tokyo").unwrap();
        let table = to_table(&[sample()], &tz);
        assert_eq!(table.lines().next().unwrap(), "2026-11-20 10:00–11:00\t60m\tclaude_code\tdemo\tデモ作業");
    }
}
