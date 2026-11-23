import type { IngestPayload, ObservedStatus } from "../domain/ingest";

/** Returns the id of the user with this email, creating it if needed (race-safe). */
export async function ensureUser(db: D1Database, email: string, now: number): Promise<string> {
  const [, found] = await db.batch<{ id: string }>([
    db
      .prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING")
      .bind(crypto.randomUUID(), email, now),
    db.prepare("SELECT id FROM users WHERE email = ?").bind(email),
  ]);
  return found.results[0]!.id;
}

/** Resolves or registers this owner’s machine. A client id assigned to another owner cannot be reused. */
export async function ensureMachine(
  db: D1Database,
  userId: string,
  accessClientId: string,
  now: number,
): Promise<string | null> {
  const [, found] = await db.batch<{ id: string }>([
    db
      .prepare(
        "INSERT INTO machines (id, user_id, access_client_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(access_client_id) DO NOTHING",
      )
      .bind(crypto.randomUUID(), userId, accessClientId, now),
    db.prepare("SELECT id FROM machines WHERE access_client_id = ? AND user_id = ?").bind(accessClientId, userId),
  ]);
  return found.results[0]?.id ?? null;
}

const SESSION_COLUMNS = [
  "machine_id",
  "title",
  "project",
  "cwd",
  "git_branch",
  "models",
  "model_efforts",
  "invoked_by",
  "started_at",
  "ended_at",
  "active_minutes",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
] as const;

const BLOCK_COLUMNS = [
  "user_id",
  "started_at",
  "ended_at",
  "message_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
] as const;

function sessionValue(c: typeof SESSION_COLUMNS[number]): string {
  // Legacy clients omit model_efforts, and untitled uploads retain the previous title.
  if (c === "title" || c === "model_efforts") return `COALESCE(excluded.${c}, sessions.${c})`;
  return `excluded.${c}`;
}
const sessionAssignments = SESSION_COLUMNS.map((c) => `${c} = ${sessionValue(c)}`).join(", ");
const sessionDiffers = SESSION_COLUMNS.map((c) => `sessions.${c} IS NOT ${sessionValue(c)}`).join(" OR ");
const blockAssignments = BLOCK_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
const blockDiffers = BLOCK_COLUMNS.map((c) => `blocks.${c} IS NOT excluded.${c}`).join(" OR ");

const newerObservation = "excluded.observed_at IS NOT NULL AND (sessions.observed_at IS NULL OR excluded.observed_at > sessions.observed_at)";
// A block-only edit (including a shorter history) also changes the task detail.
const blockFields = BLOCK_COLUMNS.filter(c => c !== "user_id");
const storedBlockValues = `(SELECT json_group_array(json_array(${blockFields.join(",")}) ORDER BY seq)
  FROM blocks WHERE session_id = sessions.id)`;

function blockValues(b: IngestPayload["sessions"][number]["blocks"][number]) {
  return [b.started_at, b.ended_at, b.message_count, b.tokens.input, b.tokens.output, b.tokens.cache_read, b.tokens.cache_write];
}

const SESSION_ID = "(SELECT id FROM sessions WHERE user_id = ? AND tool = ? AND native_session_id = ?)";

/**
 * Upserts the machine's name, every session and its blocks in one batch (one transaction).
 * The ingestion change count excludes receipt bookkeeping.
 */
