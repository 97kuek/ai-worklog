import { completedBoardWindow } from "../../ui/board-retention";

export const ONLINE_FOR = 2 * 60_000;
const CLAIM_WITHIN = 10 * 60_000;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

export async function listRunnerProjects(db: D1Database, user: string) {
  const { results } = await db.prepare(`SELECT DISTINCT p.project FROM machines m
    JOIN runner_projects p ON p.machine_id=m.id
    WHERE m.user_id=? AND p.enabled=1 ORDER BY p.project`).bind(user).all<{ project: string }>();
  return results.map(p => p.project);
}

const latestQueueLaunch = `LEFT JOIN board_launches j ON j.seq=(
  SELECT seq FROM board_launches WHERE user_id=r.user_id AND request_id=r.id AND seq>r.queue_after_launch
  ORDER BY seq DESC LIMIT 1)`;

export async function listRequests(db: D1Database, user: string, now: number) {
  // A running provider holds the runner until it exits, even if its last poll is old.
  const rows = await db.prepare(`WITH runners AS (
      SELECT p.*, EXISTS (SELECT 1 FROM board_launches active WHERE active.machine_id=p.machine_id
        AND (active.state='running' OR (active.state='claimed' AND active.state_since>?))) AS busy
      FROM runner_projects p JOIN machines m ON m.id=p.machine_id WHERE m.user_id=?
    )
    SELECT r.id,r.title,r.stage,r.engine,r.model,r.effort,r.project,
      CASE WHEN r.stage='queued' AND (j.seq IS NULL OR j.state='pending') THEN (
        SELECT CASE
          WHEN MAX(NOT busy AND seen_at>?) THEN 'next_poll'
          WHEN MAX(busy) THEN 'mac_busy'
          ELSE 'waiting_for_mac' END
        FROM runners WHERE project=r.project AND enabled=1
          AND (j.seq IS NULL OR machine_id=j.machine_id)
          AND r.engine IN (SELECT value FROM json_each(runners.engines))
        HAVING COUNT(*)>0
      ) END AS wait_reason,
      j.attempt_id,j.state,j.error,j.state_since
    FROM board_requests r ${latestQueueLaunch}
    WHERE r.user_id=? AND (j.state IS NOT 'completed' OR j.state_since>?)
    ORDER BY r.queue_position,r.updated_at,r.id`).bind(now - CLAIM_WITHIN, user, now - ONLINE_FOR, user, now - completedBoardWindow).all<{
      id: string; title: string; stage: string; engine: string | null; model: string | null;
      effort: string | null; project: string | null; attempt_id: string | null;
      state: string | null; error: string | null; state_since: number | null; wait_reason: string | null;
    }>();
  return rows.results.map(({ attempt_id, state, error, state_since, wait_reason, ...card }) => {
    const reason = wait_reason ?? "check_settings";
    if (!attempt_id) return card.stage === "queued" ? { ...card, wait_reason: reason } : card;
    const expired = (state === "pending" || state === "claimed") && state_since! <= now - CLAIM_WITHIN;
    const launch = expired ? { attempt_id, state: "failed", error: "runner_timeout" } : { attempt_id, state, error };
    return launch.state === "pending" ? { ...card, launch, wait_reason: reason } : { ...card, launch };
  });
}

export const requestLocked = `EXISTS (
  SELECT 1 FROM board_launches WHERE user_id=board_requests.user_id
    AND request_id=board_requests.id AND state<>'failed')`;

