use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::adapters::config;
use crate::adapters::http::HttpSender;
use crate::adapters::keychain;
use crate::domain::{Millis, Tool};

pub const LAUNCH_LABEL: &str = "dev.taskfolio.collect";
const DAY_MS: i64 = 86_400_000;
const EXPIRY_WARN_DAYS: i64 = 30;

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// launchd のジョブ定義。状態通知、10分ごと、ログイン時に `taskfolio collect` を動かす。
/// 報告は collect.log に残るので標準出力は捨て、標準エラーだけ launchd.log に残す
pub fn launch_agent_plist(exe: &Path, home: &Path) -> String {
    let exe = xml_escape(&exe.display().to_string());
    let log = xml_escape(&home.join("logs").join("launchd.log").display().to_string());
    let home_s = xml_escape(&home.display().to_string());
    let queue = xml_escape(&crate::adapters::status_hook::collect_queue(home).display().to_string());
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
  <key>QueueDirectories</key>
  <array>
    <string>{queue}</string>
  </array>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TASKFOLIO_HOME</key>
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

fn hooks_config(exe: &Path, tool: Tool) -> serde_json::Value {
    use serde_json::json;
    let path = exe.to_string_lossy();
    let command = if path.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b)) {
        path.into_owned()
    } else {
        format!("'{}'", path.replace('\'', "'\\''"))
    };
    let (name, tool_events): (&str, &[&str]) = match tool {
        Tool::ClaudeCode => ("claude", &["Notification", "PostToolBatch", "StopFailure"]),
        Tool::Codex => ("codex", &["PermissionRequest", "PreModelRequest", "Interrupt"]),
    };
    let mut hooks = serde_json::Map::new();
    let mut collect = json!({ "type": "command", "command": format!("{command} hook") });
    if tool == Tool::Codex { collect["timeout"] = 3.into(); }
    hooks.insert("SessionEnd".into(), json!([{ "hooks": [collect] }]));
    let status = json!({"type": "command", "command": format!("{command} hook-status {name}"), "timeout": 3});
    for event in ["UserPromptSubmit", "Stop"].iter().chain(tool_events) {
        let mut group = json!({ "hooks": [&status] });
        if *event == "Notification" { group["matcher"] = "permission_prompt".into(); }
        hooks.insert((*event).into(), json!([group]));
    }
    json!({ "hooks": hooks })
}

pub fn claude_hook_snippet(exe: &Path) -> String {
    serde_json::to_string_pretty(&hooks_config(exe, Tool::ClaudeCode)).unwrap()
}

pub fn codex_hook_snippet(exe: &Path) -> String {
    serde_json::to_string_pretty(&hooks_config(exe, Tool::Codex)).unwrap()
}

pub struct DoctorItem {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

fn item(name: &'static str, ok: bool, detail: impl Into<String>) -> DoctorItem {
    DoctorItem { name, ok, detail: detail.into() }
}

/// launchctl の実行ファイル。テストでは TASKFOLIO_LAUNCHCTL で差し替える
pub fn launchctl_cmd() -> String {
    ["TASKFOLIO_LAUNCHCTL", "AI_WORKLOG_LAUNCHCTL"].into_iter()
        .find_map(|key| std::env::var(key).ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "launchctl".into())
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
    // TASKFOLIO_HOME を指定しているときは検証用の環境なので launchctl を呼ばない
    let use_launchctl = config::home_override().is_none();
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
        Err(e) => item("config", false, format!("{e} (run `taskfolio login`)")),
    });

    let secret = match &cfg {
        Ok(c) => keychain::read_secret(&c.client_id),
        Err(_) => Err("no config".to_string()),
    };
    items.push(match &secret {
        Ok(_) => item("keychain", true, "secret found"),
        Err(e) => item("keychain", false, e.clone()),
    });

    let plist = agents_dir.join(format!("{LAUNCH_LABEL}.plist"));
    items.push(if !plist.is_file() {
        item("launch agent", false, format!("{} not found (run `taskfolio setup`)", plist.display()))
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
            item("launch agent", false, "plist exists but the job is not loaded (run `taskfolio setup`)")
        }
    });

    items.push(hook_item("claude hook", claude_settings, exe, Tool::ClaudeCode));
    items.push(hook_item("codex hook", codex_hooks, exe, Tool::Codex));

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

