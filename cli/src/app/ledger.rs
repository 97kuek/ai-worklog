use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::adapters::fsutil::write_atomically;

pub const LEDGER_VERSION: u32 = 1;

/// セッションごとに、付けた名前と最後に送った内容の記録。~/.ai-worklog/sent.json に保存する。
/// state.json（ファイルごとの途中結果）とは別にして、そちらが壊れて読み直しても
/// 「送ったものより小さくしない」守りと名前が残るようにする
#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Ledger {
    pub version: u32,
    /// キーは "claude_code:<id>" / "codex:<root id>"
    pub sessions: BTreeMap<String, SessionEntry>,
    /// load で見つかった問題。collect が report.errors へ移す。保存しない
    #[serde(skip)]
    pub load_error: Option<String>,
}

impl Default for Ledger {
    fn default() -> Self {
        Ledger { version: LEDGER_VERSION, sessions: BTreeMap::new(), load_error: None }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionEntry {
    pub title: Option<String>,
    pub name_attempts: u8,
    pub sent_fingerprint: Option<u64>,
    /// 最後に送ったときのブロックの message_count の合計
    pub sent_messages: u64,
    /// 最後に送ったときの input + output + cache_read + cache_write
    pub sent_tokens: u64,
}

/// なければ空。読めない・壊れている・版が違うときは load_error に理由を残して空
pub fn load(path: &Path) -> Ledger {
    let empty = |why: String| Ledger { load_error: Some(format!("{why}; starting from an empty ledger")), ..Ledger::default() };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ledger::default(),
        Err(e) => return empty(format!("cannot read ledger {}: {e}", path.display())),
    };
    match serde_json::from_str::<Ledger>(&text) {
        Ok(l) if l.version == LEDGER_VERSION => l,
        Ok(l) => empty(format!("unsupported ledger version {} in {}", l.version, path.display())),
        Err(e) => empty(format!("invalid ledger {}: {e}", path.display())),
    }
}

/// 一時ファイルに書いて fsync してから rename する
pub fn save(path: &Path, l: &Ledger) -> std::io::Result<()> {
    let json = serde_json::to_vec(l).map_err(std::io::Error::other)?;
    write_atomically(path, &json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(test: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aiwl-ledger-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_ledger_is_empty_without_error() {
        let dir = temp_dir("missing");
        let l = load(&dir.join("sent.json"));
        assert_eq!(l.version, LEDGER_VERSION);
        assert!(l.sessions.is_empty());
        assert_eq!(l.load_error, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_or_unknown_version_is_reported_and_empty() {
        let dir = temp_dir("corrupt");
        let path = dir.join("sent.json");
        std::fs::write(&path, "{not json").unwrap();
        let l = load(&path);
        assert!(l.sessions.is_empty());
        assert!(l.load_error.as_deref().is_some_and(|e| e.contains("ledger")), "{:?}", l.load_error);
        std::fs::write(&path, r#"{"version":99,"sessions":{"claude_code:x":{"name_attempts":1}}}"#).unwrap();
        let l = load(&path);
        assert!(l.sessions.is_empty());
        assert!(l.load_error.as_deref().is_some_and(|e| e.contains("99")), "{:?}", l.load_error);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips_and_tolerates_missing_fields() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("nested").join("sent.json");
        let mut l = Ledger::default();
        l.sessions.insert(
            "claude_code:a".into(),
            SessionEntry { title: Some("作業".into()), name_attempts: 1, sent_fingerprint: Some(u64::MAX), sent_messages: 9, sent_tokens: 1234 },
        );
        save(&path, &l).unwrap();
        let back = load(&path);
        assert_eq!(back.load_error, None);
        assert_eq!(back.sessions, l.sessions);
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("sent.json")]);

        std::fs::write(&path, r#"{"version":1,"sessions":{"codex:c":{}}}"#).unwrap();
        assert_eq!(load(&path).sessions["codex:c"], SessionEntry::default());
        std::fs::write(&path, r#"{}"#).unwrap();
        let empty = load(&path);
        assert_eq!(empty.load_error, None);
        assert!(empty.sessions.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
