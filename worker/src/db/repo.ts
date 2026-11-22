import type { IngestPayload } from "../domain/ingest";

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

/** Returns the id of the machine with this Access client id, creating it if needed (race-safe). */
export async function ensureMachine(
  db: D1Database,
  userId: string,
  accessClientId: string,
  now: number,
): Promise<string> {
  const [, found] = await db.batch<{ id: string }>([
    db
      .prepare(
        "INSERT INTO machines (id, user_id, access_client_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(access_client_id) DO NOTHING",
      )
      .bind(crypto.randomUUID(), userId, accessClientId, now),
    db.prepare("SELECT id FROM machines WHERE access_client_id = ?").bind(accessClientId),
  ]);
  return found.results[0]!.id;
}

const SESSION_COLUMNS = [
  "machine_id",
  "title",
  "project",
  "cwd",
  "git_branch",
  "models",
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

// `title` keeps the stored value when the new one is null.
const sessionAssignments = SESSION_COLUMNS.map((c) =>
  c === "title" ? "title = COALESCE(excluded.title, sessions.title)" : `${c} = excluded.${c}`,
).join(", ");
const sessionDiffers = SESSION_COLUMNS.map((c) =>
  c === "title" ? "sessions.title IS NOT COALESCE(excluded.title, sessions.title)" : `sessions.${c} IS NOT excluded.${c}`,
).join(" OR ");
const blockAssignments = BLOCK_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
const blockDiffers = BLOCK_COLUMNS.map((c) => `blocks.${c} IS NOT excluded.${c}`).join(" OR ");

const SESSION_ID = "(SELECT id FROM sessions WHERE user_id = ? AND tool = ? AND native_session_id = ?)";

/**
 * Upserts the machine's name, every session and its blocks in one batch (one transaction).
 * Unchanged rows are not written. `rowsChanged` sums `meta.changes` over the batch.
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
          `INSERT INTO sessions (id, user_id, tool, native_session_id, ${SESSION_COLUMNS.join(", ")}, updated_at)
           VALUES (?, ?, ?, ?, ${SESSION_COLUMNS.map(() => "?").join(", ")}, ?)
           ON CONFLICT (user_id, tool, native_session_id) DO UPDATE SET ${sessionAssignments}, updated_at = excluded.updated_at
           WHERE ${sessionDiffers}`,
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
          s.invoked_by,
          s.started_at,
          s.ended_at,
          s.active_minutes,
          s.tokens.input,
          s.tokens.output,
          s.tokens.cache_read,
          s.tokens.cache_write,
          now,
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
            b.started_at,
            b.ended_at,
            b.message_count,
            b.tokens.input,
            b.tokens.output,
            b.tokens.cache_read,
            b.tokens.cache_write,
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
  const results = await db.batch(stmts);
  return { rowsChanged: results.reduce((n, r) => n + (r.meta.changes ?? 0), 0) };
}
