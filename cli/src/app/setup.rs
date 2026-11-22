use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::adapters::config;
use crate::adapters::http::HttpSender;
use crate::adapters::keychain;
use crate::domain::Millis;

pub const LAUNCH_LABEL: &str = "dev.ai-worklog.collect";
const DAY_MS: i64 = 86_400_000;
const EXPIRY_WARN_DAYS: i64 = 30;

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// launchd のジョブ定義。10分ごとと、ログイン時に `ai-worklog collect` を動かす。
/// 報告は collect.log に残るので標準出力は捨て、標準エラーだけ launchd.log に残す
pub fn launch_agent_plist(exe: &Path, home: &Path) -> String {
    let exe = xml_escape(&exe.display().to_string());
    let log = xml_escape(&home.join("logs").join("launchd.log").display().to_string());
    let home_s = xml_escape(&home.display().to_string());
    // launchd の PATH は最小限なので、naming.command（claude）を見つけられるよう足す
    let user_home = std::env::var("HOME").unwrap_or_default();
    let path = xml_escape(&format!(
        "{user_home}/.local/bin:{user_home}/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    ));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>collect</string>
  </array>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AI_WORKLOG_HOME</key>
    <string>{home_s}</string>
    <key>PATH</key>
    <string>{path}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#
    )
}

fn session_end_snippet(exe: &Path, timeout: Option<u32>) -> String {
    let mut hook = serde_json::json!({
        "type": "command",
        "command": format!("{} hook", exe.display()),
    });
    if let Some(t) = timeout {
        hook["timeout"] = t.into();
    }
    let v = serde_json::json!({ "hooks": { "SessionEnd": [ { "hooks": [hook] } ] } });
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

/// ~/.claude/settings.json の "hooks" に足す内容
pub fn claude_hook_snippet(exe: &Path) -> String {
    session_end_snippet(exe, None)
}

/// ~/.codex/hooks.json に足す内容（https://developers.openai.com/codex/hooks の SessionEnd の形。timeout は秒で最大3）
pub fn codex_hook_snippet(exe: &Path) -> String {
    session_end_snippet(exe, Some(3))
}

pub struct DoctorItem {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

fn item(name: &'static str, ok: bool, detail: impl Into<String>) -> DoctorItem {
    DoctorItem { name, ok, detail: detail.into() }
}

/// launchctl の実行ファイル。テストでは AI_WORKLOG_LAUNCHCTL で差し替える
pub fn launchctl_cmd() -> String {
    std::env::var("AI_WORKLOG_LAUNCHCTL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "launchctl".into())
}

/// `id -u`
pub fn current_uid() -> Option<String> {
    let out = Command::new("id").arg("-u").stdin(Stdio::null()).output().ok()?;
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}

pub fn launch_agents_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/LaunchAgents")
}

pub fn doctor(home: &Path, claude_settings: &Path, codex_hooks: &Path, exe: &Path, now: Millis) -> Vec<DoctorItem> {
    // AI_WORKLOG_HOME を指定しているときは検証用の環境なので launchctl を呼ばない
    let use_launchctl = std::env::var_os("AI_WORKLOG_HOME").is_none_or(|v| v.is_empty());
    doctor_in(home, &launch_agents_dir(), claude_settings, codex_hooks, exe, now, use_launchctl)
}

pub fn doctor_in(
    home: &Path,
    agents_dir: &Path,
    claude_settings: &Path,
    codex_hooks: &Path,
    exe: &Path,
    now: Millis,
    use_launchctl: bool,
) -> Vec<DoctorItem> {
    let mut items = Vec::new();
    let cfg = config::load(&home.join("config.json"));
    items.push(match &cfg {
        Ok(c) => item("config", true, format!("{} ({})", c.api_url, c.machine_name)),
        Err(e) => item("config", false, format!("{e} (run `ai-worklog login`)")),
    });

    let secret = match &cfg {
        Ok(c) => keychain::read_secret(&c.client_id),
        Err(_) => Err("no config".to_string()),
    };
    items.push(match &secret {
        Ok(_) => item("keychain", true, format!("secret found (service {})", keychain::SERVICE)),
        Err(e) => item("keychain", false, e.clone()),
    });

    let plist = agents_dir.join(format!("{LAUNCH_LABEL}.plist"));
    items.push(if !plist.is_file() {
        item("launch agent", false, format!("{} not found (run `ai-worklog setup`)", plist.display()))
    } else if !use_launchctl {
        item("launch agent", true, format!("{} present (launchctl not checked)", plist.display()))
    } else {
        let loaded = current_uid().is_some_and(|uid| {
            Command::new(launchctl_cmd())
                .args(["print", &format!("gui/{uid}/{LAUNCH_LABEL}")])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        });
        if loaded {
            item("launch agent", true, "loaded")
        } else {
            item("launch agent", false, "plist exists but the job is not loaded (run `ai-worklog setup`)")
        }
    });

    items.push(hook_item("claude hook", claude_settings, exe));
    items.push(hook_item("codex hook", codex_hooks, exe));

    items.push(match &cfg {
        Ok(c) if !c.naming.enabled => item("naming command", true, "naming disabled"),
        Ok(c) => match find_on_path(&c.naming.command) {
            Some(p) => item("naming command", true, p.display().to_string()),
            None => item("naming command", false, format!("`{}` not found on PATH", c.naming.command)),
        },
        Err(_) => item("naming command", false, "no config"),
    });

    items.push(match &cfg {
        Ok(c) => {
            let (ok, detail) = check_expiry(c.token_expires_on.as_deref(), now);
            item("token expiry", ok, detail)
        }
        Err(_) => item("token expiry", false, "no config"),
    });

    items.push(match (&cfg, &secret) {
        (Ok(c), Ok(secret)) => {
            let sender = HttpSender {
                url: c.api_url.clone(),
                client_id: c.client_id.clone(),
                client_secret: secret.clone(),
                timeout: std::time::Duration::from_secs(10),
            };
            match sender.check_me() {
                Ok(kind) if kind == "machine" => item("api", true, "GET /api/me -> machine"),
                Ok(kind) => item("api", false, format!("GET /api/me returned kind `{kind}`, expected `machine`")),
                Err(e) => item("api", false, format!("GET /api/me failed: {e:?}")),
            }
        }
        _ => item("api", false, "skipped (needs config and keychain secret)"),
    });
    items
}

fn hook_item(name: &'static str, file: &Path, exe: &Path) -> DoctorItem {
    let want = format!("{} hook", exe.display());
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => return item(name, false, format!("cannot read {}: {e}", file.display())),
    };
    let found = serde_json::from_str::<serde_json::Value>(&text).ok().is_some_and(|v| {
        v["hooks"]["SessionEnd"].as_array().is_some_and(|groups| {
            groups.iter().any(|g| {
                g["hooks"].as_array().is_some_and(|hs| hs.iter().any(|h| h["command"].as_str() == Some(want.as_str())))
            })
        })
    });
    if found {
        item(name, true, format!("SessionEnd -> {want}"))
    } else {
        item(name, false, format!("no SessionEnd hook `{want}` in {}", file.display()))
    }
}

fn find_on_path(cmd: &str) -> Option<PathBuf> {
    if cmd.contains('/') {
        let p = PathBuf::from(cmd);
        return p.is_file().then_some(p);
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(cmd)).find(|p| p.is_file())
}

/// 期限が無ければ OK。過ぎている、または30日以内なら NG（警告）
pub fn check_expiry(expires: Option<&str>, now: Millis) -> (bool, String) {
    let Some(s) = expires else {
        return (true, "no expiry recorded".into());
    };
    let valid = s.len() == 10 && s.parse::<jiff::civil::Date>().is_ok();
    let end = valid
        .then(|| format!("{s}T00:00:00Z").parse::<jiff::Timestamp>().ok())
        .flatten()
        .map(|t| t.as_millisecond() + DAY_MS);
    let Some(end) = end else {
        return (false, format!("cannot parse token_expires_on `{s}` (expected YYYY-MM-DD)"));
    };
    let days = (end - now).div_euclid(DAY_MS);
    if end <= now {
        (false, format!("token expired on {s}"))
    } else if days <= EXPIRY_WARN_DAYS {
        (false, format!("token expires on {s} ({days} days left): renew it soon"))
    } else {
        (true, format!("expires on {s} ({days} days left)"))
    }
}

/// 1行を追記する。上限を超えたら新しい側の半分だけ残す
pub fn append_log_line(path: &Path, line: &str, max_bytes: u64) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        crate::adapters::fsutil::create_private_dir(parent)?;
    }
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(format!("{line}\n").as_bytes())?;
    drop(f);
    if std::fs::metadata(path)?.len() > max_bytes {
        let data = std::fs::read(path)?;
        let mut start = data.len() / 2;
        // 行の途中から始めないよう、次の改行の後ろまで進める
        match data[start..].iter().position(|&b| b == b'\n') {
            Some(i) => start += i + 1,
            None => start = data.len(),
        }
        let mut tmp = path.as_os_str().to_os_string();
        tmp.push(format!(".tmp{}", std::process::id()));
        let tmp = PathBuf::from(tmp);
        std::fs::write(&tmp, &data[start..])?;
        std::fs::rename(&tmp, path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aiw-setup-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn plist_runs_collect_every_ten_minutes() {
        let p = launch_agent_plist(Path::new("/opt/bin/ai-worklog"), Path::new("/Users/x/.ai-worklog"));
        for needle in [
            "<string>/opt/bin/ai-worklog</string>",
            "<string>collect</string>",
            "<integer>600</integer>",
            "RunAtLoad",
            "<key>ProcessType</key>",
            "<string>Background</string>",
            "LowPriorityIO",
            "<string>dev.ai-worklog.collect</string>",
            // 報告は collect.log に残るので、標準出力は捨てる。標準エラーだけ launchd.log へ
            "<key>StandardOutPath</key>\n  <string>/dev/null</string>",
            "<key>StandardErrorPath</key>\n  <string>/Users/x/.ai-worklog/logs/launchd.log</string>",
        ] {
            assert!(p.contains(needle), "missing {needle}: {p}");
        }
        assert!(p.starts_with("<?xml"));
        assert!(p.trim_end().ends_with("</plist>"));
        // タグの開き閉じが釣り合っている
        for tag in ["dict", "array"] {
            assert_eq!(p.matches(&format!("<{tag}>")).count(), p.matches(&format!("</{tag}>")).count(), "{tag}");
        }
    }

    #[test]
    fn plist_escapes_xml_in_paths() {
        let p = launch_agent_plist(Path::new("/a&b/<x>/ai-worklog"), Path::new("/h"));
        assert!(p.contains("/a&amp;b/&lt;x&gt;/ai-worklog"), "{p}");
    }

    #[test]
    fn claude_snippet_is_session_end_hook() {
        let s = claude_hook_snippet(Path::new("/opt/bin/ai-worklog"));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["hooks"]["SessionEnd"][0]["hooks"][0]["type"], "command");
        assert_eq!(v["hooks"]["SessionEnd"][0]["hooks"][0]["command"], "/opt/bin/ai-worklog hook");
    }

    #[test]
    fn codex_snippet_is_session_end_hook() {
        let s = codex_hook_snippet(Path::new("/opt/bin/ai-worklog"));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["hooks"]["SessionEnd"][0]["hooks"][0]["command"], "/opt/bin/ai-worklog hook");
    }

    #[test]
    fn doctor_reports_missing_pieces() {
        let d = temp("doctor-missing");
        let items = doctor_in(&d, &d.join("LaunchAgents"), &d.join("settings.json"), &d.join("hooks.json"), Path::new("/opt/bin/ai-worklog"), 0, false);
        let names: Vec<&str> = items.iter().map(|i| i.name).collect();
        assert_eq!(
            names,
            ["config", "keychain", "launch agent", "claude hook", "codex hook", "naming command", "token expiry", "api"]
        );
        for n in ["config", "keychain", "launch agent", "claude hook", "codex hook", "api"] {
            let it = items.iter().find(|i| i.name == n).unwrap();
            assert!(!it.ok, "{n} should be NG: {}", it.detail);
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn doctor_detects_registered_hooks_and_plist() {
        let d = temp("doctor-ok");
        let exe = Path::new("/opt/bin/ai-worklog");
        std::fs::write(d.join("settings.json"), claude_hook_snippet(exe)).unwrap();
        std::fs::write(d.join("hooks.json"), codex_hook_snippet(exe)).unwrap();
        std::fs::create_dir_all(d.join("LA")).unwrap();
        std::fs::write(d.join("LA").join(format!("{LAUNCH_LABEL}.plist")), "x").unwrap();
        let items = doctor_in(&d, &d.join("LA"), &d.join("settings.json"), &d.join("hooks.json"), exe, 0, false);
        for n in ["launch agent", "claude hook", "codex hook"] {
            assert!(items.iter().find(|i| i.name == n).unwrap().ok, "{n}");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn expiry_warns_within_thirty_days_or_past() {
        let day = 86_400_000;
        let now = 1_800_000_000_000; // 2027-01-15 08:00 UTC
        let (ok, _) = check_expiry(None, now);
        assert!(ok);
        let (ok, _) = check_expiry(Some("2027-12-31"), now);
        assert!(ok);
        let (ok, d) = check_expiry(Some("2027-02-01"), now);
        assert!(!ok, "{d}");
        let (ok, d) = check_expiry(Some("2027-01-01"), now);
        assert!(!ok, "{d}");
        let (ok, _) = check_expiry(Some("garbage"), now);
        assert!(!ok);
        let _ = day;
    }

    #[test]
    fn log_append_keeps_newer_half_when_over_limit() {
        let d = temp("log");
        let path = d.join("logs").join("collect.log");
        append_log_line(&path, "first", 100).unwrap();
        for i in 0..30 {
            append_log_line(&path, &format!("line-{i:02}"), 100).unwrap();
        }
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.len() <= 100 + 10, "{}", text.len());
        assert!(text.ends_with("line-29\n"));
        assert!(!text.contains("first"));
        assert!(text.lines().all(|l| l == "first" || l.starts_with("line-")), "{text}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
