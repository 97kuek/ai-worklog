use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ai-worklog"))
}

#[test]
fn prints_version() {
    let out = bin().arg("--version").output().unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ai-worklog 0.1.0");
}

#[test]
fn unknown_subcommand_exits_with_2() {
    let out = bin().arg("nope").output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("usage: ai-worklog"));
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
    let out = bin().arg("collect").env("AI_WORKLOG_HOME", &home).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("login"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn hook_exits_zero_fast() {
    let start = std::time::Instant::now();
    // launchctl は実在しないパスにして、本物のジョブには触れない
    let out = bin().arg("hook").env("AI_WORKLOG_LAUNCHCTL", "/nonexistent/launchctl").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(start.elapsed() < std::time::Duration::from_millis(500), "{:?}", start.elapsed());
}

#[test]
fn setup_print_only_writes_nothing() {
    let home = temp_dir("setup-home");
    let fake_home = temp_dir("setup-fakehome");
    let out = bin()
        .args(["setup", "--print-only"])
        .env("AI_WORKLOG_HOME", &home)
        .env("HOME", &fake_home)
        .env("AI_WORKLOG_LAUNCHCTL", "/nonexistent/launchctl")
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
    let out = bin().args(["login", "--url", "https://x"]).env("AI_WORKLOG_HOME", &home).output().unwrap();
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
    let out = bin().arg("collect").env("AI_WORKLOG_HOME", &home).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stderr).contains("another collect is running"), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(out.stdout.is_empty());
    drop(lock);
    let _ = std::fs::remove_dir_all(&home);
}