fn hook_item(name: &'static str, file: &Path, exe: &Path, tool: Tool) -> DoctorItem {
    let text = match std::fs::read(file) {
        Ok(t) => t,
        Err(e) => return item(name, false, format!("cannot read {}: {e}", file.display())),
    };
    let Ok(configured) = serde_json::from_slice::<serde_json::Value>(&text) else {
        return item(name, false, format!("invalid JSON in {}", file.display()));
    };
    let expected = hooks_config(exe, tool);
    let mut missing = Vec::new();
    for (event, groups) in expected["hooks"].as_object().unwrap() {
        let wanted = &groups[0];
        let found = configured["hooks"][event].as_array().is_some_and(|groups| groups.iter().any(|g| {
            let matcher = g["matcher"].as_str().unwrap_or("");
            (matcher.is_empty() || matcher == "*" || wanted["matcher"].as_str() == Some(matcher))
                && g["hooks"].as_array().is_some_and(|hs| hs.iter().any(|h|
                    h["type"] == "command" && h["command"] == wanted["hooks"][0]["command"]))
        }));
        if !found { missing.push(event.as_str()); }
    }
    if missing.is_empty() {
        item(name, true, format!("registered in {}", file.display()))
    } else {
        item(name, false, format!("missing hooks in {}: {} (run `taskfolio setup --print-only`)", file.display(), missing.join(", ")))
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
    fn plist_wakes_for_pending_status_and_keeps_periodic_collection() {
        let p = launch_agent_plist(Path::new("/opt/bin/taskfolio"), Path::new("/Users/x/.taskfolio"));
        for needle in [
            "<string>/opt/bin/taskfolio</string>",
            "<string>collect</string>",
            "<integer>600</integer>",
            "<key>QueueDirectories</key>",
            "<string>/Users/x/.taskfolio/collect-queue</string>",
            "<key>ThrottleInterval</key>\n  <integer>30</integer>",
            "RunAtLoad",
            "<key>ProcessType</key>",
            "<string>Background</string>",
            "LowPriorityIO",
            "<string>dev.taskfolio.collect</string>",
            // 報告は collect.log に残るので、標準出力は捨てる。標準エラーだけ launchd.log へ
            "<key>StandardOutPath</key>\n  <string>/dev/null</string>",
            "<key>StandardErrorPath</key>\n  <string>/Users/x/.taskfolio/logs/launchd.log</string>",
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
        let p = launch_agent_plist(Path::new("/a&b/<x>/taskfolio"), Path::new("/h"));
        assert!(p.contains("/a&amp;b/&lt;x&gt;/taskfolio"), "{p}");
    }

    #[test]
    fn claude_snippet_is_session_end_hook() {
        let s = claude_hook_snippet(Path::new("/opt/bin/taskfolio"));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["hooks"]["SessionEnd"][0]["hooks"][0]["type"], "command");
        assert_eq!(v["hooks"]["SessionEnd"][0]["hooks"][0]["command"], "/opt/bin/taskfolio hook");
    }

    #[test]
    fn codex_snippet_is_session_end_hook() {
        let s = codex_hook_snippet(Path::new("/opt/bin/taskfolio"));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["hooks"]["SessionEnd"][0]["hooks"][0]["command"], "/opt/bin/taskfolio hook");
    }

    #[test]
    fn snippets_register_supported_events_and_quote_shell_paths() {
        let exe = Path::new("/tmp/a b'c/taskfolio");
        let claude = hooks_config(exe, Tool::ClaudeCode);
        assert_eq!(claude["hooks"]["Notification"][0]["matcher"], "permission_prompt");
        assert_eq!(claude["hooks"]["PostToolBatch"][0]["hooks"][0]["command"], "'/tmp/a b'\\''c/taskfolio' hook-status claude");
        let codex = hooks_config(exe, Tool::Codex);
        assert!(codex["hooks"]["Notification"].is_null());
        assert!(claude["hooks"]["PermissionRequest"].is_null());
        for event in ["UserPromptSubmit", "Stop", "Interrupt", "PreModelRequest", "PermissionRequest"] {
            assert!(codex["hooks"][event][0]["hooks"][0]["command"].as_str().unwrap().ends_with("hook-status codex"));
        }
    }

    #[test]
    fn doctor_identifies_hooks_missing_from_legacy_setup() {
        let dir = temp("doctor-legacy");
        let exe = Path::new("/tmp/taskfolio");
        let mut config = hooks_config(exe, Tool::ClaudeCode);
        config["hooks"].as_object_mut().unwrap().retain(|key, _| key == "SessionEnd");
        let path = dir.join("settings.json");
        std::fs::write(&path, config.to_string()).unwrap();
        let item = hook_item("claude hook", &path, exe, Tool::ClaudeCode);
        assert!(!item.ok && item.detail.contains("Notification") && !item.detail.contains("SessionEnd"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn doctor_reports_missing_pieces() {
        let d = temp("doctor-missing");
        let items = doctor_in(&d, &d.join("LaunchAgents"), &d.join("settings.json"), &d.join("hooks.json"), Path::new("/opt/bin/taskfolio"), 0, false);
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
        let exe = Path::new("/opt/bin/taskfolio");
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
