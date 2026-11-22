//! Account usage is collected separately from worklog sessions. Only typed
//! numeric metadata and an opaque session UUID can enter an upload.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::adapters::claude::{ClaudeFile, list_claude_files};
use crate::adapters::fsutil::{open_private_file, write_atomically};
use crate::adapters::http::{HttpSender, SendError};
use crate::adapters::jsonl::{self, FileId};
use crate::adapters::status_hook::collect_queue;
use crate::domain::fnv1a64;
use serde::{Deserialize, Serialize};

fn read<T: serde::de::DeserializeOwned + Default>(path: &Path) -> io::Result<T> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e),
    }
}

fn valid_account(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || (i > 0 && matches!(c, b'_' | b'-'))
        })
}

pub fn profiles(home: &Path) -> io::Result<BTreeMap<String, PathBuf>> {
    let dirs: BTreeMap<String, PathBuf> = read(&home.join("claude-usage-profiles.json"))?;
    let mut seen = Vec::new();
    for (label, dir) in &dirs {
        if !valid_account(label) || !dir.is_absolute() || !dir.is_dir() {
            return Err(io::Error::other("invalid Claude usage profile"));
        }
        let path = dir.canonicalize()?;
        if seen.contains(&path) {
            return Err(io::Error::other("duplicate Claude usage profile"));
        }
        seen.push(path);
    }
    Ok(dirs)
}

fn uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

