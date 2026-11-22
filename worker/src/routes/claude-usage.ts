import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../app";
import { CLAUDE_ACCOUNTS, LIMIT_WINDOWS, isClaudeAccount, type AccountUsage, type RateWindow, type LimitWindow } from "../../ui/claude-accounts";

const sessionId = /^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const clockSkewMs = 5 * 60_000;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => nonnegative(v) && Number.isSafeInteger(v);
const windowValue = (v: unknown): v is RateWindow => record(v) && nonnegative(v.used_percentage) &&
  v.used_percentage <= 100 && (v.resets_at === null || count(v.resets_at) && v.resets_at <= 253402300799);

function snapshot(v: unknown, now: number) {
  if (!record(v) || !isClaudeAccount(v.account) || typeof v.session_id !== "string" || !sessionId.test(v.session_id)
    || !count(v.observed_at) || v.observed_at > now + clockSkewMs
    || !(v.input_tokens === null || count(v.input_tokens)) || !(v.output_tokens === null || count(v.output_tokens))
    || !(v.cost_usd === null || nonnegative(v.cost_usd))
    || !(v.five_hour === null || windowValue(v.five_hour)) || !(v.seven_day === null || windowValue(v.seven_day))) return null;
  return { account: v.account, session_id: v.session_id, observed_at: v.observed_at, input_tokens: v.input_tokens,
    output_tokens: v.output_tokens, cost_usd: v.cost_usd, five_hour: v.five_hour, seven_day: v.seven_day };
}

// Token totals and cost can arrive independently, including after an offline retry.
const metrics = [["input_tokens", "input_at"], ["output_tokens", "output_at"], ["cost_usd", "cost_at"]] as const;
const assignments = metrics.flatMap(([value, at]) => [
  `${value}=CASE WHEN excluded.${at} >= ${at} THEN COALESCE(excluded.${value},${value}) ELSE ${value} END`,
  `${at}=MAX(${at}, excluded.${at})`,
]);
const sessionUpsert = `INSERT INTO claude_session_usage
  (user_id, account, session_id, observed_at, input_tokens, output_tokens, cost_usd, input_at, output_at, cost_at)
  VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, account, session_id) DO UPDATE SET
  observed_at=MAX(observed_at, excluded.observed_at), ${assignments.join(", ")}`;

export function registerClaudeUsageRoutes(app: Hono<AppEnv>, now: () => number) {
  app.put("/api/claude-usage", bodyLimit({ maxSize: 4096, onError: c => c.json({ error: "payload_too_large" }, 413) }), async c => {
    const p = c.get("principal");
    if (p.kind !== "machine") return c.json({ error: "forbidden" }, 403);
    const row = snapshot(await c.req.json().catch(() => null), now());
    if (!row) return c.json({ error: "invalid_payload" }, 400);
    const db = c.env.DB;
    const writes = [db.prepare(sessionUpsert)
      .bind(p.userId, row.account, row.session_id, row.observed_at, row.input_tokens, row.output_tokens, row.cost_usd,
        row.input_tokens === null ? 0 : row.observed_at, row.output_tokens === null ? 0 : row.observed_at,
        row.cost_usd === null ? 0 : row.observed_at)];
    for (const key of LIMIT_WINDOWS) {
      const limit = row[key];
      if (!limit) continue;
      writes.push(db.prepare(`INSERT INTO claude_rate_windows
        (user_id, account, window, observed_at, used_percentage, resets_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id, account, window) DO UPDATE SET observed_at=excluded.observed_at,
          used_percentage=excluded.used_percentage, resets_at=excluded.resets_at WHERE excluded.observed_at >= observed_at`)
        .bind(p.userId, row.account, key, row.observed_at, limit.used_percentage, limit.resets_at));
    }
    await db.batch(writes);
    return c.json({ ok: true });
  });

  app.get("/api/claude-usage", async c => {
    const p = c.get("principal");
    if (p.kind !== "user") return c.json({ error: "forbidden" }, 403);
    const db = c.env.DB;
    const [totals, windows] = await Promise.all([
      db.prepare(`SELECT account, MAX(observed_at) AS observed_at, COUNT(*) AS sessions, SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd, COUNT(cost_usd) AS cost_sessions
        FROM claude_session_usage WHERE user_id=? GROUP BY account`).bind(p.userId).all<Omit<AccountUsage, LimitWindow>>(),
      db.prepare("SELECT account, window, observed_at, used_percentage, resets_at FROM claude_rate_windows WHERE user_id=?")
        .bind(p.userId).all<RateWindow & { account: string; window: LimitWindow; observed_at: number }>(),
    ]);
    const accounts: AccountUsage[] = CLAUDE_ACCOUNTS.map(account => {
      const total = totals.results.find(row => row.account === account) ?? {
        account, observed_at: null, sessions: 0, input_tokens: null, output_tokens: null, cost_usd: null, cost_sessions: 0,
      };
      const latest = (key: LimitWindow) => {
        const window = windows.results.find(row => row.account === account && row.window === key);
        if (!window) return null;
        const { used_percentage, observed_at, resets_at } = window;
        return { used_percentage, observed_at, resets_at };
      };
      return { ...total, five_hour: latest("five_hour"), seven_day: latest("seven_day") };
    });
    return c.json({ accounts }, 200, { "Cache-Control": "private, no-store" });
  });
}
