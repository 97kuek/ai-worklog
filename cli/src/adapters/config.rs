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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills_cwd: Option<PathBuf>,
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

/// An explicit home wins. An existing installation keeps its state directory
/// until the owner moves it to ~/.taskfolio.
pub fn home_override() -> Option<PathBuf> {
    ["TASKFOLIO_HOME", "AI_WORKLOG_HOME"].into_iter()
        .find_map(|key| std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from))
}

pub fn home_dir() -> PathBuf {
    home_override().unwrap_or_else(|| {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let current = home.join(".taskfolio");
        let legacy = home.join(".ai-worklog");
        if !current.exists() && legacy.is_dir() { legacy } else { current }
    })
}

pub fn is_default_claude_profile(dir: &Path) -> bool {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|home| home.join(".claude").canonicalize().ok())
        .is_some_and(|default| dir.canonicalize().ok().as_ref() == Some(&default))
}

pub fn api_endpoint(url: &str) -> Result<ureq::http::Uri, &'static str> {
    let uri = url.parse::<ureq::http::Uri>().map_err(|_| "invalid API URL")?;
    let authority = uri.authority().ok_or("API URL needs a host")?;
    if authority.host().is_empty() || authority.as_str().contains('@') || uri.query().is_some() || url.contains('#') {
        return Err("API URL may not contain credentials, a query or a fragment");
    }
    let loopback = matches!(authority.host(), "127.0.0.1" | "[::1]" | "localhost");
    if uri.scheme_str() != Some("https") && !(loopback && uri.scheme_str() == Some("http")) {
        return Err("remote API URLs require HTTPS");
    }
    Ok(uri)
}

pub fn load(path: &Path) -> Result<Config, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let config: Config = serde_json::from_str(&text).map_err(|e| format!("invalid config {}: {e}", path.display()))?;
    api_endpoint(&config.api_url)?;
    Ok(config)
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
    fn validates_endpoints_before_credentials_are_used() {
        for url in ["https://example.test", "https://example.test/service/", "http://[::1]:8888", "http://127.0.0.1"] {
            assert!(api_endpoint(url).is_ok(), "{url}");
        }
        for url in ["http://example.test", "https://user@example.test", "/relative", "https://example.test/?x", "https://example.test/#part"] {
            assert!(api_endpoint(url).is_err(), "{url}");
        }
    }

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
