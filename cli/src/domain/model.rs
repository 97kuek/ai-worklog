use std::collections::BTreeSet;
use std::ops::AddAssign;

use serde::{Deserialize, Serialize};

/// UTC epoch milliseconds.
pub type Millis = i64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    ClaudeCode,
    Codex,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl AddAssign for TokenUsage {
    fn add_assign(&mut self, rhs: Self) {
        self.input += rhs.input;
        self.output += rhs.output;
        self.cache_read += rhs.cache_read;
        self.cache_write += rhs.cache_write;
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TokenEvent {
    pub at: Millis,
    pub usage: TokenUsage,
}

/// A session as read from one tool's logs, before blocks are built.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RawSession {
    /// Adapters always set this to `Some`.
    pub tool: Option<Tool>,
    pub native_session_id: String,
    pub source_title: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub models: BTreeSet<String>,
    pub invoked_by: Option<Tool>,
    /// Timestamps of activity, in any order.
    pub activity: Vec<Millis>,
    pub token_events: Vec<TokenEvent>,
}

impl RawSession {
    /// 子（サブエージェントなど）の activity、token_events、models を足す。メタ情報は自分のものを残す
    pub fn absorb(&mut self, child: RawSession) {
        self.activity.extend(child.activity);
        self.token_events.extend(child.token_events);
        self.models.extend(child.models);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub seq: u32,
    pub started_at: Millis,
    pub ended_at: Millis,
    pub message_count: u32,
    pub tokens: TokenUsage,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub tool: Tool,
    pub native_session_id: String,
    pub source_title: Option<String>,
    /// Last path component of `cwd`.
    pub project: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    /// Sorted ascending.
    pub models: Vec<String>,
    pub invoked_by: Option<Tool>,
    pub started_at: Millis,
    pub ended_at: Millis,
    /// Sum of block durations in minutes.
    pub active_minutes: f64,
    pub tokens: TokenUsage,
    pub blocks: Vec<Block>,
}
