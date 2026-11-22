import type { Hono } from "hono";
import { etag } from "hono/etag";
import type { AppEnv } from "../app";
import { findBlocks } from "../db/repo";
import { RFC3339 } from "../domain/ingest";
import { serializeBlock, serializeSession } from "./serialize";

const MAX_RANGE_MS = 31 * 86_400_000;

function parseTime(v: string | undefined): number | null {
  if (v === undefined || !RFC3339.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

export function registerBlockRoutes(app: Hono<AppEnv>): void {
  app.get("/api/blocks", etag(), async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "user") return c.json({ error: "forbidden" }, 403);

    const from = parseTime(c.req.query("from"));
    const to = parseTime(c.req.query("to"));
    if (from === null || to === null || to <= from || to - from > MAX_RANGE_MS) {
      return c.json({ error: "invalid_range" }, 400);
    }

    const { sessions, blocks, version } = await findBlocks(c.env.DB, principal.userId, from, to);
    return c.json(
      { version, sessions: sessions.map(serializeSession), blocks: blocks.map(serializeBlock) },
      200,
      { "Cache-Control": "private, no-cache" },
    );
  });
}
