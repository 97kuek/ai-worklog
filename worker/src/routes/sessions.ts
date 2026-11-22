import type { Hono } from "hono";
import type { AppEnv } from "../app";
import { saveSessions } from "../db/repo";
import { LIMITS, parseIngestPayload } from "../domain/ingest";

export function registerSessionRoutes(app: Hono<AppEnv>, now: () => number): void {
  app.put("/api/sessions", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "machine") return c.json({ error: "forbidden" }, 403);

    const declared = Number(c.req.header("Content-Length"));
    if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) return c.json({ error: "payload_too_large" }, 413);

    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > LIMITS.maxBodyBytes) return c.json({ error: "payload_too_large" }, 413);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid_payload", path: "", message: "body must be valid JSON" }, 400);
    }
    const parsed = parseIngestPayload(json);
    if (!parsed.ok) return c.json({ error: "invalid_payload", path: parsed.path, message: parsed.message }, 400);

    const { rowsChanged } = await saveSessions(
      c.env.DB,
      { userId: principal.userId, machineId: principal.machineId },
      parsed.value,
      now(),
    );
    return c.json({
      sessions: parsed.value.sessions.length,
      blocks: parsed.value.sessions.reduce((n, s) => n + s.blocks.length, 0),
      rows_changed: rowsChanged,
    });
  });
}
