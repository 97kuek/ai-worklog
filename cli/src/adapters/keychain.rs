use std::process::{Command, Stdio};

pub const SERVICE: &str = "taskfolio";
const SECURITY: &str = "/usr/bin/security";

const LEGACY_SERVICE: &str = "ai-worklog";
// security exits with the low eight bits of errSecItemNotFound (-25300).
const ITEM_NOT_FOUND: i32 = 44;

/// Look for the account in the current service first. A locked keychain or
/// denied access must not silently select a different credential.
pub fn read_secret(account: &str) -> Result<String, String> {
    lookup_with(|service| {
        let out = Command::new(SECURITY)
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("cannot run security: {e}"))?;
        if out.status.success() {
            secret_from_output(out.stdout).map(Some)
        } else if out.status.code() == Some(ITEM_NOT_FOUND) {
            Ok(None)
        } else {
            Err(format!("cannot read Keychain item for service {service} (security {})", out.status))
        }
    })
}

fn lookup_with(mut lookup: impl FnMut(&str) -> Result<Option<String>, String>) -> Result<String, String> {
    for service in [SERVICE, LEGACY_SERVICE] {
        if let Some(value) = lookup(service)? {
            return Ok(value);
        }
    }
    Err("no Keychain item found for this account (run `taskfolio login`)".into())
}

fn secret_from_output(stdout: Vec<u8>) -> Result<String, String> {
    let s = String::from_utf8(stdout).map_err(|_| "Keychain value is not UTF-8".to_string())?;
    let s = s.trim_end_matches(['\n', '\r']);
    if s.is_empty() {
        return Err("the Keychain item is empty (run `taskfolio login` again)".into());
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
    fn uses_legacy_only_when_the_current_account_is_absent() {
        let mut calls = Vec::new();
        let old = lookup_with(|service| {
            calls.push(service.to_owned());
            Ok((service == LEGACY_SERVICE).then(|| "fixture".to_owned()))
        });
        assert!(old.is_ok());
        assert_eq!(calls, [SERVICE, LEGACY_SERVICE]);
        for found in [Ok(Some("fixture".into())), Err("access denied".into())] {
            assert_eq!(lookup_with(|service| {
                assert_eq!(service, SERVICE);
                found.clone()
            }), found.clone().map(Option::unwrap));
        }
    }

    #[test]
    fn empty_secret_is_an_error() {
        assert_eq!(secret_from_output(b"fixture\n".to_vec()), Ok("fixture".to_string()));
        for empty in [&b""[..], b"\n", b"\r\n"] {
            let e = secret_from_output(empty.to_vec()).unwrap_err();
            assert!(e.contains("empty"), "{e}");
        }
    }
}
