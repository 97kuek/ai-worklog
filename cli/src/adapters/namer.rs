use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// 名付けの結果
#[derive(Clone, Debug, PartialEq)]
pub enum NameOutcome {
    Named(String),
    /// claude は答えたが、作業名として使えない出力だった
    Unusable,
    /// claude を動かせなかった（見つからない、異常終了、時間切れ）
    Unavailable,
}

pub trait Namer {
    fn name(&self, material: &str) -> NameOutcome;
}

pub struct ClaudeCliNamer {
    pub command: String,
    pub model: String,
    pub cwd: PathBuf,
    pub timeout: Duration,
}

impl Namer for ClaudeCliNamer {
    fn name(&self, material: &str) -> NameOutcome {
        match self.run(material) {
            None => NameOutcome::Unavailable,
            Some(out) => sanitize_title(&out).map_or(NameOutcome::Unusable, NameOutcome::Named),
        }
    }
}

impl ClaudeCliNamer {
    /// claude を動かして標準出力を返す。動かせない・異常終了・時間切れなら None
    fn run(&self, material: &str) -> Option<String> {
        super::fsutil::create_private_dir(&self.cwd).ok()?;
        let mut child = Command::new(&self.command)
            .args(isolated_args(&self.model))
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let prompt = build_prompt(material);
        let (Some(mut stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        };
        // 書き込みと読み出しは別スレッドで行い、パイプが詰まっても固まらないようにする。
        // どちらのスレッドも待たない（孫プロセスがパイプを握っていると終わらないことがある）
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let read = stdout.read_to_end(&mut buf).map(|_| buf);
            let _ = tx.send(read);
        });
        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
                _ => break None,
            }
        };
        // 本体が終わっても、標準出力が閉じるのを待つのは残り時間まで
        let out = status.and_then(|_| rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok());
        let (Some(status), Some(Ok(out))) = (status, out) else {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        };
        if !status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out).into_owned())
    }
}

/// 利用者の設定・プラグイン・フック・MCP・スラッシュコマンドを読み込まず、道具も使わせない。
/// `--bare` はログイン情報（キーチェーン）まで読まなくなるので使わない
fn isolated_args(model: &str) -> [&str; 12] {
    [
        "-p",
        "--model",
        model,
        "--no-session-persistence",
        "--tools",
        "",
        "--setting-sources",
        "project",
        "--settings",
        r#"{"disableAllHooks":true}"#,
        "--strict-mcp-config",
        "--disable-slash-commands",
    ]
}

pub fn build_material(source_title: Option<&str>, user_texts: &[String]) -> String {
    let mut lines = Vec::new();
    if let Some(t) = source_title.filter(|t| !t.is_empty()) {
        lines.push(format!("既存のタイトル：{t}"));
    }
    for t in user_texts {
        lines.push(format!("- {}", t.replace(['\r', '\n'], " ")));
    }
    lines.join("\n")
}

pub fn build_prompt(material: &str) -> String {
    format!(
        "次は、AIとのコーディング作業の最初のやり取りです。この作業に、日報に書く作業名を付けてください。\n\
決まり：\n\
- 日本語で15文字以内\n\
- 「対象＋動作」の形（例：「LibreOffice検証基盤の構築」「認証APIのバグ修正」）\n\
- 作業名だけを1行で出力する。説明や記号は付けない\n\
\n\
--- やり取り ---\n\
{material}"
    )
}

/// AIの出力から作業名を取り出す。使えなければ None
pub fn sanitize_title(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() || t.contains('\n') {
        return None;
    }
    let mut t = t;
    for prefix in ["作業名：", "作業名:"] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest.trim();
            break;
        }
    }
    let t = t.trim_end_matches('。').trim();
    let t = t.trim_matches(|c| matches!(c, '「' | '」' | '『' | '』' | '"' | '\'' | '“' | '”' | '‘' | '’'));
    let t = t.trim();
    let w = display_width(t);
    if t.is_empty() || w > 30 { None } else { Some(t.to_string()) }
}

