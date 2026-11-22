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
