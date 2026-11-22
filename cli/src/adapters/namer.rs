use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub trait Namer {
    fn name(&self, material: &str) -> Option<String>;
}

pub struct ClaudeCliNamer {
    pub command: String,
    pub model: String,
    pub cwd: PathBuf,
    pub timeout: Duration,
}

impl Namer for ClaudeCliNamer {
    fn name(&self, material: &str) -> Option<String> {
        std::fs::create_dir_all(&self.cwd).ok()?;
        let mut child = Command::new(&self.command)
            .args(["-p", "--model", &self.model, "--no-session-persistence", "--tools", ""])
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let prompt = build_prompt(material);
        let mut stdin = child.stdin.take()?;
        let mut stdout = child.stdout.take()?;
        // 書き込みと読み出しは別スレッドで行い、パイプが詰まっても固まらないようにする
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
        let reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf);
            buf
        });
        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        // タイムアウト時は孫プロセスがパイプを握っていても待たずに戻る
        let status = status?;
        let _ = writer.join();
        let out = reader.join().ok()?;
        if !status.success() {
            return None;
        }
        sanitize_title(&String::from_utf8_lossy(&out))
    }
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
    let n = t.chars().count();
    if (1..=15).contains(&n) { Some(t.to_string()) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn sanitize_accepts_short_single_line() {
        assert_eq!(sanitize_title("検証基盤の構築\n").as_deref(), Some("検証基盤の構築"));
        assert_eq!(sanitize_title("「認証の実装」").as_deref(), Some("認証の実装"));
        assert_eq!(sanitize_title("作業名：認証の実装").as_deref(), Some("認証の実装"));
        assert_eq!(sanitize_title("作業名: 認証の実装。").as_deref(), Some("認証の実装"));
    }

    #[test]
    fn sanitize_rejects_bad_output() {
        assert_eq!(sanitize_title(""), None);
        assert_eq!(sanitize_title("一\n二"), None);
        assert_eq!(sanitize_title("あいうえおかきくけこさしすせそた"), None);
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
    fn cli_namer_returns_none_when_command_is_missing_or_slow() {
        let dir = std::env::temp_dir().join(format!("ai-worklog-namer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mk = |command: String, timeout_ms| ClaudeCliNamer {
            command,
            model: "haiku".into(),
            cwd: dir.join("work"),
            timeout: Duration::from_millis(timeout_ms),
        };
        assert_eq!(mk("/nonexistent/claude".into(), 200).name("m"), None);
        let slow = script(&dir, "slow.sh", "sleep 5");
        let t = Instant::now();
        assert_eq!(mk(slow, 200).name("m"), None);
        assert!(t.elapsed() < Duration::from_secs(2));
        let ok = script(&dir, "ok.sh", "cat >/dev/null\nprintf '認証の実装'");
        assert_eq!(mk(ok, 2000).name("m").as_deref(), Some("認証の実装"));
        let fail = script(&dir, "fail.sh", "cat >/dev/null\nprintf 'x'\nexit 1");
        assert_eq!(mk(fail, 2000).name("m"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
