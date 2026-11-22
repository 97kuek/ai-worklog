//! Identify the native CLI that launched a hook. Only inspect its executable,
//! parent PID and kernel start time. Persist no paths, arguments or environment.
use crate::domain::Tool;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ProcessIdentity {
    pid: i32,
    start_us: u64,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::ffi::OsStr;
    use std::io;
    use std::mem::{MaybeUninit, size_of};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    fn info(pid: i32) -> io::Result<libc::proc_bsdinfo> {
        if pid <= 1 {
            return Err(io::Error::other("invalid hook owner PID"));
        }
        let mut buffer = MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = size_of::<libc::proc_bsdinfo>() as i32;
        // SAFETY: the buffer is writable for size bytes; only use a full kernel record.
        let count = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                buffer.as_mut_ptr().cast(),
                size,
            )
        };
        if count == 0 {
            return Err(io::Error::last_os_error());
        }
        if count != size {
            return Err(io::Error::other("incomplete process identity"));
        }
        Ok(unsafe { buffer.assume_init() })
    }

    fn executable(pid: i32) -> Option<PathBuf> {
        let mut buf = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: the kernel writes at most the supplied buffer length.
        let len = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
        if len <= 0 {
            return None;
        }
        Some(PathBuf::from(OsStr::from_bytes(&buf[..len as usize])))
    }

    fn matches_cli(path: &Path, tool: Tool) -> bool {
        if path
            .ancestors()
            .any(|dir| dir.extension() == Some(OsStr::new("app")))
        {
            return false;
        }
        let Some(name) = path.file_name().and_then(OsStr::to_str) else {
            return false;
        };
        match tool {
            Tool::ClaudeCode => {
                name == "claude"
                    || (path
                        .parent()
                        .is_some_and(|dir| dir.ends_with("claude/versions"))
                        && name.split('.').count() == 3
                        && name.split('.').all(|part| {
                            !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())
                        }))
            }
            Tool::Codex => matches!(
                name,
                "codex" | "codex-aarch64-apple-darwin" | "codex-x86_64-apple-darwin"
            ),
        }
    }

    fn identity(record: &libc::proc_bsdinfo) -> ProcessIdentity {
        ProcessIdentity {
            pid: record.pbi_pid as i32,
            start_us: record.pbi_start_tvsec * 1_000_000 + record.pbi_start_tvusec,
        }
    }

    impl ProcessIdentity {
        pub(in crate::adapters) fn for_hook(tool: Tool) -> Option<Self> {
            let mut pid = unsafe { libc::getppid() };
            // Command hooks may go through a shell. Stop at an unrelated application
            // (for example an editor, a test runner or a CLI tool's child runtime).
            for _ in 0..4 {
                let record = info(pid).ok()?;
                let path = executable(pid)?;
                if matches_cli(&path, tool) {
                    return Some(identity(&record));
                }
                if !matches!(path.to_str(), Some("/bin/bash" | "/bin/sh" | "/bin/zsh")) {
                    break;
                }
                pid = record.pbi_ppid as i32;
            }
            None
        }

        pub(in crate::adapters) fn exited(&self) -> bool {
            match info(self.pid) {
                Ok(record) => record.pbi_status == libc::SZOMB || identity(&record) != *self,
                Err(err) => err.raw_os_error() == Some(libc::ESRCH),
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn verifies_kernel_identity_and_only_recognizes_native_cli_paths() {
            let this = identity(&info(std::process::id() as i32).unwrap());
            assert!(!this.exited());
            let reused = ProcessIdentity {
                start_us: this.start_us - 1,
                ..this
            };
            assert!(reused.exited());
            assert!(
                !ProcessIdentity {
                    pid: -1,
                    start_us: 0
                }
                .exited()
            );
            assert!(matches_cli(
                Path::new("/Users/test/.local/share/claude/versions/2.1.330"),
                Tool::ClaudeCode
            ));
            assert!(matches_cli(
                Path::new("/opt/homebrew/Caskroom/codex/0.167.2/bin/codex"),
                Tool::Codex
            ));
            assert!(!matches_cli(
                Path::new("/Applications/ChatGPT.app/Contents/Resources/codex"),
                Tool::Codex
            ));
            assert!(!matches_cli(
                Path::new("/tmp/versions/2.1.330"),
                Tool::ClaudeCode
            ));
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl ProcessIdentity {
    pub(super) fn for_hook(_: Tool) -> Option<Self> {
        None
    }
    pub(super) fn exited(&self) -> bool {
        false
    }
}
