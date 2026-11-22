use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use crate::adapters::{claude::read_claude_sessions, codex::read_codex_sessions};
use crate::domain::{build_session, Millis, Session};

const DAY_MS: i64 = 86_400_000;

pub struct ScanOptions {
    pub claude_projects_dir: PathBuf,
    pub codex_dir: PathBuf,
    pub since_days: u32,
    pub gap_minutes: u32,
    pub now: Millis,
}

/// Reads files modified within the window and returns sessions that ended
/// within it, ordered by start time.
pub fn scan(opts: &ScanOptions) -> Vec<Session> {
    let cutoff = opts.now - i64::from(opts.since_days) * DAY_MS;
    let modified_since = SystemTime::UNIX_EPOCH + Duration::from_millis(cutoff.max(0) as u64);
    let gap_ms = i64::from(opts.gap_minutes) * 60_000;

    let mut sessions: Vec<Session> = read_claude_sessions(&opts.claude_projects_dir, modified_since)
        .into_iter()
        .chain(read_codex_sessions(&opts.codex_dir, modified_since))
        .filter_map(|raw| build_session(raw, gap_ms))
        .filter(|s| s.ended_at >= cutoff)
        .collect();
    sessions.sort_by_key(|s| s.started_at);
    sessions
}
