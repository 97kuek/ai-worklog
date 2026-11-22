import { env } from "cloudflare:test";
import example from "../../contract/ingest.example.json";
import { testApp } from "./helpers";

const H = "Cf-Access-Jwt-Assertion";
const NOW = 1_800_000_000_000;
const DAY = "from=2026-11-20T00:00:00Z&to=2026-11-21T00:00:00Z";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM blocks"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM machines"),
    env.DB.prepare("DELETE FROM users"),
  ]);
});

async function seed(payload: unknown = example, now = NOW): Promise<void> {
  const { app, machineToken } = await testApp({ now: () => now });
  const res = await app.request(
    "/api/sessions",
    {
      method: "PUT",
      headers: { [H]: await machineToken(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    env,
  );
  expect(res.status).toBe(200);
}

async function get(query: string, headers: Record<string, string> = {}, asMachine = false) {
  const { app, userToken, machineToken } = await testApp({ now: () => NOW });
  const token = asMachine ? await machineToken() : await userToken();
  return app.request(`/api/blocks?${query}`, { headers: { [H]: token, ...headers } }, env);
}

type Body = {
  version: number;
  sessions: Record<string, unknown>[];
  blocks: { session_id: string; seq: number; started_at: string }[];
};

it("returns_blocks_in_range_with_their_sessions", async () => {
  await seed();
  const res = await get(DAY);
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
  expect(res.headers.get("ETag")).toMatch(/^".+"$/);
  const body = (await res.json()) as Body;
  expect(body.version).toBe(NOW);
  expect(body.blocks.map((b) => b.started_at)).toEqual([
    "2026-11-20T01:00:00.000Z",
    "2026-11-20T01:05:00.000Z",
    "2026-11-20T02:00:00.000Z",
  ]);
  expect(body.sessions).toHaveLength(2);
  for (const s of body.sessions) expect(s).not.toHaveProperty("cwd");
  const claude = body.sessions.find((s) => s.tool === "claude_code")!;
  expect(claude).toEqual({
    id: body.blocks[0]!.session_id,
    tool: "claude_code",
    title: "見本の作業",
    manual_title: null,
    project: "demo",
    git_branch: "main",
    models: ["claude-opus-5-5"],
    model_efforts: [{ model: "claude-opus-5-5", effort: null }],
    invoked_by: null,
    machine_name: "example-mac",
    completed_at: null,
    observed_status: { state: "waiting", at: "2026-11-20T02:10:00.000Z" },
    started_at: "2026-11-20T01:00:00.000Z",
    ended_at: "2026-11-20T02:10:00.000Z",
    active_minutes: 30,
    tokens: { input: 120, output: 80, cache_read: 1000, cache_write: 200 },
  });
  expect(body.blocks[0]).toEqual({
    session_id: claude.id,
    seq: 0,
    started_at: "2026-11-20T01:00:00.000Z",
    ended_at: "2026-11-20T01:20:00.000Z",
    message_count: 6,
    tokens: { input: 100, output: 60, cache_read: 800, cache_write: 200 },
  });
});

it("includes_blocks_that_started_before_the_range", async () => {
  await seed();
  const body = (await (await get("from=2026-11-20T01:10:00Z&to=2026-11-20T01:30:00Z")).json()) as Body;
  expect(body.blocks.map((b) => b.seq)).toEqual([0]);
  expect(body.blocks[0]!.started_at).toBe("2026-11-20T01:00:00.000Z");
  expect(body.sessions).toHaveLength(1);
});

it("includes a long block that started more than two days before the report exactly once", async () => {
  const data = structuredClone(example);
  const session = data.sessions[0]!;
  session.started_at = "2026-11-16T00:00:00Z";
  session.blocks[0]!.started_at = session.started_at;
  await seed(data);
  const result = (await (await get(DAY)).json()) as Body;
  const id = result.sessions.find(s => s.tool === "claude_code")!.id;
  expect(result.blocks.filter(b => b.session_id === id).map(b => b.seq)).toEqual([0, 1]);
});

it("excludes_blocks_ending_before_the_range", async () => {
  await seed();
  const body = (await (await get("from=2026-11-20T01:30:00Z&to=2026-11-20T01:50:00Z")).json()) as Body;
  expect(body.blocks).toEqual([]);
  expect(body.sessions).toEqual([]);
});

it("returns_304_when_unchanged", async () => {
  await seed();
  const first = await get(DAY);
  const etag = first.headers.get("ETag")!;
  const res = await get(DAY, { "If-None-Match": etag });
  expect(res.status).toBe(304);
  expect(res.headers.get("ETag")).toBe(etag);
  expect(await res.text()).toBe("");
});

it("changes_etag_after_new_data", async () => {
  await seed();
  const etag = (await get(DAY)).headers.get("ETag")!;
  const changed = structuredClone(example);
  changed.sessions[0]!.title = "別の題名";
  await seed(changed, NOW + 1000);
  const res = await get(DAY, { "If-None-Match": etag });
  expect(res.status).toBe(200);
  expect(res.headers.get("ETag")).not.toBe(etag);
});

it("keeps the latest observation through retries, out-of-order uploads and legacy clients", async () => {
  const { observed_status, ...legacy } = example.sessions[0]!;
  const upload = (session: object, now: number) => seed({ ...example, sessions: [session] }, now);
  const read = async () => ((await (await get(DAY)).json()) as Body).sessions[0];
  const at = "2026-11-20T02:11:00.000Z";
  const running = { ...legacy, observed_status: { state: "running", at } };
  const waiting = { ...legacy, observed_status: { state: "waiting", at: "2026-11-20T11:12:00+09:00" } };
  await upload(legacy, NOW);
  expect(await read()).not.toHaveProperty("observed_status");
  await upload(running, NOW + 1);
  expect(await read()).toHaveProperty("observed_status", { state: "running", at });
  const tag = (await get(DAY)).headers.get("ETag")!;
  await upload(waiting, NOW + 2);
  const newer = await get(DAY, { "If-None-Match": tag });
  expect(newer.status).toBe(200);
  const latest = { state: "waiting", at: "2026-11-20T02:12:00.000Z" };
  expect(((await newer.json()) as Body).sessions[0]).toHaveProperty("observed_status", latest);
  const freshTag = newer.headers.get("ETag")!;
  await upload(waiting, NOW + 3);
  await upload(running, NOW + 4);
  await upload({ ...waiting, observed_status: { ...waiting.observed_status, state: "unknown" } }, NOW + 5);
  expect((await get(DAY, { "If-None-Match": freshTag })).status).toBe(304);
  await upload({ ...legacy, title: "legacy metadata update" }, NOW + 6);
  expect(await read()).toMatchObject({ title: "legacy metadata update", observed_status: latest });
  const unknown = { state: "unknown", at: "2026-11-20T02:13:00.000Z" };
  await upload({ ...legacy, observed_status: unknown }, NOW + 7);
  expect(await read()).toHaveProperty("observed_status", unknown);
});

it("never_returns_other_users_data", async () => {
  await seed();
  const t = Date.UTC(2026, 10, 20, 1, 30);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('u2', 'other@example.com', 1)"),
    env.DB.prepare(
      "INSERT INTO machines (id, user_id, name, access_client_id, created_at) VALUES ('m2', 'u2', 'other-mac', 'other.access', 1)",
    ),
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, machine_id, tool, native_session_id, models, started_at, ended_at, active_minutes,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, updated_at)
       VALUES ('s2', 'u2', 'm2', 'claude_code', 'other-1', '[]', ?, ?, 1, 1, 1, 1, 1, ?)`,
    ).bind(t, t + 60_000, NOW + 5000),
    env.DB.prepare(
      `INSERT INTO blocks (session_id, seq, user_id, started_at, ended_at, message_count,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ('s2', 0, 'u2', ?, ?, 1, 1, 1, 1, 1)`,
    ).bind(t, t + 60_000),
  ]);
  const res = await get(DAY);
  const body = (await res.json()) as Body;
  expect(body.blocks).toHaveLength(3);
  expect(body.sessions).toHaveLength(2);
  expect(body.sessions.map((s) => s.id)).not.toContain("s2");
  expect(body.version).toBe(NOW);
});

it("rejects_machines", async () => {
  await seed();
  const res = await get(DAY, {}, true);
  expect(res.status).toBe(403);
});

it("validates_the_range", async () => {
  const bad = [
    "to=2026-11-21T00:00:00Z",
    "from=2026-11-20T00:00:00Z",
    "from=2026-11-21T00:00:00Z&to=2026-11-20T00:00:00Z",
    "from=2026-11-20T00:00:00Z&to=2026-11-20T00:00:00Z",
    "from=2026-11-01T00:00:00Z&to=2026-12-02T00:00:00.001Z",
    "from=yesterday&to=2026-11-21T00:00:00Z",
    "from=2026-11-20T00:00:00Z&to=today",
  ];
  for (const q of bad) {
    const res = await get(q);
    expect(res.status, q).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_range" });
  }
  // Exactly 31 days is allowed.
  expect((await get("from=2026-11-01T00:00:00Z&to=2026-12-02T00:00:00Z")).status).toBe(200);
});