#[derive(Default, Deserialize)]
struct Limits {
    five_hour: Option<WindowInput>,
    seven_day: Option<WindowInput>,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Window {
    used_percentage: f64,
    resets_at: Option<u64>,
}
#[derive(Deserialize)]
struct WindowInput {
    used_percentage: Option<f64>,
    resets_at: Option<u64>,
}
impl WindowInput {
    fn observed(self) -> Option<Window> {
        let used_percentage = self.used_percentage.filter(|p| (0.0..=100.0).contains(p))?;
        Some(Window {
            used_percentage,
            resets_at: self.resets_at.filter(|v| *v <= 253402300799),
        })
    }
}

#[derive(Deserialize)]
struct StatusLine {
    session_id: String,
    cost: Option<Cost>,
    rate_limits: Option<Limits>,
}
#[derive(Deserialize)]
struct Cost {
    total_cost_usd: Option<f64>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct Snapshot {
    account: String,
    session_id: String,
    observed_at: i64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cost_usd: Option<f64>,
    five_hour: Option<Window>,
    seven_day: Option<Window>,
}

impl Snapshot {
    fn payload(&self) -> serde_json::Value {
        let mut limits = Vec::new();
        for (window_seconds, window) in [(18_000, &self.five_hour), (604_800, &self.seven_day)] {
            if let Some(window) = window {
                limits.push(serde_json::json!({
                    "window_seconds": window_seconds, "used_percentage": window.used_percentage,
                    "resets_at": window.resets_at
                }));
            }
        }
        serde_json::json!({
            "provider": "claude", "account": self.account, "session_id": self.session_id,
            "observed_at": self.observed_at, "input_tokens": self.input_tokens, "output_tokens": self.output_tokens,
            "cost_usd": self.cost_usd, "limits": limits
        })
    }
}

pub fn capture(home: &Path, active: &Path, input: &[u8], at: i64) -> io::Result<()> {
    let active = active.canonicalize()?;
    let Some((account, _)) = profiles(home)?
        .into_iter()
        .find(|(_, dir)| dir.canonicalize().ok().as_ref() == Some(&active))
    else {
        return Ok(());
    };
    let status: StatusLine = serde_json::from_slice(input)?;
    if !uuid(&status.session_id) {
        return Ok(());
    }
    let limits = status.rate_limits.unwrap_or_default();
    let snapshot = Snapshot {
        account: account.clone(),
        session_id: status.session_id,
        observed_at: at,
        cost_usd: status
            .cost
            .and_then(|c| c.total_cost_usd)
            .filter(|c| *c >= 0.0),
        five_hour: limits.five_hour.and_then(WindowInput::observed),
        seven_day: limits.seven_day.and_then(WindowInput::observed),
        ..Default::default()
    };
    let dir = home.join("claude-usage").join(account).join("status");
    let lock = open_private_file(&dir, "write.lock")?;
    lock.lock()?;
    // Keep independent windows when a new session starts without quota data.
    // All three files contain only allowlisted fields and retain their actual observation time.
    let mut changed = false;
    for (key, included) in [
        (snapshot.session_id.as_str(), snapshot.cost_usd.is_some()),
        ("five_hour", snapshot.five_hour.is_some()),
        ("seven_day", snapshot.seven_day.is_some()),
    ] {
        if !included {
            continue;
        }
        let path = dir.join(format!("{key}.json"));
        let previous: Snapshot = read(&path)?;
        let unchanged = match key {
            "five_hour" => previous.five_hour == snapshot.five_hour,
            "seven_day" => previous.seven_day == snapshot.seven_day,
            _ => previous.cost_usd == snapshot.cost_usd,
        };
        if previous.observed_at > at || unchanged {
            continue;
        }
        write_atomically(&path, &serde_json::to_vec(&snapshot)?)?;
        changed = true;
    }
    if changed {
        open_private_file(&collect_queue(home), "pending")?;
    }
    Ok(())
}

#[derive(Default, Clone, PartialEq, Serialize, Deserialize)]
struct Tokens {
    input: Option<u64>,
    output: Option<u64>,
}

#[derive(Deserialize)]
struct Usage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}
#[derive(Deserialize)]
struct Message {
    model: Option<String>,
    id: Option<String>,
    usage: Option<Usage>,
}
#[derive(Deserialize)]
struct Line {
    #[serde(rename = "isApiErrorMessage", default)]
    api_error: bool,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    message: Option<Message>,
}
#[derive(Default, Serialize, Deserialize)]
struct Cursor {
    file_id: Option<FileId>,
    offset: u64,
    seen: HashMap<u64, Tokens>,
}

impl Cursor {
    fn add(&mut self, line: &[u8], session: &str) {
        let Ok(row) = serde_json::from_slice::<Line>(line) else {
            return;
        };
        if row.kind != "assistant"
            || row.api_error
            || row.session_id.as_deref().is_some_and(|s| s != session)
        {
            return;
        }
        let Some(Message {
            id,
            model,
            usage: Some(usage),
        }) = row.message
        else {
            return;
        };
        if model.as_deref() == Some("<synthetic>") {
            return;
        }
        let Some(key) = id
            .filter(|s| !s.is_empty())
            .or(row.request_id)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        let totals = self.seen.entry(fnv1a64(key.as_bytes())).or_default();
        // Some content blocks repeat the same message ID with a later output count.
        let input = usage
            .input_tokens
            .and_then(|n| n.checked_add(usage.cache_creation_input_tokens.unwrap_or(0)))
            .and_then(|n| n.checked_add(usage.cache_read_input_tokens.unwrap_or(0)));
        totals.input = totals.input.max(input);
        totals.output = totals.output.max(usage.output_tokens);
    }
}

#[derive(Default, Serialize, Deserialize)]
struct SessionState {
    // Keys are hashes of relative log filenames, never workspace names.
    files: BTreeMap<u64, Cursor>,
    last_log_ms: i64,
    #[serde(default)]
    totals: Tokens,
    #[serde(default)]
    tokens_at: i64,
    #[serde(default)]
    archived_cost: Option<f64>,
    sent: BTreeMap<String, u64>,
}

fn update_file(session: &mut SessionState, file: &ClaudeFile, root: &Path) -> io::Result<bool> {
    let path = file.path.canonicalize()?;
    let Ok(relative) = path.strip_prefix(root) else {
        return Ok(false);
    };
    let info = jsonl::stat(&path)?;
    let cursor = session
        .files
        .entry(fnv1a64(relative.as_os_str().as_encoded_bytes()))
        .or_default();
    if cursor.file_id == Some(info.id) && info.len == cursor.offset {
        return Ok(false);
    }
    if cursor.file_id != Some(info.id) || info.len < cursor.offset {
        *cursor = Cursor {
            file_id: Some(info.id),
            ..Default::default()
        };
    }
    cursor.offset = jsonl::read_matching_lines_from(&path, cursor.offset, &["\"usage\""], |b| {
        cursor.add(b, &file.session_id)
    })?;
    if let Ok(at) = path.metadata()?.modified()?.duration_since(UNIX_EPOCH) {
        session.last_log_ms = session.last_log_ms.max(at.as_millis() as i64);
    }
    Ok(true)
}

fn sum(session: &SessionState) -> Tokens {
    let mut requests = HashMap::<u64, Tokens>::new();
    for cursor in session.files.values() {
        for (id, tokens) in &cursor.seen {
            let seen = requests.entry(*id).or_default();
            seen.input = seen.input.max(tokens.input);
            seen.output = seen.output.max(tokens.output);
        }
    }
    let total = |select: fn(&Tokens) -> Option<u64>| -> Option<u64> {
        if requests.is_empty() {
            return None;
        }
        requests
            .values()
            .try_fold(0u64, |sum, row| sum.checked_add(select(row)?))
    };
    Tokens {
        input: total(|t| t.input),
        output: total(|t| t.output),
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Registry {
    destination: u64,
    #[serde(default)]
    summary_file: Option<(FileId, u64, u128)>,
    sessions: BTreeMap<String, SessionState>,
}

// Claude Code retains the last session summary per project. This source
// has no observation timestamp; use it only as a lower-priority cost seed.
fn historical_costs(dir: &Path, registry: &mut Registry, rescan: bool) -> bool {
    #[derive(Deserialize)]
    struct Project {
        #[serde(rename = "lastSessionId")]
        session_id: Option<String>,
        #[serde(rename = "lastCost")]
        cost: Option<f64>,
    }
    #[derive(Deserialize)]
    struct Summaries {
        #[serde(default)]
        projects: BTreeMap<String, Project>,
    }
    let default = std::env::var_os("HOME").map(PathBuf::from);
    let path = match default {
        Some(user) if crate::adapters::config::is_default_claude_profile(dir) => {
            user.join(".claude.json")
        }
        _ => dir.join(".claude.json"),
    };
    let Ok(info) = jsonl::stat(&path) else {
        return false;
    };
    let modified = path
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_nanos());
    let Some(stamp) = modified.map(|t| (info.id, info.len, t)) else {
        return false;
    };
    if !rescan && registry.summary_file == Some(stamp) {
        return false;
    }
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let Ok(summaries) = serde_json::from_reader::<_, Summaries>(io::BufReader::new(file)) else {
        return false;
    };
    for summary in summaries.projects.into_values() {
        let Some((id, cost)) = summary.session_id.zip(summary.cost) else {
            continue;
        };
        if cost >= 0.0
            && let Some(session) = registry.sessions.get_mut(&id)
        {
            session.archived_cost = Some(cost);
        }
    }
    registry.summary_file = Some(stamp);
    true
}

fn send(snapshot: &Snapshot, sender: &HttpSender) -> io::Result<()> {
    #[derive(Deserialize)]
    struct Ack {
        ok: bool,
    }
    match sender.put::<Ack>("usage", &snapshot.payload().to_string()) {
        Ok(Ack { ok: true }) => Ok(()),
        Ok(_) => Err(io::Error::other("unexpected acknowledgement")),
        Err(
            SendError::Auth(code)
            | SendError::Server(code)
            | SendError::Rejected { status: code, .. },
        ) => Err(io::Error::other(format!(
            "usage upload failed (HTTP {code})"
        ))),
        Err(SendError::Network(_)) => Err(io::Error::other("usage upload failed (network)")),
    }
}

// Called under collect.lock. Store progress before returning an upload error so
// an offline retry does not reread full transcripts or lose acknowledged writes.
pub fn sync(home: &Path, sender: &HttpSender) -> io::Result<usize> {
    sync_to(home, &sender.url, &sender.client_id, |snapshot| {
        send(snapshot, sender)
    })
}

fn sync_to(
    home: &Path,
    url: &str,
    client_id: &str,
    mut upload: impl FnMut(&Snapshot) -> io::Result<()>,
) -> io::Result<usize> {
    let mut uploaded = 0;
    for (account, dir) in profiles(home)? {
        let cache = home.join("claude-usage").join(&account);
        let path = cache.join("sync.json");
        let mut registry: Registry = read(&path)?;
        let destination = fnv1a64(&serde_json::to_vec(&(url, client_id, &dir))?);
        let mut dirty = false;
        if registry.destination != destination {
            registry = Registry {
                destination,
                ..Default::default()
            };
            dirty = true;
        }
        let previous_count = registry.sessions.len();
        let mut changed_sessions = HashSet::new();
        let projects = dir.join("projects");
        if projects.is_dir() {
            let root = projects.canonicalize()?;
            for file in list_claude_files(&projects) {
                if !uuid(&file.session_id) {
                    continue;
                }
                let state = registry
                    .sessions
                    .entry(file.session_id.clone())
                    .or_default();
                if update_file(state, &file, &root)? {
                    changed_sessions.insert(file.session_id);
                    dirty = true;
                }
            }
        }
        let new_sessions = previous_count != registry.sessions.len();
        dirty |= historical_costs(&dir, &mut registry, new_sessions);
        let status = cache.join("status");
        let mut pending = BTreeMap::<String, Vec<(String, Snapshot)>>::new();
        if status.is_dir() {
            for entry in fs::read_dir(status)? {
                let path = entry?.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let snapshot: Snapshot = read(&path)?;
                if snapshot.account != account || !uuid(&snapshot.session_id) {
                    continue;
                }
                let key = path.file_stem().unwrap().to_string_lossy().into_owned();
                registry
                    .sessions
                    .entry(snapshot.session_id.clone())
                    .or_default();
                pending
                    .entry(snapshot.session_id.clone())
                    .or_default()
                    .push((key, snapshot));
            }
        }
        let result = (|| -> io::Result<()> {
            for (id, state) in &mut registry.sessions {
                if changed_sessions.contains(id) {
                    let totals = sum(state);
                    if totals != state.totals {
                        state.totals = totals;
                        state.tokens_at = state.last_log_ms;
                    }
                }
                let tokens = &state.totals;
                let mut frames = pending.remove(id).unwrap_or_default();
                // Timestamp zero marks an undated project summary. The server
                // compares costs independently, so any live cost takes precedence.
                if let Some(cost) = state.archived_cost
                    && (tokens.input.is_some() || tokens.output.is_some())
                    && !frames.iter().any(|(_, snap)| snap.cost_usd.is_some())
                {
                    frames.push((
                        "archive".into(),
                        Snapshot {
                            account: account.clone(),
                            session_id: id.clone(),
                            observed_at: 0,
                            cost_usd: Some(cost),
                            ..Default::default()
                        },
                    ));
                }
                if tokens.input.is_some() || tokens.output.is_some() {
                    frames.push((
                        "transcript".into(),
                        Snapshot {
                            account: account.clone(),
                            session_id: id.clone(),
                            observed_at: state.tokens_at,
                            input_tokens: tokens.input,
                            output_tokens: tokens.output,
                            ..Default::default()
                        },
                    ));
                }
                frames.sort_by_key(|(_, s)| s.observed_at);
                let mut accepted = None;
                for (key, snap) in frames {
                    let fingerprint = fnv1a64(&serde_json::to_vec(&snap.payload())?);
                    if state.sent.get(&key) == Some(&fingerprint) {
                        continue;
                    }
                    if accepted != Some(fingerprint) {
                        upload(&snap)?;
                        uploaded += 1;
                    }
                    accepted = Some(fingerprint);
                    state.sent.insert(key, fingerprint);
                    dirty = true;
                }
            }
            Ok(())
        })();
        if dirty {
            write_atomically(&path, &serde_json::to_vec(&registry)?)?;
        }
        result?;
    }
    Ok(uploaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn validates_account_ids_before_using_them_as_directory_names() {
        for id in ["x", "0", "3rd-party_123", &"a".repeat(64)] {
            assert!(valid_account(id));
        }
        for id in [
            "",
            ".hidden",
            "..",
            "a/b",
            "A",
            "_team",
            "-x",
            "with space",
            &"a".repeat(65),
        ] {
            assert!(!valid_account(id));
        }
    }

    #[test]
    fn isolates_accounts_backfills_once_and_retries_only_unacknowledged_usage() {
        let home = std::env::temp_dir().join(format!("taskfolio-usage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let id = "ffff0000-aaaa-0000-bbbb-000000000000";
        let p = home.join("personal");
        let w = home.join("work");
        let dir = w.join("projects/private-repository");
        fs::create_dir_all(&p).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            home.join("claude-usage-profiles.json"),
            json!({"custom-01":p,"team_research":w}).to_string(),
        )
        .unwrap();
        let log = dir.join(format!("{id}.jsonl"));
        let row = |out| {
            json!({"sessionId":id,"type":"assistant","requestId":"req-secret","cwd":"private-repository",
            "message":{"id":"msg-secret","content":"private-conversation", "usage":{"input_tokens":3,"cache_read_input_tokens":7,"output_tokens":out}}}).to_string()
        };
        fs::write(&log, format!("{}\n{}\n", row(2), row(4))).unwrap();
        let frame = json!({"session_id":id,"cost":{"total_cost_usd":0.4},"model":{"display_name":"model"},
            "cwd":"private-repository","context_window":{"total_input_tokens":9999},"rate_limits":{"five_hour":{"used_percentage":0,"resets_at":100},"seven_day":{"used_percentage":null}}}).to_string();
        capture(&home, &p, frame.as_bytes(), 10).unwrap();
        fs::remove_file(collect_queue(&home).join("pending")).unwrap();
        capture(&home, &p, frame.as_bytes(), 20).unwrap();
        assert!(!collect_queue(&home).join("pending").exists());
        let summaries = json!({"projects":{"private-repository":{"lastSessionId":id,"lastCost":0.25},
            "untracked":{"lastSessionId":"00000000-0000-0000-0000-000000000001","lastCost":100}}});
        fs::write(w.join(".claude.json"), summaries.to_string()).unwrap();
        let mut rows = Vec::new();
        let fail = sync_to(&home, "example", "client", |snap| {
            if snap.account == "team_research" {
                return Err(io::Error::other("offline"));
            }
            rows.push(snap.payload());
            Ok(())
        });
        assert!(fail.is_err());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["observed_at"], 10);
        assert_eq!(rows[0]["provider"], "claude");
        assert_eq!(
            rows[0]["limits"],
            json!([{"window_seconds":18000,"used_percentage":0.0,"resets_at":100}])
        );
        assert!(rows[0].get("five_hour").is_none());
        assert!(rows[0]["input_tokens"].is_null());
        assert!(rows[0].get("seven_day").is_none());
        let collect = |rows: &mut Vec<serde_json::Value>| {
            sync_to(&home, "example", "client", |snap| {
                rows.push(snap.payload());
                Ok(())
            })
            .unwrap()
        };
        assert_eq!(collect(&mut rows), 2);
        assert_eq!(rows[1]["account"], "team_research");
        assert_eq!(rows[1]["cost_usd"], 0.25);
        assert_eq!(rows[1]["observed_at"], 0);
        assert_eq!(rows[2]["limits"], json!([]));
        assert_eq!(rows[2]["input_tokens"], 10);
        assert_eq!(rows[2]["output_tokens"], 4);
        assert!(rows[2]["cost_usd"].is_null());
        assert_eq!(collect(&mut rows), 0);
        let mut f = fs::OpenOptions::new().append(true).open(log).unwrap();
        write!(f, "{}", row(6)).unwrap();
        assert_eq!(collect(&mut rows), 0);
        writeln!(f).unwrap();
        assert_eq!(collect(&mut rows), 1);
        assert_eq!(rows[3]["output_tokens"], 6);
        let persisted =
            fs::read_to_string(home.join("claude-usage/team_research/sync.json")).unwrap();
        let wire = serde_json::to_string(&rows).unwrap();
        for term in [
            "req-secret",
            "msg-secret",
            "private-repository",
            "private-conversation",
            "9999",
        ] {
            assert!(!wire.contains(term) && !persisted.contains(term), "{term}");
        }
        fs::remove_dir_all(home).unwrap();
    }
}
