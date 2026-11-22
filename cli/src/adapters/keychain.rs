use std::process::{Command, Stdio};

pub const SERVICE: &str = "ai-worklog";
const SECURITY: &str = "/usr/bin/security";

/// Reads the Client Secret from the macOS Keychain (service `ai-worklog`, account = Client ID).
pub fn read_secret(account: &str) -> Result<String, String> {
    let out = Command::new(SECURITY)
        .args(["find-generic-password", "-s", SERVICE, "-a", account, "-w"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run security: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "no Keychain item for service {SERVICE}, account {account} (security exit {})",
            out.status.code().map_or("signal".to_string(), |c| c.to_string())
        ));
    }
    secret_from_output(out.stdout, account)
}

/// `security -w` の出力から値を取り出す
fn secret_from_output(stdout: Vec<u8>, account: &str) -> Result<String, String> {
    let s = String::from_utf8(stdout).map_err(|_| "Keychain value is not UTF-8".to_string())?;
    let s = s.trim_end_matches(['\n', '\r']);
    if s.is_empty() {
        return Err(format!("the Keychain item for service {SERVICE}, account {account} is empty (run `ai-worklog login` again)"));
    }
    Ok(s.to_string())
}

/// Lets `security` prompt for the value on the TTY itself; this process never sees it.
pub fn store_secret_interactive(account: &str) -> Result<(), String> {
    let status = Command::new(SECURITY)
        .args(["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w"])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|e| format!("cannot run security: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "security exited with {}",
            status.code().map_or("a signal".to_string(), |c| c.to_string())
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_secret_is_an_error() {
        assert_eq!(secret_from_output(b"s3cret\n".to_vec(), "id"), Ok("s3cret".to_string()));
        for empty in [&b""[..], b"\n", b"\r\n"] {
            let e = secret_from_output(empty.to_vec(), "id.access").unwrap_err();
            assert!(e.contains("empty") && e.contains("id.access"), "{e}");
        }
    }
}
