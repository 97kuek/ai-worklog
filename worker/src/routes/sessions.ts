import type { Hono } from "hono";
import type { AppEnv } from "../app";
import { listRequests, listRunnerProjects } from "../db/launches";
import { completeSession, findSession, listBoardSessions, saveSessions, setManualTitle } from "../db/repo";
import { LIMITS, parseIngestPayload } from "../domain/ingest";
import { serializeBlock, serializeSession } from "./serialize";

function parseManualTitle(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const title = value.trim();
  return title.length > 0 && title.length <= 200 ? title : undefined;
}

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

  app.get("/api/board", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "user") return c.json({ error: "forbidden" }, 403);

    const status = c.req.query("status");
    if (status !== undefined && status !== "running") return c.json({ error: "invalid_status" }, 400);
    const sessions = await listBoardSessions(c.env.DB, principal.userId, status);
    const headers = { "Cache-Control": "private, no-store" };
    const board = { sessions: sessions.map(serializeSession) };
    if (status) return c.json(board, 200, headers);
    const time = now();
    const [requests, projects] = await Promise.all([
      listRequests(c.env.DB, principal.userId, time),
      listRunnerProjects(c.env.DB, principal.userId, time),
    ]);
    return c.json({ ...board, requests, runnerProjects: projects.length ? projects : undefined }, 200, headers);
  });

  app.get("/api/sessions/:id", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "user") return c.json({ error: "forbidden" }, 403);

    const { session, blocks } = await findSession(c.env.DB, principal.userId, c.req.param("id"));
    if (!session) return c.json({ error: "not_found" }, 404);
    return c.json(
      { session: serializeSession(session), blocks: blocks.map(serializeBlock) },
      200,
      { "Cache-Control": "private, no-store" },
    );
  });

  app.put("/api/sessions/:id/title", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "user" || c.req.header("Origin") !== new URL(c.req.url).origin) {
      return c.json({ error: "forbidden" }, 403);
    }

    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || !("title" in body) || !("expected" in body)) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const title = parseManualTitle(body.title);
    const expected = parseManualTitle(body.expected);
    if (title === undefined || expected === undefined || expected !== body.expected) {
      return c.json({ error: "invalid_payload" }, 400);
    }

    const session = await setManualTitle(c.env.DB, principal.userId, c.req.param("id"), title, expected, now());
    if (!session) return c.json({ error: "not_found" }, 404);
    if (session.manual_title !== title) return c.json({ error: "title_conflict" }, 409);
    return c.json({ session: serializeSession(session) }, 200, { "Cache-Control": "private, no-store" });
  });

  app.post("/api/sessions/:id/complete", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "user" || c.req.header("Origin") !== new URL(c.req.url).origin) {
      return c.json({ error: "forbidden" }, 403);
    }

    const session = await completeSession(c.env.DB, principal.userId, c.req.param("id"), now());
    if (!session) return c.json({ error: "not_found" }, 404);
    if (session.completed_at === null) return c.json({ error: "not_waiting" }, 409);
    return c.json({ session: serializeSession(session) }, 200, { "Cache-Control": "private, no-store" });
  });
}
