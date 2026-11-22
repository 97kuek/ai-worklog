const ONLINE_FOR = 2 * 60_000;
const CLAIM_WITHIN = 10 * 60_000;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

export async function listRunnerProjects(db: D1Database, user: string, now: number) {
  const { results } = await db.prepare(`SELECT DISTINCT p.value AS project FROM machines m
    JOIN board_runners b ON b.machine_id=m.id CROSS JOIN json_each(b.projects) p
    WHERE m.user_id=? AND b.seen_at>? ORDER BY project`).bind(user, now - ONLINE_FOR).all<{ project: string }>();
  return results.map(p => p.project);
}

export async function listRequests(db: D1Database, user: string, now: number) {
  const rows = await db.prepare(`SELECT r.id,r.title,r.stage,r.engine,r.model,r.effort,r.project,
      j.attempt_id,j.state,j.error,j.state_since
    FROM board_requests r LEFT JOIN board_launches j ON j.seq=(
      SELECT seq FROM board_launches WHERE user_id=r.user_id AND request_id=r.id ORDER BY seq DESC LIMIT 1)
    WHERE r.user_id=? ORDER BY r.updated_at,r.id`).bind(user).all<{
      id: string; title: string; stage: string; engine: string | null; model: string | null;
      effort: string | null; project: string | null; attempt_id: string | null;
      state: string | null; error: string | null; state_since: number | null;
    }>();
  return rows.results.map(({ attempt_id, state, error, state_since, ...card }) => {
    if (!attempt_id) return card;
    const expired = (state === "pending" || state === "claimed") && state_since! <= now - CLAIM_WITHIN;
    const launch = expired ? { attempt_id, state: "failed", error: "runner_timeout" } : { attempt_id, state, error };
    return { ...card, launch };
  });
}

export const requestLocked = `EXISTS (
  SELECT 1 FROM board_launches WHERE user_id=board_requests.user_id
    AND request_id=board_requests.id AND state<>'failed')`;

// The runner must receive a successful running acknowledgment before launching.
// Expired claims can therefore fail safely. Running jobs never expire or get reclaimed.
export function expireUnstarted(db: D1Database, user: string, now: number) {
  return db.prepare(`UPDATE board_launches SET state='failed',error='runner_timeout'
    WHERE user_id=? AND state IN ('pending','claimed') AND state_since<=?`).bind(user, now - CLAIM_WITHIN);
}

export async function startLaunch(db: D1Database, user: string, request: string, attempt: string, now: number) {
  const [, , attemptRead, cardRead] = await db.batch<{
    request_id: string; attempt_id: string; state: string; error: string | null;
    stage: string; engine: string | null; project: string | null; locked: number;
  }>([
    expireUnstarted(db, user, now),
    db.prepare(`INSERT INTO board_launches
      (user_id,request_id,attempt_id,machine_id,title,project,engine,model,effort,state,state_since)
      SELECT r.user_id,r.id,?,m.id,r.title,r.project,r.engine,r.model,r.effort,'pending',?
      FROM board_requests r JOIN machines m ON m.user_id=r.user_id
      JOIN board_runners b ON b.machine_id=m.id
      WHERE r.user_id=? AND r.id=? AND r.stage='queued' AND b.seen_at>?
        AND r.engine IN ('codex','claude_code')
        AND r.project IN (SELECT value FROM json_each(b.projects))
        AND r.engine IN (SELECT value FROM json_each(b.engines))
      ORDER BY b.seen_at DESC, m.id LIMIT 1
      ON CONFLICT DO NOTHING`).bind(attempt, now, user, request, now - ONLINE_FOR),
    db.prepare("SELECT request_id,attempt_id,state,error FROM board_launches WHERE user_id=? AND attempt_id=?")
      .bind(user, attempt),
    db.prepare(`SELECT stage,engine,project,${requestLocked} AS locked FROM board_requests WHERE user_id=? AND id=?`)
      .bind(user, request),
  ]);
  const card = cardRead.results[0];
  if (!card) return { error: "not_found" } as const;
  const job = attemptRead.results[0];
  if (job && job.request_id === request) {
    const { attempt_id, state, error } = job;
    return { launch: { attempt_id, state, error } } as const;
  }
  if (job || card.locked) return { error: "launch_conflict" } as const;
  if (card.stage !== "queued") return { error: "not_queued" } as const;
  if (!card.project) return { error: "project_required" } as const;
  if (!card.engine) return { error: "engine_required" } as const;
  return { error: "runner_unavailable" } as const;
}

export async function claimLaunch(db: D1Database, user: string, machine: string, projects: string[], engines: string[], now: number) {
  const capabilities = [JSON.stringify(projects), JSON.stringify(engines)];
  const [, , claimed] = await db.batch([
    expireUnstarted(db, user, now),
    db.prepare(`INSERT INTO board_runners(machine_id,projects,engines,seen_at) VALUES(?,?,?,?)
      ON CONFLICT(machine_id) DO UPDATE SET projects=excluded.projects,engines=excluded.engines,seen_at=excluded.seen_at`)
      .bind(machine, ...capabilities, now),
    db.prepare(`UPDATE board_launches SET state='claimed',state_since=?
      WHERE seq=(SELECT seq FROM board_launches WHERE user_id=? AND machine_id=? AND state='pending'
        AND project IN (SELECT value FROM json_each(?))
        AND engine IN (SELECT value FROM json_each(?)) ORDER BY seq LIMIT 1)
      RETURNING attempt_id,request_id,title,project,engine,model,effort`)
      .bind(now, user, machine, ...capabilities),
  ]);
  return claimed.results[0] ?? null;
}

export async function reportResult(db: D1Database, user: string, machine: string, attempt: string, state: string, error: string | null, now: number) {
  const [, , read] = await db.batch<{ state: string }>([
    expireUnstarted(db, user, now),
    db.prepare(`UPDATE board_launches SET state=?,error=? WHERE user_id=? AND machine_id=? AND attempt_id=?
      AND ((state='claimed' AND ? IN ('running','failed')) OR (state='running' AND ? IN ('failed','completed')))`)
      .bind(state, error, user, machine, attempt, state, state),
    db.prepare("SELECT state FROM board_launches WHERE user_id=? AND machine_id=? AND attempt_id=?")
      .bind(user, machine, attempt),
  ]);
  return read.results[0]?.state;
}