export async function saveSessions(
  db: D1Database,
  p: { userId: string; machineId: string },
  payload: IngestPayload,
  now: number,
): Promise<{ rowsChanged: number }> {
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE machines SET name = ?, last_seen_at = ? WHERE id = ?").bind(payload.machine_name, now, p.machineId),
  ];
  for (const s of payload.sessions) {
    const key = [p.userId, s.tool, s.native_session_id] as const;
    stmts.push(
      db
        .prepare(
          `INSERT INTO sessions (id, user_id, tool, native_session_id, ${SESSION_COLUMNS.join(", ")}, observed_state, observed_at, updated_at)
           VALUES (?, ?, ?, ?, ${SESSION_COLUMNS.map(() => "?").join(", ")}, ?, ?, ?)
           ON CONFLICT (user_id, tool, native_session_id) DO UPDATE SET ${sessionAssignments},
             observed_state = CASE WHEN ${newerObservation} THEN excluded.observed_state ELSE sessions.observed_state END,
             observed_at = CASE WHEN ${newerObservation} THEN excluded.observed_at ELSE sessions.observed_at END,
             updated_at = MAX(sessions.updated_at + 1, excluded.updated_at)
           WHERE ${sessionDiffers} OR (${newerObservation}) OR ${storedBlockValues} <> ?`,
        )
        .bind(
          crypto.randomUUID(),
          ...key,
          p.machineId,
          s.title,
          s.project,
          s.cwd,
          s.git_branch,
          JSON.stringify(s.models),
          s.model_efforts === undefined ? null : JSON.stringify(s.model_efforts),
          s.invoked_by,
          s.started_at,
          s.ended_at,
          s.active_minutes,
          s.tokens.input,
          s.tokens.output,
          s.tokens.cache_read,
          s.tokens.cache_write,
          s.observed_status?.state ?? null,
          s.observed_status?.at ?? null,
          now,
          JSON.stringify(s.blocks.map(blockValues)),
        ),
    );
  }
  for (const s of payload.sessions) {
    const key = [p.userId, s.tool, s.native_session_id] as const;
    for (const b of s.blocks) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO blocks (session_id, seq, ${BLOCK_COLUMNS.join(", ")})
             VALUES (${SESSION_ID}, ?, ${BLOCK_COLUMNS.map(() => "?").join(", ")})
             ON CONFLICT (session_id, seq) DO UPDATE SET ${blockAssignments}
             WHERE ${blockDiffers}`,
          )
          .bind(
            ...key,
            b.seq,
            p.userId,
            ...blockValues(b),
          ),
      );
    }
  }
  for (const s of payload.sessions) {
    stmts.push(
      db
        .prepare(`DELETE FROM blocks WHERE session_id = ${SESSION_ID} AND seq >= ?`)
        .bind(p.userId, s.tool, s.native_session_id, s.blocks.length),
    );
  }
  const receipts = [...new Set(payload.sessions.map(s => s.tool))].map(tool =>
    db.prepare(`INSERT INTO machine_log_receipts (machine_id, tool, received_at) VALUES (?, ?, ?)
      ON CONFLICT (machine_id, tool) DO UPDATE SET received_at = excluded.received_at
      WHERE excluded.received_at > machine_log_receipts.received_at`).bind(p.machineId, tool, now)
  );
  const results = await db.batch([...stmts, ...receipts]);
  return { rowsChanged: results.slice(0, stmts.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0) };
}

export type SessionRow = {
  id: string;
  tool: string;
  title: string | null;
  manual_title: string | null;
  project: string | null;
  git_branch: string | null;
  models: string;
  model_efforts: string | null;
  invoked_by: string | null;
  machine_name: string | null;
  updated_at: number;
  observed_state: ObservedStatus["state"] | null;
  observed_at: number | null;
  completed_at: number | null;
  started_at: number;
  ended_at: number;
  active_minutes: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

export type BlockRow = {
  session_id: string;
  seq: number;
  started_at: number;
  ended_at: number;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

// Completion belongs to the observed turn. A later observation can reopen the
// same native session, including rows completed before this rule was introduced.
const currentCompletion = "CASE WHEN s.observed_at IS NULL OR s.observed_at <= s.completed_at THEN s.completed_at END";
const SELECT_SESSION = `SELECT s.id, s.tool, s.title, s.manual_title, s.project, s.git_branch, s.models, s.model_efforts, s.invoked_by,
    m.name AS machine_name, s.updated_at, s.started_at, s.ended_at, s.active_minutes,
    s.observed_state, s.observed_at, ${currentCompletion} AS completed_at,
    s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_tokens
  FROM sessions s JOIN machines m ON m.id = s.machine_id AND m.user_id = s.user_id`;

const SELECT_BLOCK = `SELECT session_id, seq, started_at, ended_at, message_count,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM blocks`;

function sessionById(db: D1Database, userId: string, id: string) {
  return db.prepare(`${SELECT_SESSION} WHERE s.user_id = ? AND s.id = ?`).bind(userId, id);
}

export async function listBoardSessions(db: D1Database, userId: string, status?: "running"): Promise<SessionRow[]> {
  const filter = status === "running" ? `AND s.observed_state = 'running' AND (${currentCompletion}) IS NULL` : "";
  const sessions = await db.prepare(`${SELECT_SESSION} WHERE s.user_id = ? ${filter} ORDER BY s.ended_at DESC, s.id`)
    .bind(userId).all<SessionRow>();
  return sessions.results;
}

export type BoardSessionRow = Pick<SessionRow, "id" | "tool" | "project" | "title" | "manual_title" | "observed_state"
  | "observed_at" | "completed_at" | "started_at" | "ended_at">;

export async function listVisibleBoardSessions(db: D1Database, user: string, cutoff: number) {
  const { results } = await db.prepare(`SELECT id, tool, project, title, manual_title, observed_state, observed_at,
    ${currentCompletion} AS completed_at, started_at, ended_at FROM sessions s WHERE user_id = ?
    AND ((${currentCompletion}) > ? OR ((${currentCompletion}) IS NULL AND observed_state IN ('running', 'waiting')))`)
    .bind(user, cutoff).all<BoardSessionRow>();
  return results;
}

/** One default per project and engine, plus historical model choices for overrides. */
export async function readComposerHistory(db: D1Database, user: string) {
  type Settings = Pick<SessionRow, "tool" | "models" | "model_efforts">;
  const [recent, available] = await db.batch([
    db.prepare(`SELECT project, tool, models, model_efforts FROM (
      SELECT project, tool, models, model_efforts, ended_at, id,
        ROW_NUMBER() OVER (PARTITION BY project, tool ORDER BY ended_at DESC, id) AS position
      FROM sessions WHERE user_id = ? AND project IS NOT NULL
    ) WHERE position = 1 ORDER BY ended_at DESC, id`).bind(user),
    db.prepare("SELECT DISTINCT tool, models, model_efforts FROM sessions WHERE user_id = ?").bind(user),
  ]);
  return {
    recent: recent.results as (Settings & { project: string })[],
    available: available.results as Settings[],
  };
}

type DetailVersion = Pick<SessionRow, "id" | "updated_at" | "machine_name">;

export function detailETag(row: DetailVersion) {
  // A rename of the machine can change the detail without updating the session.
  return '"detail-v1-' + row.id + '-' + row.updated_at + '-' + encodeURIComponent(JSON.stringify(row.machine_name)) + '"';
}

export async function readDetailETag(db: D1Database, user: string, id: string) {
  const row = await db.prepare(`SELECT s.id, s.updated_at, m.name AS machine_name FROM sessions s
    JOIN machines m ON m.id=s.machine_id AND m.user_id=s.user_id WHERE s.user_id=? AND s.id=?`)
    .bind(user, id).first<DetailVersion>();
  return row ? detailETag(row) : null;
}

export async function findSession(db: D1Database, userId: string, id: string) {
  const [session, blocks] = await db.batch([
    sessionById(db, userId, id),
    db.prepare(`${SELECT_BLOCK} WHERE user_id = ? AND session_id = ? ORDER BY seq`).bind(userId, id),
  ]);
  return { session: session.results[0] as SessionRow | undefined, blocks: blocks.results as BlockRow[] };
}

export async function setManualTitle(
  db: D1Database,
  userId: string,
  id: string,
  title: string | null,
  expected: string | null,
  now: number,
) {
  const [, session] = await db.batch<SessionRow>([
    db.prepare(`UPDATE sessions SET manual_title = ?, updated_at = MAX(updated_at + 1, ?)
      WHERE user_id = ? AND id = ? AND manual_title IS ? AND manual_title IS NOT ?`)
      .bind(title, now, userId, id, expected, title),
    sessionById(db, userId, id),
  ]);
  return session.results[0];
}

export async function completeSession(db: D1Database, userId: string, id: string, now: number) {
  // The condition and the returned row share a transaction with respect to racing uploads/retries.
  const [, session] = await db.batch<SessionRow>([
    db.prepare(`UPDATE sessions AS s SET completed_at = MAX(?, observed_at), updated_at = MAX(updated_at + 1, ?)
      WHERE user_id = ? AND id = ? AND observed_state = 'waiting' AND (${currentCompletion}) IS NULL`)
      .bind(now, now, userId, id),
    sessionById(db, userId, id),
  ]);
  return session.results[0];
}

/** Blocks overlapping [fromMs, toMs) in started_at order, and the sessions they belong to. */
export async function findBlocks(db: D1Database, userId: string, fromMs: number, toMs: number) {
  // The second, disjoint range uses the partial index in 0004_long_blocks.
  const twoDays = 172800000;
  const recent = "user_id = ? AND started_at >= ? AND started_at < ? AND ended_at >= ?";
  const long = `user_id = ? AND ended_at - started_at > ${twoDays} AND started_at < ? AND ended_at >= ?`;
  const overlap = (select: string) => `${select} WHERE ${recent} UNION ALL ${select} WHERE ${long}`;
  const cutoff = fromMs - twoDays;
  const args = [userId, cutoff, toMs, fromMs, userId, cutoff, fromMs] as const;
  const [blocks, sessions, version] = await db.batch([
    db.prepare(`${overlap(SELECT_BLOCK)} ORDER BY started_at, session_id, seq`).bind(...args),
    db.prepare(`${SELECT_SESSION}
      WHERE s.user_id = ? AND s.id IN (${overlap("SELECT session_id FROM blocks")})
      ORDER BY s.started_at, s.id`).bind(userId, ...args),
    db.prepare("SELECT COALESCE(MAX(updated_at), 0) AS v FROM sessions WHERE user_id = ?").bind(userId),
  ]);
  return {
    sessions: sessions.results as SessionRow[],
    blocks: blocks.results as BlockRow[],
    version: (version.results[0] as { v: number }).v,
  };
}
