use jiff::Timestamp;

use crate::domain::Millis;

/// Parses an RFC 3339 timestamp into UTC epoch milliseconds.
pub fn parse_ts(s: &str) -> Option<Millis> {
    s.parse::<Timestamp>().ok().map(|t| t.as_millisecond())
}

/// Formats UTC epoch milliseconds as RFC 3339 in UTC with millisecond precision.
pub fn format_ts(ms: Millis) -> String {
    match Timestamp::from_millisecond(ms) {
        Ok(t) => format!("{t:.3}"),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_utc() {
        let ms = parse_ts("2026-11-20T01:00:00.000Z").unwrap();
        assert_eq!(ms, 1_795_136_400_000);
        assert_eq!(format_ts(ms), "2026-11-20T01:00:00.000Z");
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_ts("not a time"), None);
    }
}