// The runner must receive a successful running acknowledgment before launching.
// Expired claims can therefore fail safely. Running jobs never expire or get reclaimed.
export function expireUnstarted(db: D1Database, user: string, now: number) {
  return db.prepare(`UPDATE board_launches SET state='failed',error='runner_timeout',state_since=state_since+?
    WHERE user_id=? AND state IN ('pending','claimed') AND state_since<=?`).bind(CLAIM_WITHIN, user, now - CLAIM_WITHIN);
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
      JOIN runner_projects b ON b.machine_id=m.id AND b.project=r.project AND b.enabled=1
      WHERE r.user_id=? AND r.id=? AND r.stage='queued' AND b.seen_at>?
        AND r.engine IN ('codex','claude_code')
        AND r.engine IN (SELECT value FROM json_each(b.engines))
      ORDER BY EXISTS (SELECT 1 FROM board_launches assigned WHERE assigned.user_id=r.user_id
        AND assigned.machine_id=m.id AND assigned.state IN ('pending','claimed','running')),
        b.seen_at DESC, m.id LIMIT 1
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

export async function claimLaunch(db: D1Database, user: string, machine: string, projects: string[], engines: string[], autoQueue: boolean, now: number, machineName?: string) {
  const capabilities = [JSON.stringify(projects), JSON.stringify(engines)];
  const statements = [
    expireUnstarted(db, user, now),
    db.prepare(`UPDATE machines SET name=coalesce(?,name),
        test_acknowledged_at=CASE WHEN test_acknowledged_at IS NULL AND test_requested_at<=?
          THEN ? ELSE test_acknowledged_at END
      WHERE id=? AND (name IS NOT coalesce(?,name) OR (test_acknowledged_at IS NULL AND test_requested_at<=?))`)
      .bind(machineName ?? null, now, now, machine, machineName ?? null, now),
    db.prepare(`INSERT INTO board_runners(machine_id,projects,engines,seen_at) VALUES(?,?,?,?)
      ON CONFLICT(machine_id) DO UPDATE SET projects=excluded.projects,engines=excluded.engines,seen_at=excluded.seen_at`)
      .bind(machine, ...capabilities, now),
  ];
  // A manual pending launch can already occupy the first eligible slot. Its
  // unique constraint wins, so both protocols claim the same existing attempt.
  if (autoQueue) {
    statements.push(db.prepare(`INSERT INTO board_launches
      (user_id,request_id,attempt_id,machine_id,title,project,engine,model,effort,state,state_since)
      SELECT r.user_id,r.id,?,?,r.title,r.project,r.engine,r.model,r.effort,'pending',?
      FROM board_requests r ${latestQueueLaunch}
      JOIN runner_projects p ON p.machine_id=? AND p.project=r.project AND p.enabled=1
      WHERE r.user_id=? AND r.stage='queued'
        AND r.engine IN (SELECT value FROM json_each(p.engines))
        AND (j.seq IS NULL OR (j.machine_id=? AND j.state='pending'))
        AND NOT EXISTS (SELECT 1 FROM board_launches WHERE machine_id=? AND state IN ('claimed','running'))
      ORDER BY r.queue_position LIMIT 1 ON CONFLICT DO NOTHING`)
      .bind(crypto.randomUUID(), machine, now, machine, user, machine, machine));
  }
  statements.push(db.prepare(`UPDATE board_launches SET state='claimed',state_since=?
      WHERE seq=(SELECT j.seq FROM board_launches j JOIN board_requests r ON r.user_id=j.user_id AND r.id=j.request_id
        JOIN runner_projects p ON p.machine_id=j.machine_id AND p.project=j.project AND p.enabled=1
        WHERE j.user_id=? AND j.machine_id=? AND j.state='pending'
        AND j.engine IN (SELECT value FROM json_each(p.engines))
        AND NOT EXISTS (SELECT 1 FROM board_launches WHERE machine_id=? AND state IN ('claimed','running'))
        ORDER BY r.queue_position,j.seq LIMIT 1)
      RETURNING attempt_id,request_id,title,project,engine,model,effort`)
    .bind(now, user, machine, machine));
  const batch = await db.batch(statements);
  return batch[batch.length - 1]!.results[0] ?? null;
}

export async function reportResult(db: D1Database, user: string, machine: string, attempt: string, state: string, error: string | null, now: number) {
  const statements = [expireUnstarted(db, user, now)];
  if (state === "running") {
    // A prepared job may be resumed from the Mac's journal after the owner
    // disabled its project. The runner waits for this acknowledgment to spawn.
    statements.push(db.prepare(`UPDATE board_launches SET state='failed',error='project_disabled',state_since=?
      WHERE user_id=? AND machine_id=? AND attempt_id=? AND state='claimed'
        AND project IN (SELECT project FROM runner_project_settings WHERE machine_id=? AND enabled=0)`)
      .bind(now, user, machine, attempt, machine));
  }
  statements.push(db.prepare(`UPDATE board_launches SET state=?,error=?,state_since=? WHERE user_id=? AND machine_id=? AND attempt_id=?
    AND ((state='claimed' AND ? IN ('running','failed')) OR (state='running' AND ? IN ('failed','completed')))`)
    .bind(state, error, now, user, machine, attempt, state, state));
  if (state === "running") {
    const activeMachine = `(SELECT machine_id FROM board_launches
      WHERE user_id=? AND machine_id=? AND attempt_id=? AND state='running')`;
    statements.push(
      db.prepare(`UPDATE board_runners SET seen_at=? WHERE seen_at<? AND machine_id=${activeMachine}`)
        .bind(now, now, user, machine, attempt),
      db.prepare(`UPDATE machines SET test_acknowledged_at=? WHERE test_acknowledged_at IS NULL
        AND test_requested_at<=? AND id=${activeMachine}`).bind(now, now, user, machine, attempt),
    );
  }
  const batch = await db.batch<{ state: string }>([
    ...statements,
    db.prepare("SELECT state FROM board_launches WHERE user_id=? AND machine_id=? AND attempt_id=?")
      .bind(user, machine, attempt),
  ]);
  return batch[batch.length - 1]!.results[0]?.state;
}