/// 表示幅。ASCII は 1、それ以外は 2。全角15文字 = 30
fn display_width(s: &str) -> usize {
    s.chars().map(|c| if c.is_ascii() { 1 } else { 2 }).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn sanitize_accepts_short_single_line() {
        assert_eq!(sanitize_title("LibreOffice検証基盤の構築\n").as_deref(), Some("LibreOffice検証基盤の構築"));
        assert_eq!(sanitize_title("「認証の実装」").as_deref(), Some("認証の実装"));
        assert_eq!(sanitize_title("作業名：認証の実装").as_deref(), Some("認証の実装"));
        assert_eq!(sanitize_title("作業名: 認証の実装。").as_deref(), Some("認証の実装"));
    }

    #[test]
    fn sanitize_rejects_bad_output() {
        assert_eq!(sanitize_title(""), None);
        assert_eq!(sanitize_title("一\n二"), None);
        assert_eq!(sanitize_title("あいうえおかきくけこさしすせそた"), None);
        assert_eq!(sanitize_title(&"a".repeat(30)).as_deref(), Some("a".repeat(30).as_str()));
        assert_eq!(sanitize_title(&"a".repeat(31)), None);
        assert_eq!(sanitize_title("あいうえおかきくけこさしすせそ").as_deref(), Some("あいうえおかきくけこさしすせそ"));
    }

    #[test]
    fn material_lists_title_and_user_texts() {
        let m = build_material(Some("旧題"), &["a\nb".to_string(), "c".to_string()]);
        assert_eq!(m, "既存のタイトル：旧題\n- a b\n- c");
        assert_eq!(build_material(Some(""), &["x".to_string()]), "- x");
        assert_eq!(build_material(None, &[]), "");
    }

    #[test]
    fn prompt_contains_the_rules_and_material() {
        let p = build_prompt("- 認証を直したい");
        assert!(p.contains("15文字以内"));
        assert!(p.contains("対象＋動作"));
        assert!(p.contains("- 認証を直したい"));
    }

    fn script(dir: &std::path::Path, name: &str, body: &str) -> String {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn cli_namer_isolates_claude_from_user_settings() {
        let dir = std::env::temp_dir().join(format!("ai-worklog-namer-argv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let argv = dir.join("argv.txt");
        let fake = script(
            &dir,
            "claude.sh",
            &format!("for a in \"$@\"; do printf '%s\\n' \"$a\"; done > '{}'\ncat >/dev/null\nprintf '認証の実装'", argv.display()),
        );
        let namer = ClaudeCliNamer { command: fake, model: "haiku".into(), cwd: dir.join("work"), timeout: Duration::from_secs(5) };
        assert_eq!(namer.name("m"), NameOutcome::Named("認証の実装".into()));
        let got = std::fs::read_to_string(&argv).unwrap();
        let got: Vec<&str> = got.lines().collect();
        assert_eq!(
            got,
            [
                "-p",
                "--model",
                "haiku",
                "--no-session-persistence",
                "--tools",
                "",
                "--setting-sources",
                "project",
                "--settings",
                r#"{"disableAllHooks":true}"#,
                "--strict-mcp-config",
                "--disable-slash-commands",
            ]
        );
        assert!(!got.contains(&"--bare"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cli_namer_tells_unavailable_from_unusable() {
        let dir = std::env::temp_dir().join(format!("ai-worklog-namer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mk = |command: String, timeout_ms| ClaudeCliNamer {
            command,
            model: "haiku".into(),
            cwd: dir.join("work"),
            timeout: Duration::from_millis(timeout_ms),
        };
        assert_eq!(mk("/nonexistent/claude".into(), 200).name("m"), NameOutcome::Unavailable);
        let slow = script(&dir, "slow.sh", "sleep 5");
        let t = Instant::now();
        assert_eq!(mk(slow, 200).name("m"), NameOutcome::Unavailable);
        assert!(t.elapsed() < Duration::from_secs(2));
        let ok = script(&dir, "ok.sh", "cat >/dev/null\nprintf '認証の実装'");
        assert_eq!(mk(ok, 2000).name("m"), NameOutcome::Named("認証の実装".into()));
        // 本体はすぐ終わるが、孫プロセスが標準出力を握ったまま残る
        let held = script(&dir, "held.sh", "cat >/dev/null\nsleep 5 &\nprintf '認証の実装'");
        let t = Instant::now();
        assert_eq!(mk(held, 300).name("m"), NameOutcome::Unavailable);
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        // 本体が標準入力を読まずに止まっていても、時間内に戻る
        let stuck = script(&dir, "stuck.sh", "sleep 5");
        let t = Instant::now();
        assert_eq!(mk(stuck, 300).name(&"x".repeat(1 << 20)), NameOutcome::Unavailable);
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        let fail = script(&dir, "fail.sh", "cat >/dev/null\nprintf 'x'\nexit 1");
        assert_eq!(mk(fail, 2000).name("m"), NameOutcome::Unavailable);
        let unusable = script(&dir, "unusable.sh", "cat >/dev/null\nprintf '一\\n二\\n'");
        assert_eq!(mk(unusable, 2000).name("m"), NameOutcome::Unusable);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
