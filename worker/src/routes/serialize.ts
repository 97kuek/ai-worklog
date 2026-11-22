import type { BlockRow, SessionRow } from "../db/repo";
import type { ModelEffort } from "../domain/ingest";

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function tokens(row: BlockRow | SessionRow) {
  return {
    input: row.input_tokens,
    output: row.output_tokens,
    cache_read: row.cache_read_tokens,
    cache_write: row.cache_write_tokens,
  };
}

export function serializeSession(s: SessionRow) {
  return {
    id: s.id,
    tool: s.tool,
    title: s.manual_title ?? s.title,
    manual_title: s.manual_title,
    project: s.project,
    git_branch: s.git_branch,
    models: JSON.parse(s.models) as string[],
    model_efforts: s.model_efforts === null ? [] : JSON.parse(s.model_efforts) as ModelEffort[],
    invoked_by: s.invoked_by,
    machine_name: s.machine_name,
    observed_status: s.observed_at === null ? undefined : { state: s.observed_state, at: iso(s.observed_at) },
    completed_at: s.completed_at === null ? null : iso(s.completed_at),
    started_at: iso(s.started_at),
    ended_at: iso(s.ended_at),
    active_minutes: s.active_minutes,
    tokens: tokens(s),
  };
}

export function serializeBlock(b: BlockRow) {
  return {
    session_id: b.session_id,
    seq: b.seq,
    started_at: iso(b.started_at),
    ended_at: iso(b.ended_at),
    message_count: b.message_count,
    tokens: tokens(b),
  };
}
