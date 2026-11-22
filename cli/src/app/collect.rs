use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::setup::check_expiry;
use super::payload::{chunk, session_fingerprint, to_ingest_json, ChunkLimits, Outgoing};
use super::ledger::{self, Ledger};
use super::state::{self, FileEntry, State};
use crate::adapters::claude::{list_claude_files, merge_claude, read_claude_file, ClaudeFile, ClaudeFileState};
use crate::adapters::codex::{list_codex_files, merge_codex, read_codex_file, read_thread_titles, CodexFileState, CodexRole};
use crate::adapters::fsutil::create_private_dir;
use crate::adapters::http::{SendError, Sender};
use crate::adapters::jsonl::{stat, FileId};
use crate::adapters::namer::{build_material, NameOutcome, Namer};
use crate::domain::{build_session, Millis, Session};

/// 使えない出力がこれだけ続いたら、それ以降は試さない
const MAX_NAME_ATTEMPTS: u8 = 2;
/// エラーに残す、拒否されたときの応答の error / path の長さ
const MAX_ERROR_FIELD_CHARS: usize = 200;

pub struct CollectOptions<'a> {
    pub claude_projects_dir: PathBuf,
    pub codex_dir: PathBuf,
    pub machine_name: String,
    pub gap_minutes: i64,
    pub now: Millis,
    pub naming: Option<(&'a dyn Namer, usize /*min_user_messages*/, usize /*max_per_run*/)>,
    pub chunk: ChunkLimits,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct CollectReport {
    pub bytes_read: u64,
    pub files_read: usize,
    pub sessions_changed: usize,
    pub sessions_sent: usize,
    pub chunks_failed: usize,
    pub names_assigned: usize,
    pub auth_failed: bool,
    pub errors: Vec<String>,
}

/// ログを前回の続きから読み、セッションを組み立て直し、名前を付け、
/// 送った内容から変わったセッションだけを小分けにして送る。
/// state（ファイルごとの途中結果）と ledger（名前と送った記録）は呼び出し側が load して渡し、
/// 終わったら save する
pub fn collect(opts: &CollectOptions, state: &mut State, ledger: &mut Ledger, sender: &dyn Sender) -> CollectReport {
    let mut report = CollectReport::default();
    report.errors.extend(state.load_error.take());
    report.errors.extend(ledger.load_error.take());
    let gap_ms = opts.gap_minutes.saturating_mul(60_000);

    read_new_lines(opts, state, &mut report);
    let built = build_sessions(opts, state, gap_ms);
    if let Some((namer, min_user_messages, max_per_run)) = opts.naming {
        let rule = NamingRule { min_user_messages, max_per_run, now: opts.now, gap_ms };
        name_sessions(namer, &rule, ledger, &built, &mut report);
    }
    forget_user_texts(state, ledger, opts.naming.is_some());
    send_changed(opts, ledger, &built, sender, &mut report);
    report
}

pub struct SaveOptions<'a> {
    /// state.json と sent.json を置くフォルダ（~/.ai-worklog）
    pub home: &'a Path,
    /// config の token_expires_on（YYYY-MM-DD）
    pub token_expires_on: Option<&'a str>,
    /// 1回でこれより多く読んだら、状態が消えた疑いとして警告する
    pub big_read_warn_bytes: u64,
}

/// state.json と sent.json を読み、collect し、何か変わったときだけ保存する。
/// 警告は report.errors に足す（collect.log に残る）
pub fn collect_and_save(opts: &CollectOptions, save: &SaveOptions, sender: &dyn Sender) -> CollectReport {
    let state_path = save.home.join("state.json");
    let ledger_path = save.home.join("sent.json");
    let mut st = state::load(&state_path);
    let mut led = ledger::load(&ledger_path);
    let state_reset = st.load_error.is_some();
    let load_failed = state_reset || led.load_error.is_some();
    // 読み込みエラーで空になったときは初めての回とみなさない（大量に読んだ警告を出す）
    let first_run = !state_reset && st.files.is_empty() && led.sessions.is_empty();
    let sessions_before = led.sessions.clone();

    let mut report = collect(opts, &mut st, &mut led, sender);

    if state_reset {
        report.errors.push("warning: file state was reset after a load error; all logs were read again".into());
    }
    if report.bytes_read > save.big_read_warn_bytes && !first_run {
        report.errors.push(format!("warning: read {} bytes in one run; state may have been reset", report.bytes_read));
    }
    // 期限の記録がなければ (true, _)。過ぎているか30日以内なら警告する
    if let (false, why) = check_expiry(save.token_expires_on, opts.now) {
        report.errors.push(format!("warning: {why}"));
    }
    // 何も読まず、送った記録も変わらず、読み込みエラーもなければ書かない
    if report.bytes_read == 0 && led.sessions == sessions_before && !load_failed {
        return report;
    }
    if let Err(e) = state::save(&state_path, &st) {
        report.errors.push(format!("cannot save state {}: {e}", state_path.display()));
    }
    if let Err(e) = ledger::save(&ledger_path, &led) {
        report.errors.push(format!("cannot save ledger {}: {e}", ledger_path.display()));
    }
    report
}

