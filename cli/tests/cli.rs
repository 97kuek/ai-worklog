use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_taskfolio"))
}

#[test]
fn prints_version() {
    let out = bin().arg("--version").output().unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "taskfolio 0.1.0");
}

#[test]
fn unknown_subcommand_exits_with_2() {
    let out = bin().arg("nope").output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage: taskfolio"));
}

#[test]
fn scan_fixtures_outputs_both_tools() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let out = bin()
        .args(["scan", "--since-days", "36500", "--claude-dir"])
        .arg(format!("{dir}/tests/fixtures/claude/projects"))
        .arg("--codex-dir")
        .arg(format!("{dir}/tests/fixtures/codex"))
        .output()
        .unwrap();
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let ids: Vec<&str> = v.as_array().unwrap().iter().map(|s| s["native_session_id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["s1", "c1", "s2"]);
    assert_eq!(v[1]["invoked_by"], "claude_code");
    assert_eq!(v[2]["active_minutes"], 0.0);
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("aiw-cli-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn collect_exits_quietly_without_config() {
    let home = temp_dir("collect");
    let out = bin().arg("collect").env("TASKFOLIO_HOME", &home).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("login"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn hook_exits_zero_fast() {
    let start = std::time::Instant::now();
    // launchctl は実在しないパスにして、本物のジョブには触れない
    let out = bin().arg("hook").env("TASKFOLIO_LAUNCHCTL", "/nonexistent/launchctl").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(start.elapsed() < std::time::Duration::from_millis(500), "{:?}", start.elapsed());
}

#[test]
fn setup_print_only_writes_nothing() {
    let home = temp_dir("setup-home");
    let fake_home = temp_dir("setup-fakehome");
    let out = bin()
        .args(["setup", "--print-only"])
        .env("TASKFOLIO_HOME", &home)
        .env("HOME", &fake_home)
        .env("TASKFOLIO_LAUNCHCTL", "/nonexistent/launchctl")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("StartInterval"), "{text}");
    assert!(text.contains("SessionEnd"), "{text}");
    assert!(!fake_home.join("Library").exists());
    assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&fake_home);
}

#[test]
fn login_rejects_missing_options() {
    let home = temp_dir("login");
    let out = bin().args(["login", "--url", "https://x"]).env("TASKFOLIO_HOME", &home).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(!home.join("config.json").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn collect_says_so_and_exits_zero_when_another_collect_holds_the_lock() {
    let home = temp_dir("collect-locked");
    std::fs::write(
        home.join("config.json"),
        r#"{"api_url":"http://127.0.0.1:9/ingest","machine_name":"m","client_id":"test.access"}"#,
    )
    .unwrap();
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(home.join("collect.lock")).unwrap();
    lock.try_lock().unwrap();
    // ロックの後のキーチェーンや送信には進まない
    let out = bin().arg("collect").env("TASKFOLIO_HOME", &home).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stderr).contains("another collect is running"), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(out.stdout.is_empty());
    let forced = bin().args(["collect", "--rescan"]).env("TASKFOLIO_HOME", &home).output().unwrap();
    assert_eq!(forced.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&forced.stderr).contains("another collect is running"));
    drop(lock);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn status_hook_keeps_only_the_observation_and_does_not_trigger_collection() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Stdio;
    use taskfolio::adapters::status_hook::read_latest;
    use taskfolio::domain::{ObservedState, Tool};

    let home = temp_dir("status-hook");
    let fake_launchctl = home.join("fake-launchctl");
    std::fs::write(&fake_launchctl, "#!/bin/sh\ntouch \"$TASKFOLIO_HOME/kickstarted\"\n").unwrap();
    std::fs::set_permissions(&fake_launchctl, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut proc = bin().args(["hook-status", "claude"]).env("TASKFOLIO_HOME", &home)
        .env("TASKFOLIO_LAUNCHCTL", &fake_launchctl)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    proc.stdin.take().unwrap().write_all(br#"{"session_id":"id-1","hook_event_name":"Stop","last_assistant_message":"private contents","prompt":"private prompt","tool_input":{"command":"private cmd"},"background_tasks":[],"session_crons":[]}"#).unwrap();
    let out = proc.wait_with_output().unwrap();
    assert!(out.status.success() && out.stdout.is_empty() && out.stderr.is_empty());
    let path = home.join("status/claude/id-1.json");
    let snapshot: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(snapshot.as_object().unwrap().len(), 2);
    assert!(snapshot["at_ns"].as_u64().unwrap() > 0);
    assert_eq!(snapshot["state"], "waiting");
    assert_eq!(read_latest(&home, Tool::ClaudeCode, "id-1").unwrap().unwrap().state, ObservedState::Waiting);
    assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
    assert!(!home.join("kickstarted").exists());
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn skills_queries_installed_plugins_before_the_workspace_snapshot() {
    use std::os::unix::fs::PermissionsExt;
    let home = temp_dir("skills-protocol");
    let claude = home.join("claude");
    let codex = home.join("codex");
    std::fs::write(&claude, r#"#!/bin/sh
read -r req || exit 1
case "$req" in *initialize*) ;; *) exit 2;; esac
echo '{"type":"control_response","response":{"subtype":"success","request_id":"init","response":{}}}'
read -r req || exit 1
case "$req" in *get_skills_dialog*) ;; *) exit 3;; esac
echo '{"type":"control_response","response":{"subtype":"success","request_id":"skills","response":{"skills":[]}}}'
"#).unwrap();
    std::fs::write(&codex, r#"#!/bin/sh
read -r req || exit 1
echo '{"id":1,"result":{}}'
read -r notification || exit 1
read -r req || exit 1
case "$req" in *plugin/installed*) ;; *) exit 2;; esac
echo '{"id":2,"result":{"marketplaces":[{"name":"catalog","plugins":[{"name":"remote","remotePluginId":"backend-id","source":{"type":"remote"},"installed":true,"enabled":true},{"source":{"type":"remote"},"installed":true,"enabled":false}]}],"marketplaceLoadErrors":[]}}'
read -r req || exit 1
case "$req" in *plugin/read*backend-id*) ;; *) exit 5;; esac
echo '{"id":10,"result":{"plugin":{"skills":[{"name":"a","enabled":true},{"name":"disabled","enabled":true}]}}}'
read -r req || exit 1
case "$req" in *skills/list*) ;; *) exit 6;; esac
echo '{"id":3,"result":{"data":[{"errors":[],"skills":[]}]}}'
read -r req || exit 1
case "$req" in *skills/list*) ;; *) exit 3;; esac
case "$req" in *"$PWD"*) ;; *) exit 4;; esac
echo '{"id":3,"result":{"data":[{"errors":[],"skills":[{"enabled":true,"name":"remote:a","description":"example","path":"private","scope":"user"},{"name":"remote:disabled","enabled":false}]}]}}'
"#).unwrap();
    for p in [claude, codex] {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let output = bin().arg("skills").arg("--cwd").arg(&home).env("PATH", &home).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(), serde_json::json!({
        "skills":[{"tool":"codex","name":"remote:a","description":"example"}]
    }));
    let _ = std::fs::remove_dir_all(&home);
}


