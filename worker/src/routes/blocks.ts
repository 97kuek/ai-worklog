import type { Hono } from "hono";
import type { AppEnv } from "../app";
import { dataVersion, findBlocks } from "../db/repo";
import { RFC3339 } from "../domain/ingest";

const MAX_RANGE_MS = 31 * 86_400_000;

function parseTime(v: string | undefined): number | null {
  if (v === undefined || !RFC3339.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

export function registerBlockRoutes(app: Hono<AppEnv>): void {
  app.get("/api/blocks", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "user") return c.json({ error: "forbidden" }, 403);

    const from = parseTime(c.req.query("from"));
    const to = parseTime(c.req.query("to"));
    if (from === null || to === null || to <= from || to - from > MAX_RANGE_MS) {
      return c.json({ error: "invalid_range" }, 400);
    }

    const version = await dataVersion(c.env.DB, principal.userId);
    const etag = `"${version}"`;
    const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch !== undefined && ifNoneMatch.split(",").some((t) => t.trim() === etag || t.trim() === `W/${etag}`)) {
      return new Response(null, { status: 304, headers });
    }

    const { sessions, blocks } = await findBlocks(c.env.DB, principal.userId, from, to);
    const iso = (ms: number) => new Date(ms).toISOString();
    return c.json(
      {
        version,
        sessions: sessions.map((s) => ({
          id: s.id,
          tool: s.tool,
          title: s.title,
          project: s.project,
          git_branch: s.git_branch,
          models: JSON.parse(s.models) as string[],
          invoked_by: s.invoked_by,
          machine_name: s.machine_name,
          started_at: iso(s.started_at),
          ended_at: iso(s.ended_at),
          active_minutes: s.active_minutes,
          tokens: {
            input: s.input_tokens,
            output: s.output_tokens,
            cache_read: s.cache_read_tokens,
            cache_write: s.cache_write_tokens,
          },
        })),
        blocks: blocks.map((b) => ({
          session_id: b.session_id,
          seq: b.seq,
          started_at: iso(b.started_at),
          ended_at: iso(b.ended_at),
          message_count: b.message_count,
          tokens: {
            input: b.input_tokens,
            output: b.output_tokens,
            cache_read: b.cache_read_tokens,
            cache_write: b.cache_write_tokens,
          },
        })),
      },
      200,
      headers,
    );
  });
}