/// ~/.ai-worklog/collect.lock を try_lock する。取れなければ None
pub fn acquire_lock(home: &Path) -> io::Result<Option<File>> {
    create_private_dir(home)?;
    let file = OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(home.join("collect.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

enum Source {
    Claude { session_id: String, is_main: bool },
    Codex,
}

fn file_key(id: FileId) -> String {
    format!("{}:{}", id.dev, id.ino)
}

impl FileEntry {
    fn is_from(&self, source: &Source) -> bool {
        match (source, &self.claude, &self.codex) {
            (Source::Claude { session_id, is_main }, Some((id, main, _)), None) => id == session_id && main == is_main,
            (Source::Codex, None, Some(_)) => true,
            _ => false,
        }
    }

    fn reset(&mut self, source: &Source) {
        self.offset = 0;
        self.claude = None;
        self.codex = None;
        match source {
            Source::Claude { session_id, is_main } => {
                self.claude = Some((session_id.clone(), *is_main, ClaudeFileState::default()));
            }
            Source::Codex => self.codex = Some(CodexFileState::default()),
        }
    }

    /// offset から読む。読み終えるまで途中結果を書き換えない（読み損ねた行を二重に数えないため）
    fn read_more(&mut self, source: &Source) -> io::Result<u64> {
        match (source, &mut self.claude, &mut self.codex) {
            (Source::Claude { session_id, is_main }, Some((_, _, st)), _) => {
                let file = ClaudeFile { path: self.path.clone(), session_id: session_id.clone(), is_main: *is_main };
                let mut next = st.clone();
                let end = read_claude_file(&file, self.offset, &mut next)?;
                *st = next;
                Ok(end)
            }
            (Source::Codex, _, Some(st)) => {
                let mut next = st.clone();
                let end = read_codex_file(&self.path, self.offset, &mut next)?;
                *st = next;
                Ok(end)
            }
            _ => Ok(self.offset),
        }
    }

    /// user_texts を持つファイル（Claude と Codex の main）が属するセッションのキー
    fn main_session_key(&self) -> Option<String> {
        if let Some((id, true, _)) = &self.claude {
            return Some(format!("claude_code:{id}"));
        }
        let st = self.codex.as_ref()?;
        match (&st.role, &st.thread_id) {
            (Some(CodexRole::Main), Some(id)) => Some(format!("codex:{id}")),
            _ => None,
        }
    }
}

/// 全ファイルを列挙し、FileId で状態を引いて、増えた分だけ読む
fn read_new_lines(opts: &CollectOptions, state: &mut State, report: &mut CollectReport) {
    let mut listed: Vec<(PathBuf, Source)> = list_claude_files(&opts.claude_projects_dir)
        .into_iter()
        .map(|f| (f.path, Source::Claude { session_id: f.session_id, is_main: f.is_main }))
        .collect();
    listed.extend(list_codex_files(&opts.codex_dir).into_iter().map(|p| (p, Source::Codex)));

    // 前回の実行で各パスにあった FileId
    let previous: HashMap<PathBuf, String> = state.files.iter().map(|(k, e)| (e.path.clone(), k.clone())).collect();
    let mut present = HashSet::new();
    for (path, source) in listed {
        let st = match stat(&path) {
            Ok(st) => st,
            Err(e) => {
                // 一時的な失敗かもしれない。前回の途中結果は残し、今回は読まない
                report.errors.push(format!("cannot stat {}: {e}", path.display()));
                present.extend(previous.get(&path).cloned());
                continue;
            }
        };
        let key = file_key(st.id);
        // 同じパスが別の FileId になった：置き換えられたので古い途中結果を捨てる
        if let Some(old) = previous.get(&path).filter(|old| **old != key)
            && state.files.get(old).is_some_and(|e| e.path == path)
        {
            state.files.remove(old);
        }
        present.insert(key.clone());
        let entry = state.files.entry(key).or_default();
        // 同じ FileId で別のパス：rename（Codex のアーカイブなど）。続きから読む
        entry.path = path;
        if !entry.is_from(&source) || st.len < entry.offset {
            entry.reset(&source);
        }
        if st.len == entry.offset {
            continue;
        }
        let from = entry.offset;
        match entry.read_more(&source) {
            Ok(end) => {
                if end > from {
                    report.files_read += 1;
                    report.bytes_read += end - from;
                }
                entry.offset = end;
            }
            Err(e) => report.errors.push(format!("cannot read {}: {e}", entry.path.display())),
        }
    }
    // 消えたファイルの途中結果は、同じセッション（Codex は同じ親子の系統）の
    // ファイルが1つでも残っている間は、読まずに残してまとめに使う。
    // 捨てると小さくなったセッションを送り、クラウドの正しい記録を上書きしてしまう
    let groups = file_groups(&state.files);
    let live: HashSet<&String> = present.iter().filter_map(|k| groups.get(k)).collect();
    let keep: HashSet<String> =
        state.files.keys().filter(|k| present.contains(*k) || groups.get(*k).is_some_and(|g| live.contains(g))).cloned().collect();
    state.files.retain(|k, _| keep.contains(k));
}

/// ファイルのキー → そのファイルが属するまとまり。Claude は session_id、
/// Codex は親をたどれるところまでたどった系統（消えたファイルも含めてたどる）
fn file_groups(files: &BTreeMap<String, FileEntry>) -> HashMap<String, String> {
    let roles: HashMap<&str, &CodexRole> = files
        .values()
        .filter_map(|e| e.codex.as_ref())
        .filter_map(|st| Some((st.thread_id.as_deref()?, st.role.as_ref()?)))
        .collect();
    let family = |id: &str| {
        let mut cur = id;
        for _ in 0..32 {
            match roles.get(cur) {
                Some(CodexRole::Subagent { parent }) if roles.contains_key(parent.as_str()) => cur = parent,
                _ => break,
            }
        }
        format!("codex:{cur}")
    };
    files
        .iter()
        .map(|(k, e)| {
            let group = match (&e.claude, e.codex.as_ref().and_then(|st| st.thread_id.as_deref())) {
                (Some((id, _, _)), _) => format!("claude_code:{id}"),
                (None, Some(thread)) => family(thread),
                (None, None) => format!("file:{k}"),
            };
            (k.clone(), group)
        })
        .collect()
}

struct Built {
    key: String,
    session: Session,
    /// 名付けの材料。送らない
    user_texts: Vec<String>,
}

/// ファイルごとの途中結果をセッションごとにまとめ、ブロックを作る。started_at の順
fn build_sessions(opts: &CollectOptions, state: &State, gap_ms: i64) -> Vec<Built> {
    let mut out = Vec::new();

    // Claude：session_id ごとに main とサブエージェント
    type Group<'a> = (Option<(u64, &'a ClaudeFileState)>, Vec<&'a ClaudeFileState>);
    let mut claude: BTreeMap<&str, Group> = BTreeMap::new();
    for e in state.files.values() {
        let Some((id, is_main, st)) = &e.claude else { continue };
        let group = claude.entry(id.as_str()).or_default();
        if !is_main {
            group.1.push(st);
        } else if group.0.is_none_or(|(offset, _)| e.offset > offset) {
            group.0 = Some((e.offset, st));
        }
    }
    for (id, (main, subs)) in claude {
        let Some((_, main)) = main else { continue };
        let Some(session) = merge_claude(Some(main), &subs).and_then(|raw| build_session(raw, gap_ms)) else { continue };
        out.push(Built { key: format!("claude_code:{id}"), session, user_texts: main.user_texts.clone() });
    }

    // Codex：同じ thread_id のファイルが2つあれば（move でなく copy）、読み進んだ方だけ使う
    let mut threads: BTreeMap<&str, (u64, &CodexFileState)> = BTreeMap::new();
    for e in state.files.values() {
        let Some(st) = &e.codex else { continue };
        let Some(id) = st.thread_id.as_deref() else { continue };
        if threads.get(id).is_none_or(|(offset, _)| e.offset > *offset) {
            threads.insert(id, (e.offset, st));
        }
    }
    let files: Vec<&CodexFileState> = threads.values().map(|(_, st)| *st).collect();
    for raw in merge_codex(&files, &read_thread_titles(&opts.codex_dir)) {
        let user_texts = threads.get(raw.native_session_id.as_str()).map(|(_, st)| st.user_texts.clone()).unwrap_or_default();
        let key = format!("codex:{}", raw.native_session_id);
        let Some(session) = build_session(raw, gap_ms) else { continue };
        out.push(Built { key, session, user_texts });
    }

    out.sort_by(|a, b| a.session.started_at.cmp(&b.session.started_at).then_with(|| a.key.cmp(&b.key)));
    out
}

struct NamingRule {
    min_user_messages: usize,
    max_per_run: usize,
    now: Millis,
    gap_ms: i64,
}

/// 名前がなく、試した回数が上限未満で、材料が十分あるか止まっているセッションを、
/// 1回に max_per_run 件まで名付ける
fn name_sessions(namer: &dyn Namer, rule: &NamingRule, ledger: &mut Ledger, built: &[Built], report: &mut CollectReport) {
    let mut tried = 0;
    for b in built {
        if tried >= rule.max_per_run {
            break;
        }
        let entry = ledger.sessions.entry(b.key.clone()).or_default();
        if entry.title.is_some() || entry.name_attempts >= MAX_NAME_ATTEMPTS {
            continue;
        }
        let idle = rule.now - b.session.ended_at >= rule.gap_ms;
        if b.user_texts.len() < rule.min_user_messages && !idle {
            continue;
        }
        let material = build_material(b.session.source_title.as_deref(), &b.user_texts);
        if material.is_empty() {
            continue;
        }
        tried += 1;
        match namer.name(&material) {
            NameOutcome::Named(title) => {
                entry.name_attempts += 1;
                entry.title = Some(title);
                report.names_assigned += 1;
            }
            NameOutcome::Unusable => entry.name_attempts += 1,
            // claude 側の問題。回数に数えず、この回はもう試さない
            NameOutcome::Unavailable => break,
        }
    }
}

/// 名付けが済んだか、あきらめたセッションの材料を状態から消す。名付けをしないなら全部消す
fn forget_user_texts(state: &mut State, ledger: &Ledger, naming: bool) {
    let sessions = &ledger.sessions;
    let done = |key: &str| sessions.get(key).is_some_and(|s| s.title.is_some() || s.name_attempts >= MAX_NAME_ATTEMPTS);
    for e in state.files.values_mut() {
        if naming && !e.main_session_key().is_some_and(|k| done(&k)) {
            continue;
        }
        if let Some((_, _, st)) = &mut e.claude {
            st.user_texts.clear();
        }
        if let Some(st) = &mut e.codex {
            st.user_texts.clear();
        }
    }
}

/// 送った内容から変わったセッションを小分けにして送る。成功した小分けだけ送った印を付ける
fn send_changed(opts: &CollectOptions, ledger: &mut Ledger, built: &[Built], sender: &dyn Sender, report: &mut CollectReport) {
    let mut targets: Vec<Target> = Vec::new();
    for b in built {
        let entry = ledger.sessions.get(&b.key);
        let title = entry.and_then(|e| e.title.clone());
        let fp = session_fingerprint(&Outgoing { session: &b.session, title: title.as_deref() });
        if entry.and_then(|e| e.sent_fingerprint) == Some(fp) {
            continue;
        }
        report.sessions_changed += 1;
        // 送ったものより小さくなったら送らない（APIは送られた内容で置き換える）
        let (messages, tokens) = totals(&b.session);
        if entry.is_some_and(|e| messages < e.sent_messages || tokens < e.sent_tokens) {
            report.errors.push(format!("skipped shrinking session {}", b.key));
            continue;
        }
        targets.push((b, title, fp));
    }

    let blocks: Vec<usize> = targets.iter().map(|(b, _, _)| b.session.blocks.len()).collect();
    let send = |part: &[Target]| {
        let items: Vec<Outgoing> =
            part.iter().map(|(b, title, _)| Outgoing { session: &b.session, title: title.as_deref() }).collect();
        sender.send(&to_ingest_json(&opts.machine_name, &items))
    };
    let mut mark_sent = |part: &[Target], report: &mut CollectReport| {
        for (b, _, fp) in part {
            let entry = ledger.sessions.entry(b.key.clone()).or_default();
            entry.sent_fingerprint = Some(*fp);
            (entry.sent_messages, entry.sent_tokens) = totals(&b.session);
        }
        report.sessions_sent += part.len();
    };
    let auth_failed = |status: u16, report: &mut CollectReport| {
        report.auth_failed = true;
        report.errors.push(format!("authentication failed (HTTP {status}); stopped sending"));
    };
    'chunks: for range in chunk(&blocks, &opts.chunk) {
        let part = &targets[range];
        match send(part) {
            Ok(_) => mark_sent(part, report),
            Err(SendError::Auth(status)) => {
                auth_failed(status, report);
                break;
            }
            Err(SendError::Rejected { status, body }) => {
                report.chunks_failed += 1;
                if let [(b, _, _)] = part {
                    report.errors.push(rejected(&b.key, status, &body));
                    continue;
                }
                // どれか1つが拒否の原因。1つずつ送り直し、送れるものは送る
                for one in part.chunks(1) {
                    match send(one) {
                        Ok(_) => mark_sent(one, report),
                        Err(SendError::Auth(status)) => {
                            auth_failed(status, report);
                            break 'chunks;
                        }
                        Err(SendError::Rejected { status, body }) => report.errors.push(rejected(&one[0].0.key, status, &body)),
                        Err(e) => report.errors.push(describe(&e, 1)),
                    }
                }
            }
            Err(e) => {
                report.chunks_failed += 1;
                report.errors.push(describe(&e, part.len()));
            }
        }
    }
}

type Target<'a> = (&'a Built, Option<String>, u64);

