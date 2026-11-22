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
