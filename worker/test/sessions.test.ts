import { env } from "cloudflare:test";
import example from "../../contract/ingest.example.json";
import { LIMITS } from "../src/domain/ingest";
import { testApp } from "./helpers";

const H = "Cf-Access-Jwt-Assertion";
const NOW = 1_800_000_000_000;

type Payload = typeof example;
const fresh = (): Payload => structuredClone(example);

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM blocks"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM machines"),
    env.DB.prepare("DELETE FROM users"),
  ]);
});

async function put(body: unknown, opts: { user?: boolean; headers?: Record<string, string> } = {}) {
  const { app, userToken, machineToken } = await testApp({ now: () => NOW });
  const token = opts.user ? await userToken() : await machineToken();
  return app.request(
    "/api/sessions",
    {
      method: "PUT",
      headers: { [H]: token, "Content-Type": "application/json", ...opts.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}

it("saves_sessions_and_blocks", async () => {
  const res = await put(example);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, number>;
  expect(body.sessions).toBe(2);
  expect(body.blocks).toBe(3);
  expect(await count("sessions")).toBe(2);
  expect(await count("blocks")).toBe(3);
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE native_session_id = ?")
    .bind("example-claude-1")
    .first<Record<string, unknown>>();
  expect(s!.models).toBe('["claude-opus-5-5"]');
  expect(s!.started_at).toBe(Date.UTC(2026, 10, 20, 1, 0, 0));
  expect(s!.input_tokens).toBe(120);
});

it("is_idempotent_and_writes_nothing_on_resend", async () => {
  await put(example);
  const res = await put(example);
  expect(res.status).toBe(200);
  expect(((await res.json()) as Record<string, number>).rows_changed).toBe(1);
  expect(await count("sessions")).toBe(2);
  expect(await count("blocks")).toBe(3);
});

it("updates_changed_blocks_only", async () => {
  await put(example);
  const p = fresh();
  p.sessions[0]!.blocks[1]!.ended_at = "2026-11-20T02:30:00.000Z";
  p.sessions[0]!.blocks[1]!.message_count = 9;
  p.sessions[0]!.ended_at = "2026-11-20T02:30:00.000Z";
  const res = await put(p);
  expect(res.status).toBe(200);
  expect(((await res.json()) as Record<string, number>).rows_changed).toBe(3);
  const b = await env.DB.prepare(
    "SELECT b.* FROM blocks b JOIN sessions s ON s.id = b.session_id WHERE s.native_session_id = ? AND b.seq = 1",
  )
    .bind("example-claude-1")
    .first<Record<string, number>>();
  expect(b!.ended_at).toBe(Date.UTC(2026, 10, 20, 2, 30, 0));
  expect(b!.message_count).toBe(9);
});

it("deletes_blocks_that_no_longer_exist", async () => {
  await put(example);
  const p = fresh();
  p.sessions[0]!.blocks = p.sessions[0]!.blocks.slice(0, 1);
  const res = await put(p);
  expect(res.status).toBe(200);
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM blocks b JOIN sessions s ON s.id = b.session_id WHERE s.native_session_id = ?",
  )
    .bind("example-claude-1")
    .first<{ n: number }>();
  expect(row!.n).toBe(1);
});

it("keeps_the_title_when_null_is_sent", async () => {
  await put(example);
  const p = fresh();
  (p.sessions[0] as { title: string | null }).title = null;
  await put(p);
  const row = await env.DB.prepare("SELECT title FROM sessions WHERE native_session_id = ?")
    .bind("example-claude-1")
    .first<{ title: string | null }>();
  expect(row!.title).toBe("見本の作業");
});

it("updates_machine_name_and_last_seen", async () => {
  await put(example);
  const row = await env.DB.prepare("SELECT name, last_seen_at FROM machines").first<{
    name: string;
    last_seen_at: number;
  }>();
  expect(row!.name).toBe("example-mac");
  expect(row!.last_seen_at).toBe(NOW);
});

it("rejects_users", async () => {
  const res = await put(example, { user: true });
  expect(res.status).toBe(403);
  expect(await count("sessions")).toBe(0);
  expect(await count("blocks")).toBe(0);
});

it("rejects_invalid_payload_without_partial_writes", async () => {
  const p = fresh();
  p.sessions[1]!.blocks[0]!.seq = 5;
  const res = await put(p);
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_payload", path: "sessions[1].blocks[0].seq" });
  expect(await count("sessions")).toBe(0);
});

it("rejects_non_json", async () => {
  const res = await put("{");
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_payload", path: "" });
});

it("rejects_too_large_bodies", async () => {
  const declared = await put(example, { headers: { "Content-Length": String(LIMITS.maxBodyBytes + 1) } });
  expect(declared.status).toBe(413);
  const { app, machineToken } = await testApp({ now: () => NOW });
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(" ".repeat(LIMITS.maxBodyBytes + 1)));
      c.close();
    },
  });
  const actual = await app.request(
    "/api/sessions",
    {
      method: "PUT",
      headers: { [H]: await machineToken(), "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit,
    env,
  );
  expect(actual.status).toBe(413);
  expect(await count("sessions")).toBe(0);
});

it("keeps_users_apart", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('u2', 'other@example.com', 1)"),
    env.DB.prepare(
      "INSERT INTO machines (id, user_id, access_client_id, created_at) VALUES ('m2', 'u2', 'other.access', 1)",
    ),
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, machine_id, tool, native_session_id, title, models, started_at, ended_at,
        active_minutes, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, updated_at)
       VALUES ('s2', 'u2', 'm2', 'claude_code', 'example-claude-1', 'theirs', '[]', 1, 2, 0, 7, 7, 7, 7, 1)`,
    ),
  ]);
  const res = await put(example);
  expect(res.status).toBe(200);
  expect(await count("sessions")).toBe(3);
  const theirs = await env.DB.prepare("SELECT title, input_tokens, updated_at FROM sessions WHERE id = 's2'").first();
  expect(theirs).toEqual({ title: "theirs", input_tokens: 7, updated_at: 1 });
});
