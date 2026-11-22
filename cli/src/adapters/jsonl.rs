use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use memchr::memmem::Finder;

/// Calls `f` for each newline-terminated line that contains any of `needles`
/// (every line when `needles` is empty). A final line without a trailing
/// newline is treated as still being written and is skipped.
pub fn for_each_matching_line(path: &Path, needles: &[&str], mut f: impl FnMut(&[u8])) -> std::io::Result<()> {
    let finders: Vec<Finder<'_>> = needles.iter().map(|n| Finder::new(n.as_bytes())).collect();
    let mut reader = BufReader::with_capacity(256 * 1024, File::open(path)?);
    let mut buf = Vec::with_capacity(64 * 1024);
    loop {
        buf.clear();
        if reader.read_until(b'\n', &mut buf)? == 0 {
            return Ok(());
        }
        if buf.last() != Some(&b'\n') {
            return Ok(());
        }
        if finders.is_empty() || finders.iter().any(|fd| fd.find(&buf).is_some()) {
            f(&buf);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(content: &str, needles: &[&str]) -> Vec<String> {
        let path = std::env::temp_dir().join(format!("aiwl-jsonl-{}-{}.jsonl", std::process::id(), content.len()));
        std::fs::write(&path, content).unwrap();
        let mut got = Vec::new();
        for_each_matching_line(&path, needles, |l| {
            let s = String::from_utf8_lossy(l);
            got.push(s.trim_end_matches(['\n', '\r']).to_string());
        })
        .unwrap();
        std::fs::remove_file(&path).unwrap();
        got
    }

    #[test]
    fn passes_only_complete_lines_containing_a_needle() {
        assert_eq!(collect("a:1\nb:2\na:3\na:4", &["a:"]), vec!["a:1", "a:3"]);
    }

    #[test]
    fn empty_needles_pass_every_complete_line() {
        assert_eq!(collect("x\ny\n", &[]), vec!["x", "y"]);
    }
}
