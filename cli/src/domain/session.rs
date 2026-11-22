use super::model::{Block, RawSession, Session, TokenUsage};

/// Builds work blocks from a raw session.
///
/// Activity is sorted, and a new block starts wherever the gap between two
/// consecutive timestamps is `gap_ms` or more. Each token event goes to the
/// last block that started at or before it (or the first block if none).
/// Returns `None` when there is no activity or no tool.
pub fn build_session(raw: RawSession, gap_ms: i64) -> Option<Session> {
    let tool = raw.tool?;
    let mut activity = raw.activity;
    activity.sort_unstable();
    let (&first, &last) = (activity.first()?, activity.last()?);

    let mut blocks: Vec<Block> = Vec::new();
    for &at in &activity {
        match blocks.last_mut() {
            Some(b) if at - b.ended_at < gap_ms => {
                b.ended_at = at;
                b.message_count += 1;
            }
            _ => blocks.push(Block {
                seq: blocks.len() as u32,
                started_at: at,
                ended_at: at,
                message_count: 1,
                tokens: TokenUsage::default(),
            }),
        }
    }

    let mut tokens = TokenUsage::default();
    for event in &raw.token_events {
        let idx = blocks.partition_point(|b| b.started_at <= event.at).saturating_sub(1);
        blocks[idx].tokens += event.usage;
        tokens += event.usage;
    }

    let active_ms: i64 = blocks.iter().map(|b| b.ended_at - b.started_at).sum();
    let project = raw
        .cwd
        .as_deref()
        .and_then(|c| c.split('/').rev().find(|p| !p.is_empty()))
        .map(str::to_owned);

    Some(Session {
        tool,
        native_session_id: raw.native_session_id,
        source_title: raw.source_title,
        project,
        cwd: raw.cwd,
        git_branch: raw.git_branch,
        models: raw.models.into_iter().collect(),
        model_efforts: raw.model_efforts.into_iter().collect(),
        invoked_by: raw.invoked_by,
        observed_status: raw.observed_status,
        started_at: first,
        ended_at: last,
        active_minutes: active_ms as f64 / 60_000.0,
        tokens,
        blocks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{TokenEvent, TokenUsage, Tool};

    const M: i64 = 60_000;

    fn raw(activity: Vec<i64>, events: Vec<(i64, u64)>) -> RawSession {
        RawSession {
            tool: Some(Tool::ClaudeCode),
            native_session_id: "s".into(),
            cwd: Some("/a/b/proj".into()),
            activity,
            token_events: events
                .into_iter()
                .map(|(at, output)| TokenEvent { at, usage: TokenUsage { output, ..Default::default() } })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn splits_when_gap_is_exactly_threshold() {
        let s = build_session(raw(vec![0, 10 * M, 40 * M], vec![]), 30 * M).unwrap();
        assert_eq!(s.blocks.len(), 2);
        assert_eq!((s.blocks[0].started_at, s.blocks[0].ended_at, s.blocks[0].message_count), (0, 10 * M, 2));
        assert_eq!((s.blocks[1].seq, s.blocks[1].started_at), (1, 40 * M));
    }

    #[test]
    fn does_not_split_just_below_threshold() {
        let s = build_session(raw(vec![0, 30 * M - 1], vec![]), 30 * M).unwrap();
        assert_eq!(s.blocks.len(), 1);
    }

    #[test]
    fn sorts_unordered_activity() {
        let s = build_session(raw(vec![40 * M, 0, 10 * M], vec![]), 30 * M).unwrap();
        assert_eq!((s.started_at, s.ended_at), (0, 40 * M));
    }

    #[test]
    fn single_message_gives_zero_length_block() {
        let s = build_session(raw(vec![5 * M], vec![]), 30 * M).unwrap();
        assert_eq!(s.blocks.len(), 1);
        assert_eq!(s.active_minutes, 0.0);
    }

    #[test]
    fn empty_activity_gives_none() {
        assert!(build_session(raw(vec![], vec![(0, 1)]), 30 * M).is_none());
    }

    #[test]
    fn attributes_tokens_to_containing_or_previous_block() {
        let s = build_session(
            raw(vec![0, 10 * M, 40 * M, 50 * M], vec![(-1, 1), (20 * M, 2), (45 * M, 4)]),
            30 * M,
        )
        .unwrap();
        assert_eq!(s.blocks[0].tokens.output, 3);
        assert_eq!(s.blocks[1].tokens.output, 4);
        assert_eq!(s.tokens.output, 7);
        assert_eq!(s.active_minutes, 20.0);
        assert_eq!(s.project.as_deref(), Some("proj"));
    }
}