/// 拒否された1セッションのエラー行。応答本文は、APIの error と path だけを残す
fn rejected(key: &str, status: u16, body: &str) -> String {
    let mut line = format!("rejected session {key}: {status}");
    line.push_str(&api_error_detail(body));
    line
}

/// 応答本文の JSON から error と path だけを取り出す（利用者のデータが混ざらないように）
fn api_error_detail(body: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else { return String::new() };
    let field = |name: &str| {
        v.get(name).and_then(|f| f.as_str()).map(|s| s.chars().take(MAX_ERROR_FIELD_CHARS).collect::<String>())
    };
    match (field("error"), field("path")) {
        (Some(e), Some(p)) => format!(" ({e} at {p})"),
        (Some(e), None) => format!(" ({e})"),
        _ => String::new(),
    }
}

/// (ブロックの message_count の合計, 4種のトークンの合計)
fn totals(s: &Session) -> (u64, u64) {
    let messages = s.blocks.iter().map(|b| u64::from(b.message_count)).sum();
    let t = s.tokens;
    (messages, t.input + t.output + t.cache_read + t.cache_write)
}

fn describe(e: &SendError, sessions: usize) -> String {
    let what = match e {
        SendError::Auth(status) => format!("authentication failed (HTTP {status})"),
        SendError::Rejected { status, body } => format!("rejected (HTTP {status}){}", api_error_detail(body)),
        SendError::Server(status) => format!("server error (HTTP {status})"),
        SendError::Network(msg) => format!("network error: {msg}"),
    };
    format!("chunk of {sessions} sessions not sent: {what}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::io::Write;

    use serde_json::Value;

    use crate::adapters::http::{SendError, SendOk};
    use crate::adapters::time::parse_ts;
    use crate::app::payload::{to_ingest_json, Outgoing, DEFAULT_CHUNK};
    use crate::app::scan::{scan, ScanOptions};
    use crate::app::ledger;
    use crate::app::state;

    const MACHINE: &str = "test-mac";

    fn ts(s: &str) -> Millis {
        parse_ts(s).unwrap()
    }

    /// 計画1のフィクスチャを一時フォルダに複製したもの。Drop で消す
    struct Env {
        root: PathBuf,
    }

    impl Env {
        fn new(test: &str) -> Env {
            let root = std::env::temp_dir().join(format!("aiwl-collect-{test}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures"), &root);
            Env { root }
        }
        fn claude(&self) -> PathBuf {
            self.root.join("claude/projects")
        }
        fn codex(&self) -> PathBuf {
            self.root.join("codex")
        }
        fn s1(&self) -> PathBuf {
            self.claude().join("-tmp-demo/s1.jsonl")
        }
        fn opts<'a>(&self, now: Millis, naming: Option<(&'a dyn Namer, usize, usize)>, chunk: ChunkLimits) -> CollectOptions<'a> {
            CollectOptions {
                claude_projects_dir: self.claude(),
                codex_dir: self.codex(),
                machine_name: MACHINE.into(),
                gap_minutes: 30,
                now,
                naming,
                chunk,
            }
        }
        fn plain(&self) -> CollectOptions<'static> {
            self.opts(ts("2026-11-22T00:00:00.000Z"), None, ChunkLimits { ..DEFAULT_CHUNK })
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap() {
            let e = e.unwrap();
            let target = to.join(e.file_name());
            if e.file_type().unwrap().is_dir() {
                copy_dir(&e.path(), &target);
            } else {
                std::fs::copy(e.path(), target).unwrap();
            }
        }
    }

    fn append(path: &Path, text: &str) {
        std::fs::OpenOptions::new().append(true).open(path).unwrap().write_all(text.as_bytes()).unwrap();
    }

    /// s1 の書きかけの最後の行を閉じ、本文のある user 行を足す
    fn append_user_line(path: &Path, at: &str, text: &str) {
        append(
            path,
            &format!("\n{{\"type\":\"user\",\"timestamp\":\"{at}\",\"sessionId\":\"s1\",\"message\":{{\"role\":\"user\",\"content\":\"{text}\"}}}}\n"),
        );
    }

    struct FakeSender {
        bodies: RefCell<Vec<String>>,
        script: RefCell<VecDeque<Result<SendOk, SendError>>>,
        /// この native_session_id を含む本文は、いつも 400 で拒否する
        reject_id: Option<String>,
    }

    impl FakeSender {
        fn ok() -> FakeSender {
            FakeSender::with(vec![])
        }
        /// 決めた結果を順に返す。尽きたら成功
        fn with(results: Vec<Result<SendOk, SendError>>) -> FakeSender {
            FakeSender { bodies: RefCell::new(vec![]), script: RefCell::new(results.into()), reject_id: None }
        }
        fn rejecting(id: &str) -> FakeSender {
            FakeSender { reject_id: Some(id.to_owned()), ..FakeSender::ok() }
        }
        fn calls(&self) -> usize {
            self.bodies.borrow().len()
        }
        fn sessions(&self, from_call: usize) -> Vec<Value> {
            self.bodies.borrow()[from_call..]
                .iter()
                .flat_map(|b| {
                    let v: Value = serde_json::from_str(b).unwrap();
                    assert_eq!(v["machine_name"], MACHINE);
                    v["sessions"].as_array().unwrap().clone()
                })
                .collect()
        }
        fn ids(&self, from_call: usize) -> Vec<String> {
            self.sessions(from_call).iter().map(|s| s["native_session_id"].as_str().unwrap().to_owned()).collect()
        }
    }

    impl Sender for FakeSender {
        fn send(&self, body: &str) -> Result<SendOk, SendError> {
            self.bodies.borrow_mut().push(body.to_owned());
            if let Some(id) = &self.reject_id
                && body.contains(&format!("\"native_session_id\":\"{id}\""))
            {
                let body = r#"{"error":"invalid_payload","path":"sessions[1].blocks[0].tokens.input","detail":"secret user text"}"#;
                return Err(SendError::Rejected { status: 400, body: body.into() });
            }
            self.script.borrow_mut().pop_front().unwrap_or(Ok(SendOk { sessions: 0, blocks: 0, rows_changed: 0 }))
        }
    }

    struct FakeNamer {
        outcome: NameOutcome,
        calls: Cell<usize>,
        materials: RefCell<Vec<String>>,
    }

    impl FakeNamer {
        /// Some なら名付け、None なら使えない出力
        fn new(name: Option<&str>) -> FakeNamer {
            FakeNamer::with(name.map_or(NameOutcome::Unusable, |n| NameOutcome::Named(n.to_owned())))
        }
        fn with(outcome: NameOutcome) -> FakeNamer {
            FakeNamer { outcome, calls: Cell::new(0), materials: RefCell::new(vec![]) }
        }
    }

    impl Namer for FakeNamer {
        fn name(&self, material: &str) -> NameOutcome {
            self.calls.set(self.calls.get() + 1);
            self.materials.borrow_mut().push(material.to_owned());
            self.outcome.clone()
        }
    }

    fn session<'a>(sessions: &'a [Value], id: &str) -> &'a Value {
        sessions.iter().find(|s| s["native_session_id"] == id).unwrap_or_else(|| panic!("{id} not sent"))
    }

    fn user_texts_of(state: &State, session_id: &str) -> Vec<String> {
        state
            .files
            .values()
            .filter_map(|e| e.claude.as_ref())
            .filter(|(id, is_main, _)| id == session_id && *is_main)
            .flat_map(|(_, _, st)| st.user_texts.clone())
            .collect()
    }

    #[test]
    fn first_run_sends_every_session() {
        let env = Env::new("first_run");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);

        let scanned = scan(&ScanOptions {
            claude_projects_dir: env.claude(),
            codex_dir: env.codex(),
            since_days: 36500,
            gap_minutes: 30,
            now: ts("2026-11-22T00:00:00.000Z"),
        });
        let items: Vec<Outgoing> = scanned.iter().map(|s| Outgoing { session: s, title: None }).collect();
        let want: Value = serde_json::from_str(&to_ingest_json(MACHINE, &items)).unwrap();
        assert_eq!(Value::Array(sender.sessions(0)), want["sessions"]);
        assert_eq!(sender.ids(0), ["s1", "c1", "s2"]);

        for body in sender.bodies.borrow().iter() {
            for secret in ["source_title", "デモ作業", "Codex task", "again"] {
                assert!(!body.contains(secret), "{secret} was sent");
            }
        }
        assert_eq!(report.files_read, 7);
        assert!(report.bytes_read > 0);
        assert_eq!((report.sessions_changed, report.sessions_sent, report.chunks_failed), (3, 3, 0));
        assert!(!report.auth_failed);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    #[test]
    fn second_run_reads_nothing_and_sends_nothing() {
        let env = Env::new("second_run");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();
        assert!(calls > 0);

        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(report.bytes_read, 0);
        assert_eq!(report.files_read, 0);
        assert_eq!(sender.calls(), calls);
        assert_eq!(report, CollectReport::default());
    }

    #[test]
    fn state_saved_and_loaded_resumes_without_resending() {
        let env = Env::new("round_trip");
        let path = env.root.join("home/state.json");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        state::save(&path, &st).unwrap();
        ledger::save(&path.with_file_name("sent.json"), &led).unwrap();
        let calls = sender.calls();

        let mut back = state::load(&path);
        let mut led_back = ledger::load(&path.with_file_name("sent.json"));
        assert_eq!(back.load_error, None);
        assert_eq!(led_back.load_error, None);
        assert_eq!(led_back.sessions, led.sessions);
        let report = collect(&env.plain(), &mut back, &mut led_back, &sender);
        assert_eq!(report.bytes_read, 0);
        assert_eq!(sender.calls(), calls);
        assert_eq!(report, CollectReport::default());
    }

    #[test]
    fn corrupt_state_is_reported_and_everything_is_sent_again() {
        let env = Env::new("corrupt_state");
        let path = env.root.join("home/state.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "garbage").unwrap();
        let sender = FakeSender::ok();
        let mut st = state::load(&path);
        let mut led = Ledger::default();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert_eq!(sender.ids(0), ["s1", "c1", "s2"]);
        assert_eq!(st.load_error, None);
    }

    #[test]
    fn lost_file_state_keeps_the_ledger_guard_and_titles() {
        let env = Env::new("lost_file_state");
        let home = env.root.join("home");
        let namer = FakeNamer::new(Some("デモの改修"));
        let opts = env.opts(ts("2026-11-22T00:00:00.000Z"), Some((&namer, 1, 10)), ChunkLimits { ..DEFAULT_CHUNK });
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&opts, &mut st, &mut led, &sender);
        state::save(&home.join("state.json"), &st).unwrap();
        ledger::save(&home.join("sent.json"), &led).unwrap();
        let calls = sender.calls();
        assert_eq!(namer.calls.get(), 3);

        // 途中結果のファイルだけが壊れ、サブエージェントのログも消えた
        std::fs::write(home.join("state.json"), "garbage").unwrap();
        std::fs::remove_file(env.claude().join("-tmp-demo/s1/subagents/agent-a1.jsonl")).unwrap();
        let mut st = state::load(&home.join("state.json"));
        let mut led = ledger::load(&home.join("sent.json"));
        assert!(st.load_error.is_some());
        assert_eq!(led.load_error, None);
        let report = collect(&opts, &mut st, &mut led, &sender);
        // 全部読み直すが、小さくなった s1 も、変わらない c1 / s2 も送らない
        assert_eq!(sender.calls(), calls, "{:?}", sender.ids(calls));
        assert_eq!(namer.calls.get(), 3);
        assert!(report.errors.iter().any(|e| e == "skipped shrinking session claude_code:s1"), "{:?}", report.errors);
        for key in ["claude_code:s1", "codex:c1", "claude_code:s2"] {
            assert_eq!(led.sessions[key].title.as_deref(), Some("デモの改修"), "{key}");
        }
    }

    #[test]
    fn appended_lines_resend_only_that_session() {
        let env = Env::new("appended");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();

        append_user_line(&env.s1(), "2026-11-20T03:05:00.000Z", "more");
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.ids(calls), ["s1"]);
        assert_eq!(report.files_read, 1);
        assert!(report.bytes_read > 0);
        assert_eq!((report.sessions_changed, report.sessions_sent), (1, 1));
        // 書きかけだった 03:00 の行と、足した 03:05 の行が入る
        assert_eq!(session(&sender.sessions(calls), "s1")["ended_at"], "2026-11-20T03:05:00.000Z");
    }

    #[test]
    fn failed_chunk_is_retried_next_run() {
        let env = Env::new("failed_chunk");
        let limits = || ChunkLimits { max_sessions: 2, max_blocks: 100 };
        let opts = env.opts(ts("2026-11-22T00:00:00.000Z"), None, limits());
        let sender = FakeSender::with(vec![Err(SendError::Server(500))]);
        let mut st = State::default();
        let mut led = Ledger::default();

        let first = collect(&opts, &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), 2); // [s1, c1] は失敗、[s2] は成功
        assert_eq!(first.chunks_failed, 1);
        assert_eq!((first.sessions_changed, first.sessions_sent), (3, 1));
        assert_eq!(first.errors.len(), 1);
        assert!(!first.auth_failed);
        assert_eq!(led.sessions.get("claude_code:s1").and_then(|s| s.sent_fingerprint), None);
        assert!(led.sessions["claude_code:s2"].sent_fingerprint.is_some());

        let second = collect(&opts, &mut st, &mut led, &sender);
        assert_eq!(sender.ids(2), ["s1", "c1"]);
        assert_eq!(second.chunks_failed, 0);
        assert_eq!(second.bytes_read, 0);
        assert_eq!((second.sessions_changed, second.sessions_sent), (2, 2));

        let third = collect(&opts, &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), 3);
        assert_eq!(third, CollectReport::default());
    }

    #[test]
    fn rejected_chunk_is_resent_one_session_at_a_time() {
        let env = Env::new("rejected_chunk");
        let sender = FakeSender::rejecting("c1");
        let mut st = State::default();
        let mut led = Ledger::default();
        // s1, c1, s2 が1つの小分けに入る
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), 4); // 3件まとめて拒否 → 1件ずつ3回
        assert_eq!(sender.ids(1), ["s1", "c1", "s2"]);
        assert_eq!((report.sessions_changed, report.sessions_sent, report.chunks_failed), (3, 2, 1));
        assert!(!report.auth_failed);
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].starts_with("rejected session codex:c1: 400"), "{:?}", report.errors);
        assert!(!report.errors[0].contains("secret user text"), "{:?}", report.errors);
        assert!(led.sessions["claude_code:s1"].sent_fingerprint.is_some());
        assert!(led.sessions["claude_code:s2"].sent_fingerprint.is_some());
        assert_eq!(led.sessions.get("codex:c1").and_then(|s| s.sent_fingerprint), None);

        // 次の回は c1 だけを送ろうとして、また拒否される
        let calls = sender.calls();
        let again = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.ids(calls), ["c1"]);
        assert_eq!((again.sessions_changed, again.sessions_sent), (1, 0));
        assert!(again.errors[0].starts_with("rejected session codex:c1: 400"), "{:?}", again.errors);
    }

    #[test]
    fn auth_failure_during_single_resends_stops_everything() {
        let env = Env::new("rejected_then_auth");
        let sender = FakeSender::with(vec![
            Err(SendError::Rejected { status: 400, body: "{}".into() }),
            Err(SendError::Auth(401)),
        ]);
        let mut st = State::default();
        let mut led = Ledger::default();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), 2);
        assert!(report.auth_failed);
        assert_eq!(report.sessions_sent, 0);
    }

    #[test]
    fn auth_failure_stops_sending_and_is_reported() {
        let env = Env::new("auth");
        let opts = env.opts(ts("2026-11-22T00:00:00.000Z"), None, ChunkLimits { max_sessions: 1, max_blocks: 100 });
        let sender = FakeSender::with(vec![Err(SendError::Auth(302))]);
        let mut st = State::default();
        let mut led = Ledger::default();
        let report = collect(&opts, &mut st, &mut led, &sender);
        assert!(report.auth_failed);
        assert_eq!(sender.calls(), 1);
        assert_eq!(report.sessions_sent, 0);
        assert_eq!(report.errors.len(), 1);
        assert!(report.errors[0].contains("302"), "{:?}", report.errors);
        assert!(led.sessions.values().all(|s| s.sent_fingerprint.is_none()));

        // 次の回は3つとも送る
        let again = collect(&opts, &mut st, &mut led, &sender);
        assert_eq!(sender.ids(1), ["s1", "c1", "s2"]);
        assert_eq!(again.sessions_sent, 3);
    }

    #[test]
    fn names_after_enough_user_messages() {
        let env = Env::new("names_enough");
        append_user_line(&env.s1(), "2026-11-20T03:10:00.000Z", "third");
        let namer = FakeNamer::new(Some("デモの改修"));
        // どのセッションも最後の活動から gap_minutes 経っていない時刻
        let now = ts("2026-11-20T03:11:00.000Z");
        let opts = env.opts(now, Some((&namer, 3, 5)), ChunkLimits { ..DEFAULT_CHUNK });
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();

        let report = collect(&opts, &mut st, &mut led, &sender);
        assert_eq!(namer.calls.get(), 1);
        assert_eq!(report.names_assigned, 1);
        let material = namer.materials.borrow()[0].clone();
        for text in ["デモ作業", "hi", "again", "third"] {
            assert!(material.contains(text), "{text} missing from {material}");
        }
        let sent = sender.sessions(0);
        assert_eq!(session(&sent, "s1")["title"], "デモの改修");
        assert_eq!(session(&sent, "s2")["title"], Value::Null);
        assert_eq!(led.sessions["claude_code:s1"].title.as_deref(), Some("デモの改修"));
        assert!(user_texts_of(&st, "s1").is_empty());
        assert_eq!(user_texts_of(&st, "s2"), ["x"]);
        for body in sender.bodies.borrow().iter() {
            assert!(!body.contains("third") && !body.contains("again"));
        }

        // 次の回は Namer を呼ばない。名前付けの後に足された発言も状態に残さない
        append_user_line(&env.s1(), "2026-11-20T03:12:00.000Z", "fourth");
        let calls = sender.calls();
        collect(&opts, &mut st, &mut led, &sender);
        assert_eq!(namer.calls.get(), 1);
        assert!(user_texts_of(&st, "s1").is_empty());
        assert_eq!(session(&sender.sessions(calls), "s1")["title"], "デモの改修");
    }

    #[test]
    fn names_idle_sessions_with_fewer_messages() {
        // s2 は材料が1件。最後の活動 (2026-11-21T00:00) から10分しか経っていなければ名付けない
        let env = Env::new("names_idle");
        let namer = FakeNamer::new(Some("別の作業"));
        let busy = env.opts(ts("2026-11-21T00:10:00.000Z"), Some((&namer, 3, 10)), ChunkLimits { ..DEFAULT_CHUNK });
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&busy, &mut st, &mut led, &FakeSender::ok());
        assert_eq!(led.sessions["claude_code:s2"].title, None);
        assert_eq!(led.sessions["claude_code:s2"].name_attempts, 0);
        assert_eq!(user_texts_of(&st, "s2"), ["x"]);

        // gap_minutes を過ぎたら名付ける
        let idle = env.opts(ts("2026-11-21T00:31:00.000Z"), Some((&namer, 3, 10)), ChunkLimits { ..DEFAULT_CHUNK });
        let sender = FakeSender::ok();
        collect(&idle, &mut st, &mut led, &sender);
        assert_eq!(led.sessions["claude_code:s2"].title.as_deref(), Some("別の作業"));
        assert_eq!(session(&sender.sessions(0), "s2")["title"], "別の作業");
        assert!(user_texts_of(&st, "s2").is_empty());
    }

    #[test]
    fn naming_is_capped_per_run_and_retried_twice() {
        let env = Env::new("naming_capped");
        let namer = FakeNamer::new(None);
        // 1件でも材料があれば名付けの対象。s1, c1, s2 の3セッション
        let opts = env.opts(ts("2026-11-22T00:00:00.000Z"), Some((&namer, 1, 1)), ChunkLimits { ..DEFAULT_CHUNK });
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();

        let first = collect(&opts, &mut st, &mut led, &sender);
        assert_eq!(namer.calls.get(), 1);
        assert_eq!(first.names_assigned, 0);
        // 名前がなくても送る
        assert_eq!(sender.ids(0), ["s1", "c1", "s2"]);
        assert!(sender.sessions(0).iter().all(|s| s["title"].is_null()));

        for run in 2..=6 {
            collect(&opts, &mut st, &mut led, &sender);
            assert_eq!(namer.calls.get(), run, "run {run}");
        }
        collect(&opts, &mut st, &mut led, &sender);
        collect(&opts, &mut st, &mut led, &sender);
        assert_eq!(namer.calls.get(), 6);
        for key in ["claude_code:s1", "codex:c1", "claude_code:s2"] {
            assert_eq!(led.sessions[key].name_attempts, 2, "{key}");
            assert_eq!(led.sessions[key].title, None, "{key}");
        }
        assert!(user_texts_of(&st, "s1").is_empty());
        assert!(user_texts_of(&st, "s2").is_empty());
        // 名前が付かないままなので、送り直さない
        assert_eq!(sender.calls(), 1);
    }

    #[test]
    fn unavailable_namer_does_not_use_attempts() {
        let env = Env::new("naming_unavailable");
        let namer = FakeNamer::with(NameOutcome::Unavailable);
        let opts = env.opts(ts("2026-11-22T00:00:00.000Z"), Some((&namer, 1, 10)), ChunkLimits { ..DEFAULT_CHUNK });
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();

        // 1回失敗したら、その回は残りを試さない
        for run in 1..=4 {
            let report = collect(&opts, &mut st, &mut led, &sender);
            assert_eq!(namer.calls.get(), run, "run {run}");
            assert_eq!(report.names_assigned, 0);
        }
        for key in ["claude_code:s1", "codex:c1", "claude_code:s2"] {
            assert_eq!(led.sessions.get(key).map_or(0, |s| s.name_attempts), 0, "{key}");
        }
        // 材料は次の回のために残す
        assert!(!user_texts_of(&st, "s1").is_empty());
        assert_eq!(user_texts_of(&st, "s2"), ["x"]);

        // claude が使えるようになったら名付ける
        let namer = FakeNamer::new(Some("デモの改修"));
        let opts = env.opts(ts("2026-11-22T00:00:00.000Z"), Some((&namer, 1, 10)), ChunkLimits { ..DEFAULT_CHUNK });
        let report = collect(&opts, &mut st, &mut led, &sender);
        assert_eq!(report.names_assigned, 3);
        assert!(user_texts_of(&st, "s1").is_empty());
    }

    #[test]
    fn truncated_file_is_read_again_from_start() {
        let env = Env::new("truncated");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();

        // 同じファイル（同じ inode）を短く書き直す
        let text = std::fs::read_to_string(env.s1()).unwrap();
        let short: String = text.lines().take(3).map(|l| format!("{l}\n")).collect();
        std::fs::write(env.s1(), &short).unwrap();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(report.bytes_read, short.len() as u64);
        // 送ったものより小さくなったので、送らずに知らせる
        assert_eq!(sender.calls(), calls);
        assert_eq!(report.errors, ["skipped shrinking session claude_code:s1"]);

        // 状態は、何も読んでいない状態から全部読んだときと同じ
        let mut fresh = State::default();
        collect(&env.plain(), &mut fresh, &mut Ledger::default(), &FakeSender::ok());
        assert_eq!(built(&env, &st, "claude_code:s1"), built(&env, &fresh, "claude_code:s1"));
    }

    fn built(env: &Env, st: &State, key: &str) -> Session {
        build_sessions(&env.plain(), st, 30 * 60_000).into_iter().find(|b| b.key == key).unwrap().session
    }

    #[test]
    fn vanished_subagent_file_does_not_shrink_session() {
        let env = Env::new("vanished_subagent");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();
        let before = built(&env, &st, "claude_code:s1");

        std::fs::remove_file(env.claude().join("-tmp-demo/s1/subagents/agent-a1.jsonl")).unwrap();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), calls);
        assert_eq!(report, CollectReport::default());
        assert!(st.files.values().any(|e| matches!(&e.claude, Some((id, false, _)) if id == "s1")));
        assert_eq!(built(&env, &st, "claude_code:s1"), before);
    }

    #[test]
    fn vanished_codex_child_does_not_shrink_family() {
        let env = Env::new("vanished_codex_child");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();
        let before = built(&env, &st, "codex:c1");

        std::fs::remove_file(env.codex().join("sessions/2026/11/20/rollout-b.jsonl")).unwrap();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), calls);
        assert_eq!(report, CollectReport::default());
        assert!(st.files.values().any(|e| e.codex.as_ref().is_some_and(|c| c.thread_id.as_deref() == Some("c2"))));
        assert_eq!(built(&env, &st, "codex:c1"), before);

        // 系統のファイルが全部消えたら、途中結果も捨てる
        std::fs::remove_file(env.codex().join("sessions/2026/11/20/rollout-a.jsonl")).unwrap();
        collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), calls);
        assert!(!st.files.values().any(|e| e.codex.as_ref().is_some_and(|c| c.thread_id.as_deref() == Some("c2"))));
    }

    #[test]
    fn vanished_codex_middle_and_root_do_not_shrink_family() {
        let env = Env::new("vanished_codex_root");
        let day = env.codex().join("sessions/2026/11/20");
        // c1 → c2 → g1 の孫。フィクスチャは書き換えず、一時フォルダにだけ足す
        std::fs::write(
            day.join("rollout-e.jsonl"),
            concat!(
                r#"{"timestamp":"2026-11-20T05:30:00.000Z","type":"session_meta","payload":{"id":"g1","cwd":"/tmp/proj","originator":"Codex Desktop","thread_source":"subagent","source":{"subagent":{"thread_spawn":{"parent_thread_id":"c2"}}}}}"#,
                "\n",
                r#"{"timestamp":"2026-11-20T05:31:00.000Z","type":"response_item","payload":{"type":"message","role":"user"}}"#,
                "\n",
                r#"{"timestamp":"2026-11-20T05:35:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":7,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":3}}}}"#,
                "\n",
            ),
        )
        .unwrap();
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();
        let before = built(&env, &st, "codex:c1");
        // 孫の分も c1 に入っている（input はキャッシュ分を除く：(1500 - 900) + 100 + 7）
        assert_eq!(before.tokens.input, 600 + 100 + 7);
        let has = |st: &State, id: &str| st.files.values().any(|e| e.codex.as_ref().is_some_and(|c| c.thread_id.as_deref() == Some(id)));

        // 間の子が消えた：孫から根までたどれるので、途中結果を残して何も送らない
        std::fs::remove_file(day.join("rollout-b.jsonl")).unwrap();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), calls, "{:?}", sender.ids(calls));
        assert_eq!(report, CollectReport::default());
        assert!(has(&st, "c2"));
        assert_eq!(built(&env, &st, "codex:c1"), before);

        // 根も消えた：孫が残っている間は、根と子の途中結果も残して何も送らない
        std::fs::remove_file(day.join("rollout-a.jsonl")).unwrap();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), calls, "{:?}", sender.ids(calls));
        assert_eq!(report, CollectReport::default());
        assert!(has(&st, "c1") && has(&st, "c2") && has(&st, "g1"));
        assert_eq!(built(&env, &st, "codex:c1"), before);
    }

    #[test]
    fn whole_session_removed_drops_its_entries() {
        let env = Env::new("whole_session_removed");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();

        std::fs::remove_file(env.claude().join("-tmp-demo/s2.jsonl")).unwrap();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), calls);
        assert_eq!(report, CollectReport::default());
        assert!(!st.files.values().any(|e| matches!(&e.claude, Some((id, _, _)) if id == "s2")));
        assert!(st.files.values().any(|e| matches!(&e.claude, Some((id, _, _)) if id == "s1")));
    }

    #[test]
    fn stat_failure_keeps_the_file_state() {
        let env = Env::new("stat_failure");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();

        // 一覧には出るが stat できない（リンク先がない）
        let s2 = env.claude().join("-tmp-demo/s2.jsonl");
        std::fs::remove_file(&s2).unwrap();
        std::os::unix::fs::symlink(env.root.join("missing.jsonl"), &s2).unwrap();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), calls);
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].contains("cannot stat"));
        assert!(st.files.values().any(|e| matches!(&e.claude, Some((id, _, _)) if id == "s2")));
    }

    #[test]
    fn shrinking_session_is_skipped_and_reported() {
        let env = Env::new("shrinking");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();

        // 送った記録の方が大きく、内容も違うことにする
        let entry = led.sessions.get_mut("claude_code:s1").unwrap();
        entry.sent_tokens += 1;
        entry.sent_fingerprint = Some(12345);
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), calls);
        assert_eq!(report.sessions_changed, 1);
        assert_eq!(report.sessions_sent, 0);
        assert_eq!(report.errors, ["skipped shrinking session claude_code:s1"]);
        assert_eq!(led.sessions["claude_code:s1"].sent_fingerprint, Some(12345));

        // 送った記録と同じ大きさなら送り、記録を更新する
        let s1 = built(&env, &st, "claude_code:s1");
        led.sessions.get_mut("claude_code:s1").unwrap().sent_tokens -= 1;
        collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.ids(calls), ["s1"]);
        let entry = &led.sessions["claude_code:s1"];
        assert_ne!(entry.sent_fingerprint, Some(12345));
        assert_eq!(entry.sent_messages, s1.blocks.iter().map(|b| u64::from(b.message_count)).sum::<u64>());
        assert_eq!(entry.sent_tokens, 14 + 8 + 100 + 20); // サブエージェント分を含む
    }

    #[test]
    fn replaced_file_drops_its_old_state() {
        let env = Env::new("replaced");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();
        let files = st.files.len();

        // 別の内容を書いた新しいファイルで置き換える（inode が変わる）
        let s2 = env.claude().join("-tmp-demo/s2.jsonl");
        let tmp = env.claude().join("-tmp-demo/s2.new");
        std::fs::write(
            &tmp,
            "{\"type\":\"user\",\"timestamp\":\"2026-11-21T05:00:00.000Z\",\"sessionId\":\"s2\",\"cwd\":\"/tmp/other\",\"message\":{\"role\":\"user\",\"content\":\"y\"}}\n",
        )
        .unwrap();
        std::fs::rename(&tmp, &s2).unwrap();
        collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(st.files.len(), files);
        let sent = sender.sessions(calls);
        assert_eq!(sender.ids(calls), ["s2"]);
        // 古い 00:00 の活動は残らない
        assert_eq!(session(&sent, "s2")["started_at"], "2026-11-21T05:00:00.000Z");
        assert_eq!(session(&sent, "s2")["blocks"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn archived_codex_file_is_not_double_counted() {
        let env = Env::new("archived");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();
        let files = st.files.len();

        let archived = env.codex().join("archived_sessions");
        std::fs::create_dir_all(&archived).unwrap();
        std::fs::rename(env.codex().join("sessions/2026/11/20/rollout-a.jsonl"), archived.join("rollout-a.jsonl")).unwrap();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(sender.calls(), calls);
        assert_eq!(report, CollectReport::default());
        assert_eq!(st.files.len(), files);
        assert!(st.files.values().any(|e| e.path == archived.join("rollout-a.jsonl")));
    }

    #[test]
    fn copied_codex_file_is_not_double_counted() {
        let env = Env::new("copied");
        let sender = FakeSender::ok();
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &sender);
        let calls = sender.calls();

        // move ではなく copy（inode が変わる）。元も残っている
        let archived = env.codex().join("archived_sessions");
        std::fs::create_dir_all(&archived).unwrap();
        std::fs::copy(env.codex().join("sessions/2026/11/20/rollout-a.jsonl"), archived.join("rollout-a.jsonl")).unwrap();
        let report = collect(&env.plain(), &mut st, &mut led, &sender);
        assert_eq!(report.files_read, 1);
        assert_eq!(sender.calls(), calls);
        assert_eq!(report.sessions_changed, 0);
    }

    fn mtime(p: &Path) -> std::time::SystemTime {
        std::fs::metadata(p).unwrap().modified().unwrap()
    }

    /// ファイルの更新時刻を昔に戻す
    fn age(p: &Path) {
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
        std::fs::File::options().write(true).open(p).unwrap().set_modified(old).unwrap();
    }

    fn save_opts(home: &Path) -> SaveOptions<'_> {
        SaveOptions { home, token_expires_on: None, big_read_warn_bytes: 500_000_000 }
    }

    #[test]
    fn saves_only_when_something_changed() {
        let env = Env::new("save_only_changed");
        let home = env.root.join("home");
        let (state_path, ledger_path) = (home.join("state.json"), home.join("sent.json"));
        let sender = FakeSender::ok();
        collect_and_save(&env.plain(), &save_opts(&home), &sender);
        assert!(state_path.is_file() && ledger_path.is_file());
        age(&state_path);
        age(&ledger_path);
        let (state_at, ledger_at) = (mtime(&state_path), mtime(&ledger_path));

        // 何も読まず、何も送らない回は書かない
        let report = collect_and_save(&env.plain(), &save_opts(&home), &sender);
        assert_eq!(report, CollectReport::default());
        assert_eq!(mtime(&state_path), state_at);
        assert_eq!(mtime(&ledger_path), ledger_at);

        // 読んだら書く
        append_user_line(&env.s1(), "2026-11-20T03:05:00.000Z", "more");
        collect_and_save(&env.plain(), &save_opts(&home), &sender);
        assert_ne!(mtime(&state_path), state_at);
        assert_ne!(mtime(&ledger_path), ledger_at);
    }

    #[test]
    fn warns_about_reset_state_and_big_reads() {
        let env = Env::new("warn_reset");
        let home = env.root.join("home");
        let warn_any = SaveOptions { home: &home, token_expires_on: None, big_read_warn_bytes: 1 };
        let sender = FakeSender::ok();
        let warnings = |r: &CollectReport| r.errors.iter().filter(|e| e.starts_with("warning:")).cloned().collect::<Vec<_>>();

        // 初めての回は、たくさん読んでも警告しない
        let first = collect_and_save(&env.plain(), &warn_any, &sender);
        assert!(first.bytes_read > 1);
        assert_eq!(warnings(&first), Vec::<String>::new());

        // state.json が壊れて読み直した：読み直したことと、たくさん読んだことの両方を警告する
        std::fs::write(home.join("state.json"), "garbage").unwrap();
        let reset = collect_and_save(&env.plain(), &warn_any, &sender);
        let w = warnings(&reset);
        assert_eq!(w.len(), 2, "{:?}", reset.errors);
        assert!(w[0].contains("state was reset"), "{w:?}");
        assert!(w[1].contains(&format!("read {} bytes", reset.bytes_read)), "{w:?}");

        // state.json が消えた（読み込みエラーなし）が、送った記録は残っている：初めての回ではない
        std::fs::remove_file(home.join("state.json")).unwrap();
        let gone = collect_and_save(&env.plain(), &warn_any, &sender);
        let w = warnings(&gone);
        assert_eq!(w.len(), 1, "{:?}", gone.errors);
        assert!(w[0].contains("bytes in one run"), "{w:?}");
    }

    #[test]
    fn warns_when_the_token_expires_soon() {
        let env = Env::new("warn_expiry");
        let home = env.root.join("home");
        let sender = FakeSender::ok();
        let opts = env.plain(); // now = 2026-11-22
        let run = |expires: Option<&str>| {
            let save = SaveOptions { home: &home, token_expires_on: expires, big_read_warn_bytes: u64::MAX };
            collect_and_save(&opts, &save, &sender).errors.into_iter().filter(|e| e.starts_with("warning:")).collect::<Vec<_>>()
        };
        assert_eq!(run(None), Vec::<String>::new());
        assert_eq!(run(Some("2027-06-01")), Vec::<String>::new());
        let soon = run(Some("2026-12-01"));
        assert_eq!(soon.len(), 1);
        assert!(soon[0].contains("2026-12-01"), "{soon:?}");
        let past = run(Some("2026-11-01"));
        assert_eq!(past.len(), 1);
        assert!(past[0].contains("expired"), "{past:?}");
    }

    #[test]
    fn second_run_exits_when_locked() {
        let env = Env::new("locked");
        let home = env.root.join("home");
        let first = acquire_lock(&home).unwrap();
        assert!(first.is_some());
        assert!(home.join("collect.lock").exists());
        assert!(acquire_lock(&home).unwrap().is_none());
        drop(first);
        assert!(acquire_lock(&home).unwrap().is_some());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&home).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn naming_disabled_keeps_no_user_texts() {
        let env = Env::new("naming_disabled");
        let mut st = State::default();
        let mut led = Ledger::default();
        collect(&env.plain(), &mut st, &mut led, &FakeSender::ok());
        assert!(user_texts_of(&st, "s1").is_empty());
        assert!(user_texts_of(&st, "s2").is_empty());
        assert!(
            st.files.values().filter_map(|e| e.codex.as_ref()).all(|c| c.user_texts.is_empty()),
            "codex user_texts kept"
        );
    }
}
