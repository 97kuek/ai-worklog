use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::adapters::claude::ClaudeFileState;
use crate::adapters::codex::CodexFileState;

pub const STATE_VERSION: u32 = 1;

/// collect が続きから読むための状態。~/.ai-worklog/state.json に保存する
#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub version: u32,
    /// キーは "dev:ino"
    pub files: BTreeMap<String, FileEntry>,
    /// キーは "claude_code:<id>" / "codex:<root id>"
    pub sessions: BTreeMap<String, SessionEntry>,
    /// load で見つかった問題。collect が report.errors へ移す。保存しない
    #[serde(skip)]
    pub load_error: Option<String>,
}

impl Default for State {
    fn default() -> Self {
        State { version: STATE_VERSION, files: BTreeMap::new(), sessions: BTreeMap::new(), load_error: None }
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
/// （全部読み直して送り直す。APIは同じ内容なら書かない）
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

/// 一時ファイルに書いてから rename する
pub fn save(path: &Path, s: &State) -> std::io::Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(format!(".tmp{}", std::process::id()));
    let tmp = path.with_file_name(tmp_name);
    let json = serde_json::to_vec(s).map_err(std::io::Error::other)?;
    let written = std::fs::File::create(&tmp).and_then(|mut f| {
        std::io::Write::write_all(&mut f, &json)?;
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
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
        assert!(s.files.is_empty() && s.sessions.is_empty());
        assert_eq!(s.load_error, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_state_file_is_reported_and_empty() {
        let dir = temp_dir("corrupt");
        let path = dir.join("state.json");
        std::fs::write(&path, "{not json").unwrap();
        let s = load(&path);
        assert!(s.files.is_empty() && s.sessions.is_empty());
        assert!(s.load_error.as_deref().is_some_and(|e| e.contains("state")), "{:?}", s.load_error);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_state_version_is_reported_and_empty() {
        let dir = temp_dir("version");
        let path = dir.join("state.json");
        std::fs::write(&path, r#"{"version":99,"sessions":{"claude_code:x":{"name_attempts":1}}}"#).unwrap();
        let s = load(&path);
        assert!(s.sessions.is_empty());
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
        s.sessions.insert(
            "claude_code:a".into(),
            SessionEntry { title: Some("作業".into()), name_attempts: 1, sent_fingerprint: Some(u64::MAX), sent_messages: 9, sent_tokens: 1234 },
        );
        save(&path, &s).unwrap();
        let back = load(&path);
        assert_eq!(back.load_error, None);
        assert_eq!(back.files["1:2"].offset, 42);
        assert_eq!(back.files["1:2"].path, PathBuf::from("/x/a.jsonl"));
        assert_eq!(back.sessions["claude_code:a"], s.sessions["claude_code:a"]);
        // 一時ファイルが残らない
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("state.json")]);

        // 後から足したフィールドがない古い状態ファイルも読める
        std::fs::write(&path, r#"{"version":1,"files":{"3:4":{"path":"/y","offset":7}},"sessions":{"codex:c":{}}}"#).unwrap();
        let old = load(&path);
        assert_eq!(old.load_error, None);
        assert_eq!(old.files["3:4"].offset, 7);
        assert_eq!(old.sessions["codex:c"], SessionEntry::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
