use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::adapters::claude::ClaudeFileState;
use crate::adapters::codex::CodexFileState;
use crate::adapters::fsutil::write_atomically;

pub const STATE_VERSION: u32 = 1;

/// collect が続きから読むための、ファイルごとの途中結果。~/.ai-worklog/state.json に保存する。
/// 名前と送った記録は ledger（sent.json）にある
#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub version: u32,
    /// キーは "dev:ino"
    pub files: BTreeMap<String, FileEntry>,
    /// load で見つかった問題。collect が report.errors へ移す。保存しない
    #[serde(skip)]
    pub load_error: Option<String>,
}

impl Default for State {
    fn default() -> Self {
        State { version: STATE_VERSION, files: BTreeMap::new(), load_error: None }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FileEntry {
    pub path: PathBuf,
    pub offset: u64,
    pub claude: Option<(String /*session_id*/, bool /*is_main*/, ClaudeFileState)>,
    pub codex: Option<CodexFileState>,
}

/// なければ空。読めない・壊れている・版が違うときは load_error に理由を残して空
/// （全部読み直す。送った記録は ledger に残っているので、変わっていなければ送らない）
pub fn load(path: &Path) -> State {
    let empty = |why: String| State { load_error: Some(format!("{why}; starting from an empty state")), ..State::default() };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return State::default(),
        Err(e) => return empty(format!("cannot read state {}: {e}", path.display())),
    };
    match serde_json::from_str::<State>(&text) {
        Ok(s) if s.version == STATE_VERSION => s,
        Ok(s) => empty(format!("unsupported state version {} in {}", s.version, path.display())),
        Err(e) => empty(format!("invalid state {}: {e}", path.display())),
    }
}

/// 一時ファイルに書いて fsync してから rename する
pub fn save(path: &Path, s: &State) -> std::io::Result<()> {
    let json = serde_json::to_vec(s).map_err(std::io::Error::other)?;
    write_atomically(path, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(test: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aiwl-state-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_state_file_is_empty_without_error() {
        let dir = temp_dir("missing");
        let s = load(&dir.join("state.json"));
        assert_eq!(s.version, STATE_VERSION);
        assert!(s.files.is_empty());
        assert_eq!(s.load_error, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_state_file_is_reported_and_empty() {
        let dir = temp_dir("corrupt");
        let path = dir.join("state.json");
        std::fs::write(&path, "{not json").unwrap();
        let s = load(&path);
        assert!(s.files.is_empty());
        assert!(s.load_error.as_deref().is_some_and(|e| e.contains("state")), "{:?}", s.load_error);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_state_version_is_reported_and_empty() {
        let dir = temp_dir("version");
        let path = dir.join("state.json");
        std::fs::write(&path, r#"{"version":99,"files":{"3:4":{"path":"/y","offset":7}}}"#).unwrap();
        let s = load(&path);
        assert!(s.files.is_empty());
        assert!(s.load_error.as_deref().is_some_and(|e| e.contains("99")), "{:?}", s.load_error);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips_and_tolerates_missing_fields() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("nested").join("state.json");
        let mut s = State::default();
        s.files.insert(
            "1:2".into(),
            FileEntry { path: "/x/a.jsonl".into(), offset: 42, claude: Some(("a".into(), true, Default::default())), codex: None },
        );
        save(&path, &s).unwrap();
        let back = load(&path);
        assert_eq!(back.load_error, None);
        assert_eq!(back.files["1:2"].offset, 42);
        assert_eq!(back.files["1:2"].path, PathBuf::from("/x/a.jsonl"));
        // 一時ファイルが残らない
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("state.json")]);

        // 後から足したフィールドがない古い状態ファイルも読める
        std::fs::write(&path, r#"{"version":1,"files":{"3:4":{"path":"/y","offset":7}}}"#).unwrap();
        let old = load(&path);
        assert_eq!(old.load_error, None);
        assert_eq!(old.files["3:4"].offset, 7);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
