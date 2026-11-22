use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub api_url: String,
    pub machine_name: String,
    pub client_id: String,
    #[serde(default)]
    pub token_expires_on: Option<String>,
    #[serde(default)]
    pub naming: NamingConfig,
    #[serde(default = "default_gap")]
    pub gap_minutes: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct NamingConfig {
    pub enabled: bool,
    pub command: String,
    pub model: String,
    pub min_user_messages: usize,
    pub max_per_run: usize,
}

fn default_gap() -> i64 {
    30
}

impl Default for NamingConfig {
    fn default() -> Self {
        NamingConfig {
            enabled: true,
            command: "claude".into(),
            model: "haiku".into(),
            min_user_messages: 3,
            max_per_run: 20,
        }
    }
}

/// `$AI_WORKLOG_HOME` if set, else `$HOME/.ai-worklog`.
pub fn home_dir() -> PathBuf {
    if let Some(h) = std::env::var_os("AI_WORKLOG_HOME")
        && !h.is_empty()
    {
        return PathBuf::from(h);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join(".ai-worklog")
}

pub fn load(path: &Path) -> Result<Config, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("invalid config {}: {e}", path.display()))
}

/// Writes a temp file next to the target, then renames it into place (mode 0600).
pub fn save(path: &Path, c: &Config) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(c).map_err(std::io::Error::other)?;
    super::fsutil::write_atomically(path, (json + "\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_fills_defaults() {
        let dir = std::env::temp_dir().join(format!("aiw-cfg-{}", std::process::id()));
        let path = dir.join("sub").join("config.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"api_url":"https://x.workers.dev","machine_name":"mac","client_id":"abc.access"}"#,
        )
        .unwrap();
        let c = load(&path).unwrap();
        assert_eq!(c.gap_minutes, 30);
        assert_eq!(c.token_expires_on, None);
        assert_eq!(
            c.naming,
            NamingConfig {
                enabled: true,
                command: "claude".into(),
                model: "haiku".into(),
                min_user_messages: 3,
                max_per_run: 20
            }
        );
        let p2 = dir.join("new").join("c.json");
        save(&p2, &c).unwrap();
        assert_eq!(load(&p2).unwrap(), c);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&p2).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
