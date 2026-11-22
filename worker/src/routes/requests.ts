import type { Hono } from "hono";
import type { AppEnv } from "../app";
import { expireUnstarted, isUuid, listRequests, requestLocked } from "../db/launches";

const keys = ["engine", "model", "effort", "project"] as const;
const isStage = (value: unknown) => value === "backlog" || value === "queued";

// The write and its diagnostic read run in the same D1 transaction. Stage-only
// moves validate the stored settings, and full edits validate the proposed ones.
function queueValidation(user: string, stage: string, settings?: [string | null, string | null]) {
  if (stage !== "queued") return { sql: "NULL", args: [] };
  const choice = settings ? "SELECT ?,?" : "SELECT board_requests.project,board_requests.engine";
  return {
    sql: `(WITH choice(project,engine) AS (${choice}), registered AS (
      SELECT b.engines FROM board_runners b JOIN machines m ON m.id=b.machine_id, choice
      WHERE m.user_id=? AND choice.project IN (SELECT value FROM json_each(b.projects))
    ) SELECT CASE
      WHEN choice.project IS NULL THEN 'project_required'
      WHEN choice.engine IS NULL THEN 'engine_required'
      WHEN NOT EXISTS (SELECT 1 FROM registered) THEN 'project_unregistered'
      WHEN NOT EXISTS (SELECT 1 FROM registered, json_each(registered.engines) e WHERE e.value=choice.engine)
        THEN 'engine_unavailable'
    END FROM choice)`,
    args: [...(settings ?? []), user],
  };
}

export function registerRequestRoutes(app: Hono<AppEnv>, now: () => number) {
  app.get("/api/board/requests", async c => {
    const principal = c.get("principal");
    if (principal.kind !== "user") return c.json({ error: "forbidden" }, 403);
    const requests = await listRequests(c.env.DB, principal.userId, now());
    return c.json({ requests }, 200, { "Cache-Control": "private, no-store" });
  });

  app.put("/api/board/requests/:id", async c => {
    const principal = c.get("principal");
    if (principal.kind !== "user" || c.req.header("Origin") !== new URL(c.req.url).origin)
      return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    if (!isUuid(id))
      return c.json({ error: "invalid_id" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "invalid_payload" }, 400);
    const user = principal.userId;
    const db = c.env.DB;
    if ("title" in body) {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const editing = "expected" in body;
      if (!title || title.length > 200 || (editing ? !isStage(body.stage) : "stage" in body)) return c.json({ error: "invalid_payload" }, 400);
      for (const key of keys) {
        const value = body[key];
        if (value != null && (typeof value !== "string" || !value.trim() || value.length > 256))
          return c.json({ error: "invalid_payload" }, 400);
      }
      const values = keys.map((key): string | null => body[key]?.trim() ?? null);
      const [engine, model, effort, project] = values;
      const expected = body.expected;
      if (editing && (!expected || typeof expected.title !== "string" || !isStage(expected.stage)
        || keys.some(key => expected[key] !== null && typeof expected[key] !== "string")))
        return c.json({ error: "invalid_payload" }, 400);
      // Older cards can move without a project until their contents are edited.
      const movingLegacy = editing && expected.project === null && expected.title === title
        && keys.every((key, i) => expected[key] === values[i]);
      if (!project && !movingLegacy) return c.json({ error: "project_required" }, 400);
      if ((engine !== null && engine !== "codex" && engine !== "claude_code") || (!engine && (model || effort)))
        return c.json({ error: "invalid_payload" }, 400);
      const check = queueValidation(user, editing ? body.stage : "backlog", [project, engine]);
      const write = editing
        ? db.prepare(`UPDATE board_requests SET title=?,engine=?,model=?,effort=?,project=?,stage=?,updated_at=?
            WHERE user_id=? AND id=? AND title=? AND stage=? AND engine IS ? AND model IS ? AND effort IS ? AND project IS ? AND NOT ${requestLocked} AND ${check.sql} IS NULL`)
          .bind(title,...values,body.stage,now(),user,id,expected.title,expected.stage,...keys.map(key => expected[key]),...check.args)
        : db.prepare("INSERT INTO board_requests(user_id,id,title,stage,updated_at,engine,model,effort,project) VALUES(?,?,?,'backlog',?,?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING")
          .bind(user,id,title,now(),...values);
      const [, , read] = await db.batch<Record<string, string | number | null>>([
        expireUnstarted(db, user, now()),
        write,
        db.prepare(`SELECT title,stage,engine,model,effort,project,${requestLocked} AS locked,${check.sql} AS queue_error FROM board_requests WHERE user_id=? AND id=?`).bind(...check.args,user,id),
      ]);
      const stored = read.results[0];
      if (!stored) return c.json({ error: "not_found" }, 404);
      if (editing && stored.locked) return c.json({ error: "launch_conflict" }, 409);
      if (editing && stored.queue_error) return c.json({ error: stored.queue_error }, 409);
      if (stored.title !== title || keys.some((key, index) => stored[key] !== values[index]) || (editing && stored.stage !== body.stage))
        return c.json({ error: "request_conflict" }, 409);
    } else {
      const stage = body.stage;
      if (!isStage(stage) || "expected" in body) return c.json({ error: "invalid_payload" }, 400);
      const check = queueValidation(user, stage);
      const [, , read] = await db.batch<{ locked: number; queue_error: string | null }>([
        expireUnstarted(db, user, now()),
        db.prepare(`UPDATE board_requests SET stage=?, updated_at=? WHERE user_id=? AND id=? AND stage<>? AND NOT ${requestLocked} AND ${check.sql} IS NULL`).bind(stage,now(),user,id,stage,...check.args),
        db.prepare(`SELECT ${requestLocked} AS locked,${check.sql} AS queue_error FROM board_requests WHERE user_id=? AND id=?`).bind(...check.args,user,id),
      ]);
      if (!read.results.length) return c.json({ error: "not_found" }, 404);
      if (read.results[0]!.locked) return c.json({ error: "launch_conflict" }, 409);
      if (read.results[0]!.queue_error) return c.json({ error: read.results[0]!.queue_error }, 409);
    }
    return c.json({ id }, 200, { "Cache-Control": "private, no-store" });
  });
}
