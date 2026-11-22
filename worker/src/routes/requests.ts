import type { Hono } from "hono";
import type { AppEnv } from "../app";

const keys = ["engine", "model", "effort", "project"] as const;
const isStage = (value: unknown) => value === "backlog" || value === "queued";

export async function listRequests(db: D1Database, user: string) {
  const rows = await db.prepare("SELECT id, title, stage, engine, model, effort, project FROM board_requests WHERE user_id=? ORDER BY updated_at, id")
    .bind(user).all();
  return rows.results;
}

export function registerRequestRoutes(app: Hono<AppEnv>, now: () => number) {
  app.put("/api/board/requests/:id", async c => {
    const principal = c.get("principal");
    if (principal.kind !== "user" || c.req.header("Origin") !== new URL(c.req.url).origin)
      return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
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
      const values = keys.map(key => body[key]?.trim() ?? null);
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
      const write = editing
        ? db.prepare(`UPDATE board_requests SET title=?,engine=?,model=?,effort=?,project=?,stage=?,updated_at=?
            WHERE user_id=? AND id=? AND title=? AND stage=? AND engine IS ? AND model IS ? AND effort IS ? AND project IS ?`)
          .bind(title,...values,body.stage,now(),user,id,expected.title,expected.stage,...keys.map(key => expected[key]))
        : db.prepare("INSERT INTO board_requests(user_id,id,title,stage,updated_at,engine,model,effort,project) VALUES(?,?,?,'backlog',?,?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING")
          .bind(user,id,title,now(),...values);
      const [, read] = await db.batch<Record<string, string | null>>([
        write,
        db.prepare("SELECT title,stage,engine,model,effort,project FROM board_requests WHERE user_id=? AND id=?").bind(user,id),
      ]);
      const stored = read.results[0];
      if (!stored) return c.json({ error: "not_found" }, 404);
      if (stored.title !== title || keys.some((key, index) => stored[key] !== values[index]) || (editing && stored.stage !== body.stage))
        return c.json({ error: "request_conflict" }, 409);
    } else {
      const stage = body.stage;
      if (!isStage(stage) || "expected" in body) return c.json({ error: "invalid_payload" }, 400);
      const [, read] = await db.batch([
        db.prepare("UPDATE board_requests SET stage=?, updated_at=? WHERE user_id=? AND id=? AND stage<>?").bind(stage,now(),user,id,stage),
        db.prepare("SELECT id FROM board_requests WHERE user_id=? AND id=?").bind(user,id),
      ]);
      if (!read.results.length) return c.json({ error: "not_found" }, 404);
    }
    return c.json({ id }, 200, { "Cache-Control": "private, no-store" });
  });
}
