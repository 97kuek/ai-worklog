import { ONLINE_FOR } from "./launches";

export async function listMachines(db: D1Database, user: string, now: number) {
  const { results } = await db.prepare(`SELECT m.id, m.name, b.seen_at, b.engines,
      m.test_requested_at, m.test_acknowledged_at,
      (SELECT json_group_object(tool, received_at) FROM machine_log_receipts WHERE machine_id=m.id) AS log_received_at,
      (SELECT json_group_array(json_object('key',project,'enabled',enabled)) FROM (
        SELECT DISTINCT project,enabled FROM runner_projects WHERE machine_id=m.id ORDER BY project
      )) AS projects
    FROM machines m LEFT JOIN board_runners b ON b.machine_id=m.id
    WHERE m.user_id=? ORDER BY m.created_at,m.id`).bind(user).all<{
    id: string; name: string | null; seen_at: number | null; engines: string | null;
    projects: string; log_received_at: string; test_requested_at: number | null; test_acknowledged_at: number | null;
  }>();
  return results.map(m => ({
    id: m.id,
    name: m.name?.trim() || "Mac " + m.id.slice(0, 8),
    seen_at: m.seen_at,
    log_received_at: JSON.parse(m.log_received_at) as Record<string, number>,
    online: m.seen_at !== null && m.seen_at > now - ONLINE_FOR,
    projects: (JSON.parse(m.projects) as { key: string; enabled: number }[]).map(p => ({ key: p.key, enabled: !!p.enabled })),
    engines: [...new Set<string>(JSON.parse(m.engines ?? "[]"))].sort(),
    connection_test: m.test_requested_at === null ? null : {
      requested_at: m.test_requested_at, acknowledged_at: m.test_acknowledged_at,
    },
  }));
}

export function setProjectEnabled(db: D1Database, user: string, machine: string, project: string, enabled: boolean) {
  return db.prepare(`INSERT INTO runner_project_settings(machine_id,project,enabled)
    SELECT DISTINCT m.id,p.project,? FROM machines m JOIN runner_projects p ON p.machine_id=m.id
    WHERE m.user_id=? AND m.id=? AND p.project=?
    ON CONFLICT(machine_id,project) DO UPDATE SET enabled=excluded.enabled
    RETURNING machine_id`).bind(+enabled, user, machine, project).first<string>("machine_id");
}

export function requestConnectionTest(db: D1Database, user: string, machine: string, now: number) {
  // Share an outstanding test across tabs until the UI retry window opens.
  return db.prepare(`UPDATE machines SET test_requested_at=CASE WHEN test_acknowledged_at IS NULL AND test_requested_at>?
      THEN test_requested_at ELSE ? END, test_acknowledged_at=NULL
    WHERE user_id=? AND id=? RETURNING test_requested_at`).bind(now - 90_000, now, user, machine).first<number>("test_requested_at");
}