#[test]
fn resolves_existing_installations_and_the_new_home_override() {
    let home = temp_dir("home-compat");
    let legacy = home.join(".ai-worklog");
    let current = home.join(".taskfolio");
    let printed = |overrides: &[(&str, &std::path::Path)]| {
        let mut cmd = bin();
        cmd.args(["setup", "--print-only"]).env("HOME", &home)
            .env_remove("TASKFOLIO_HOME").env_remove("AI_WORKLOG_HOME");
        for &(key, path) in overrides { cmd.env(key, path); }
        let out = cmd.output().unwrap();
        assert!(out.status.success());
        String::from_utf8(out.stdout).unwrap()
    };
    let has_home = |output: String, path: &std::path::Path| {
        assert!(output.contains(&format!("<string>{}</string>", path.display())));
    };
    has_home(printed(&[]), &current);
    std::fs::create_dir(&legacy).unwrap();
    has_home(printed(&[]), &legacy);
    std::fs::create_dir(&current).unwrap();
    has_home(printed(&[]), &current);
    has_home(printed(&[("AI_WORKLOG_HOME", &legacy)]), &legacy);
    has_home(printed(&[("AI_WORKLOG_HOME", &legacy), ("TASKFOLIO_HOME", &current)]), &current);
    let _ = std::fs::remove_dir_all(&home);
}
