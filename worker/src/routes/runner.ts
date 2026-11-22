import type { Hono } from "hono";
import type { AppEnv } from "../app";
import { claimLaunch, isUuid, reportResult, startLaunch } from "../db/launches";

function validProjects(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1024
    && value.every(p => typeof p === "string" && p.length <= 256 && p.length && p.trim() === p);
}

function validEngines(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 2 && value.every(e => e === "codex" || e === "claude_code");
}

export function registerRunnerRoutes(app: Hono<AppEnv>, now: () => number) {
  app.post("/api/board/requests/:id/start", async c => {
    const principal = c.get("principal");
    if (principal.kind !== "user" || c.req.header("Origin") !== new URL(c.req.url).origin)
      return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "invalid_id" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!isUuid(body?.attempt_id)) return c.json({ error: "invalid_payload" }, 400);
    const result = await startLaunch(c.env.DB, principal.userId, id, body.attempt_id.toLowerCase(), now());
    if (result.error) return c.json({ error: result.error }, result.error === "not_found" ? 404 : 409);
    return c.json({ id, launch: result.launch }, 200, { "Cache-Control": "private, no-store" });
  });

  app.put("/api/runner/claim", async c => {
    const principal = c.get("principal");
    if (principal.kind !== "machine") return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => null);
    if (!validProjects(body?.projects) || !validEngines(body?.engines)) return c.json({ error: "invalid_payload" }, 400);
    const job = await claimLaunch(c.env.DB, principal.userId, principal.machineId, body.projects, body.engines, now());
    return c.json({ job }, 200, { "Cache-Control": "private, no-store" });
  });

  app.put("/api/runner/result", async c => {
    const principal = c.get("principal");
    if (principal.kind !== "machine") return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => null);
    if (!isUuid(body?.attempt_id) || !["running", "completed", "failed"].includes(body.state)
      || (body.error != null && (body.state !== "failed" || typeof body.error !== "string" || body.error.length > 256)))
      return c.json({ error: "invalid_payload" }, 400);
    const state = await reportResult(c.env.DB, principal.userId, principal.machineId, body.attempt_id.toLowerCase(), body.state, body.error ?? null, now());
    if (!state) return c.json({ error: "not_found" }, 404);
    if (state !== body.state) return c.json({ error: "result_conflict" }, 409);
    return c.json({ state }, 200, { "Cache-Control": "private, no-store" });
  });
}
