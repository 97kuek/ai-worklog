import { env } from "cloudflare:test";
import example from "../../contract/ingest.example.json";
import { testApp } from "./helpers";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://worklog.example";
const DAY = "/api/blocks?from=2026-11-20T00:00:00Z&to=2026-11-21T00:00:00Z";

type Session = {
  id: string;
  tool: string;
  title: string | null;
  manual_title: string | null;
  model_efforts: { model: string; effort: string | null }[];
  observed_status?: { state: string; at: string };
  completed_at: string | null;
};

beforeEach(async () => {
  await env.DB.batch(["board_requests", "blocks", "sessions", "machines", "users"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

async function setup() {
  let now = NOW;
  const { app, userToken, machineToken } = await testApp({ now: () => now });
  const user = await userToken();
  const machine = await machineToken();
  function request(path: string, token = user, options: RequestInit = {}) {
    return app.request(ORIGIN + path, {
      ...options,
      headers: { "Cf-Access-Jwt-Assertion": token, ...options.headers },
    }, env);
  }
  async function upload(sessions: unknown[], name = example.machine_name) {
    const res = await request("/api/sessions", machine, {
      method: "PUT",
      body: JSON.stringify({ machine_name: name, sessions }),
    });
    expect(res.status).toBe(200);
  }
  const post = { method: "POST", headers: { Origin: ORIGIN } };
  async function board() {
    const response = await request("/api/board");
    expect(response.status).toBe(200);
    return response.json<{ sessions: Session[] }>();
  }
  const register = (project: string) => request("/api/runner/claim", machine, {
    method: "PUT", body: JSON.stringify({ projects: [project], engines: ["codex"] }),
  });
  return { request, upload, board, post, user, machine, register, tick: () => { now += 1; } };
}

it("lists historical, unknown and unobserved sessions and reads every block of a session", async () => {
  const { upload, request, board } = await setup();
  const old = {
    ...example.sessions[0]!,
    native_session_id: "old",
    observed_status: { state: "unknown", at: "2025-01-02T00:00:00Z" },
    started_at: "2025-01-01T00:00:00Z",
    ended_at: "2026-01-01T00:00:00Z",
    blocks: [
      { ...example.sessions[0]!.blocks[0]!, started_at: "2025-01-01T00:00:00Z", ended_at: "2025-01-01T00:20:00Z" },
      { ...example.sessions[0]!.blocks[1]!, started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:00:00Z" },
    ],
  };
  await upload([...example.sessions, old]);
  const { sessions } = await board();
  expect(sessions).toHaveLength(3);
  const historical = sessions.find((s) => s.observed_status?.state === "unknown")!;
  expect(historical).toMatchObject({ completed_at: null });
  expect(sessions.find((s) => s.tool === "codex")).not.toHaveProperty("observed_status");
  const detail = await request(`/api/sessions/${historical.id}`);
  const data = await detail.json<{ session: Session; blocks: { seq: number }[] }>();
  expect(data.session).toEqual(historical);
  expect(data.blocks.map((b) => b.seq)).toEqual([0, 1]);
});

it("preserves model efforts on legacy uploads and replaces them on explicit uploads", async () => {
  const { upload, request, board, post } = await setup();
  const { model_efforts, ...legacy } = example.sessions[0]!;
  const pairs = [...model_efforts, { model: legacy.models[0]!, effort: "high" }];
  await upload([legacy]);
  const initial = (await board()).sessions[0]!;
  expect(initial.model_efforts).toEqual([]);
  await upload([{ ...legacy, model_efforts: pairs }]);
  await upload([{ ...legacy, title: "legacy update" }]);
  const session = (await board()).sessions[0]!;
  expect(session).toMatchObject({ title: "legacy update", model_efforts: pairs });
  const path = `/api/sessions/${initial.id}`;
  expect((await (await request(path)).json<{ session: Session }>()).session).toEqual(session);
  expect((await (await request(DAY)).json<{ sessions: Session[] }>()).sessions).toEqual([session]);
  const completed = await request(`${path}/complete`, undefined, post);
  expect((await completed.json<{ session: Session }>()).session.model_efforts).toEqual(pairs);
  await upload([{ ...legacy, model_efforts: [] }]);
  expect((await board()).sessions[0]!.model_efforts).toEqual([]);
});

it("keeps completion through duplicate requests and legacy or newer machine updates", async () => {
  const { upload, request, board, post, tick } = await setup();
  const { observed_status, ...legacy } = example.sessions[0]!;
  await upload([example.sessions[0]]);
  const id = (await board()).sessions[0]!.id;
  const path = `/api/sessions/${id}/complete`;
  const originalTag = (await request(DAY)).headers.get("ETag")!;
  const first = await request(path, undefined, post);
  expect(first.status).toBe(200);
  const expected = new Date(NOW).toISOString();
  expect((await first.json<{ session: Session }>()).session.completed_at).toBe(expected);
  const refresh = await request(DAY, undefined, { headers: { "If-None-Match": originalTag } });
  expect(refresh.status).toBe(200);
  expect((await refresh.json<{ sessions: Session[] }>()).sessions[0]!.completed_at).toBe(expected);
  const completedTag = refresh.headers.get("ETag")!;
  tick();
  expect((await request(path, undefined, post)).status).toBe(200);
  expect((await request(DAY, undefined, { headers: { "If-None-Match": completedTag } })).status).toBe(304);
  await upload([{ ...legacy, title: "updated by legacy client", completed_at: null }]);
  expect((await board()).sessions[0]).toMatchObject({ observed_status, completed_at: expected });
  await upload([{ ...legacy, observed_status: { state: "running", at: "2026-11-22T10:00:00Z" } }]);
  expect(await (await request("/api/board?status=running")).json()).toEqual({ sessions: [] });
  const retry = await request(path, undefined, post);
  expect(retry.status).toBe(200);
  expect((await retry.json<{ session: Session }>()).session).toMatchObject({
    observed_status: { state: "running" }, completed_at: expected,
  });
  expect(await env.DB.prepare("SELECT completed_at FROM sessions WHERE id = ?").bind(id).first("completed_at")).toBe(NOW);
});

it("permits only owned, observed waiting sessions to be completed from the same origin", async () => {
  const { upload, board, request, user, machine, post } = await setup();
  const waiting = example.sessions[0]!;
  const others = ["running", "unknown"].map((state) => ({
    ...waiting, native_session_id: state, observed_status: { ...waiting.observed_status, state },
  }));
  await upload([...example.sessions, ...others]);
  const { sessions } = await board();
  const active = sessions.filter((s) => s.observed_status?.state === "running");
  expect(active).toHaveLength(1);
  expect(await (await request("/api/board?status=running")).json()).toEqual({ sessions: active });
  const id = sessions.find((s) => s.observed_status?.state === "waiting")!.id;
  const detail = `/api/sessions/${id}`;
  const path = `${detail}/complete`;
  for (const s of sessions.filter((s) => s.id !== id)) {
    const res = await request(`/api/sessions/${s.id}/complete`, user, post);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_waiting" });
  }
  for (const origin of [undefined, "null", "https://elsewhere.example"]) {
    expect((await request(path, user, { method: "POST", headers: origin ? { Origin: origin } : {} })).status).toBe(403);
  }
  expect((await request(path, machine, post)).status).toBe(403);
  expect((await request(detail, machine)).status).toBe(403);
  expect((await request("/api/board", machine)).status).toBe(403);
  expect((await request(path, "", post)).status).toBe(401);
  expect((await request("/api/sessions/absent/complete", user, post)).status).toBe(404);

  // Use the same DB with a different owner to exercise tenant filters on all three routes.
  const other = { ...env, OWNER_EMAIL: "other@example.com" };
  const { app: otherApp, userToken, machineToken } = await testApp();
  const headers = { "Cf-Access-Jwt-Assertion": await userToken(other.OWNER_EMAIL), Origin: ORIGIN };
  expect(await (await otherApp.request(ORIGIN + "/api/board", { headers }, other)).json()).toEqual({ sessions: [], requests: [] });
  expect((await otherApp.request(ORIGIN + detail, { headers }, other)).status).toBe(404);
  expect((await otherApp.request(ORIGIN + path, { method: "POST", headers }, other)).status).toBe(404);
  const sameClientId = await machineToken();
  const register = await otherApp.request(ORIGIN + "/api/me", { headers: { "Cf-Access-Jwt-Assertion": sameClientId } }, other);
  expect(register.status).toBe(403);
  expect((await board()).sessions.every((s) => s.completed_at === null)).toBe(true);
});


function titleUpdate(title: unknown, expected: unknown): RequestInit {
  return { method: "PUT", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ title, expected }) };
}

it("retains the owner's title across uploads and shows the latest generated title after a reset", async () => {
  const { upload, request, board, post, tick } = await setup();
  const generated = example.sessions[0]!;
  await upload([generated]);
  const initial = (await board()).sessions[0]!;
  expect(initial).toMatchObject({ title: generated.title, manual_title: null });
  const path = `/api/sessions/${initial.id}`;
  const originalTag = (await request(DAY)).headers.get("ETag")!;
  tick();
  const edit = titleUpdate("  手動の名前　", null);
  const edited = await request(`${path}/title`, undefined, edit);
  expect(edited.status).toBe(200);
  expect(edited.headers.get("Cache-Control")).toBe("private, no-store");
  const named = { title: "手動の名前", manual_title: "手動の名前" };
  expect((await edited.json<{ session: Session }>()).session).toMatchObject(named);

  const updated = await request(DAY, undefined, { headers: { "If-None-Match": originalTag } });
  expect(updated.status).toBe(200);
  const day = await updated.json<{ sessions: Session[]; version: number }>();
  expect(day.sessions[0]).toMatchObject(named);
  expect(day.version).toBe(NOW + 1);
  const tag = updated.headers.get("ETag")!;
  tick();
  expect((await request(`${path}/title`, undefined, edit)).status).toBe(200);
  expect((await request(DAY, undefined, { headers: { "If-None-Match": tag } })).status).toBe(304);

  await upload([{ ...generated, title: "新しい自動名", manual_title: "機械からの上書き" }]);
  await upload([{ ...generated, title: null }]);
  expect((await board()).sessions[0]).toMatchObject(named);
  expect((await (await request(path)).json<{ session: Session }>()).session).toMatchObject(named);
  const complete = await request(`${path}/complete`, undefined, post);
  expect((await complete.json<{ session: Session }>()).session).toMatchObject(named);
  const reset = titleUpdate(null, "手動の名前");
  const restored = await request(`${path}/title`, undefined, reset);
  expect((await restored.json<{ session: Session }>()).session).toMatchObject({ title: "新しい自動名", manual_title: null });
  expect((await request(`${path}/title`, undefined, reset)).status).toBe(200);
});

it("detects concurrent and stale title edits and permits switching back to an untitled session", async () => {
  const { upload, request, board } = await setup();
  await upload([{ ...example.sessions[0], title: null }]);
  const path = `/api/sessions/${(await board()).sessions[0]!.id}/title`;
  const edits = ["first", "second"];
  const responses = await Promise.all(edits.map(title => request(path, undefined, titleUpdate(title, null))));
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const winner = edits[responses.findIndex(r => r.status === 200)]!;
  const loser = edits.find(t => t !== winner)!;
  expect(await responses.find(r => r.status === 409)!.json()).toEqual({ error: "title_conflict" });
  expect((await request(path, undefined, titleUpdate(null, loser))).status).toBe(409);
  expect((await board()).sessions[0]!.manual_title).toBe(winner);
  const restored = await request(path, undefined, titleUpdate(null, winner));
  expect((await restored.json<{ session: Session }>()).session).toMatchObject({ title: null, manual_title: null });
});

it("validates manual names and permits only a same-origin request from the owning user", async () => {
  const { upload, board, request, machine, user } = await setup();
  await upload([example.sessions[0]]);
  const path = `/api/sessions/${(await board()).sessions[0]!.id}/title`;
  const valid = titleUpdate("🟣".repeat(100), null);
  for (const body of ["{", "null", "[]", "{}", '{"title":null}', '{"expected":null}', '{"title":false,"expected":null}']) {
    expect((await request(path, user, { ...valid, body })).status).toBe(400);
  }
  for (const [title, expected] of [["   ", null], ["🟣".repeat(101), null], ["ok", 2], ["ok", "a".repeat(201)]]) {
    expect((await request(path, user, titleUpdate(title, expected))).status).toBe(400);
  }
  for (const origin of ["", "null", "https://elsewhere.example"]) {
    const headers = { "Content-Type": "application/json", ...(origin && { Origin: origin }) };
    expect((await request(path, user, { ...valid, headers })).status).toBe(403);
  }
  expect((await request(path, machine, valid)).status).toBe(403);
  expect((await request(path, "", valid)).status).toBe(401);
  expect((await request("/api/sessions/missing/title", user, valid)).status).toBe(404);
  const other = { ...env, OWNER_EMAIL: "other@example.com" };
  const { app: otherApp, userToken } = await testApp();
  const headers = { ...valid.headers, "Cf-Access-Jwt-Assertion": await userToken(other.OWNER_EMAIL) };
  expect((await otherApp.request(ORIGIN + path, { ...valid, headers }, other)).status).toBe(404);
  expect((await board()).sessions[0]!.manual_title).toBeNull();
  expect((await request(path, user, valid)).status).toBe(200);
  expect((await board()).sessions[0]!.manual_title).toBe("🟣".repeat(100));
});

it("persists owner planning requests, retries additions and moves without starting a session", async () => {
  const { request, user, machine, register } = await setup();
  await register("demo");
  const id = crypto.randomUUID();
  const path = "/api/board/requests/" + id;
  const change = (body: object, token = user, origin = ORIGIN) => request(path, token, {
    method: "PUT", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  expect((await change({ title: "Plan" }, machine)).status).toBe(403);
  expect((await change({ title: "Plan" }, user, "https://other.example")).status).toBe(403);
  expect((await change({ title: "  " })).status).toBe(400);
  expect((await change({ stage: "queued" })).status).toBe(404);
  const metadata = { engine: "codex", model: "GPT", effort: "high", project: "demo" };
  for (const project of [null, "", "  "])
    expect((await change({ title: "Plan", project })).status).toBe(400);
  expect((await change({ title: "Plan" })).status).toBe(400);
  expect((await change({ title: "Plan", project: "demo", engine: "invalid" })).status).toBe(400);
  expect((await change({ title: "Plan", project: "demo", effort: "high" })).status).toBe(400);
  expect((await change({ title: " Plan ", ...metadata })).status).toBe(200);
  expect((await change({ title: "Plan", ...metadata, project: "other" })).status).toBe(409);
  expect((await change({ title: "Different", ...metadata })).status).toBe(409);
  expect((await change({ stage: "invalid" })).status).toBe(400);
  expect((await change({ stage: "queued" })).status).toBe(200);
  expect((await change({ title: "Plan", ...metadata })).status).toBe(200);
  expect((await change({ stage: "queued" })).status).toBe(200);
  expect(await (await request("/api/board")).json()).toEqual({ sessions: [], runnerProjects: ["demo"], requests: [{ id, title: "Plan", ...metadata, stage: "queued", wait_reason: "next_poll" }] });
  expect(await (await request("/api/board?status=running")).json()).toEqual({ sessions: [] });
  expect((await change({ stage: "backlog" })).status).toBe(200);
  expect(await (await request("/api/board")).json()).toEqual({ sessions: [], runnerProjects: ["demo"], requests: [{ id, title: "Plan", ...metadata, stage: "backlog" }] });
});

it("saves planning edits and lane changes atomically, including retries and stale editors", async () => {
  const { request, register } = await setup();
  await register("api");
  const id = crypto.randomUUID();
  const put = (body: object) => request("/api/board/requests/" + id, undefined, {
    method: "PUT", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const fields = { title: "Original", project: "api", engine: "codex", model: "GPT", effort: "high" };
  const original = { ...fields, stage: "backlog" };
  const edited = { ...fields, title: "Updated", stage: "queued" };
  expect((await put({ ...edited, expected: original })).status).toBe(404);
  expect((await put(fields)).status).toBe(200);
  expect((await put({ ...edited, project: null, expected: original })).status).toBe(400);
  expect((await put({ ...edited, expected: original })).status).toBe(200);
  expect((await put({ ...edited, expected: original })).status).toBe(200);
  expect((await put({ ...original, title: "Stale", expected: original })).status).toBe(409);
  expect(await (await request("/api/board")).json()).toMatchObject({ requests: [{ id, ...edited }] });
  expect((await put({ ...original, expected: edited })).status).toBe(200);
});

it("reopens previously completed work across Board, Office and task details, and can complete it again", async () => {
  const { request, upload, board, post } = await setup();
  const original = example.sessions[0]!;
  await upload([original]);
  const id = (await board()).sessions[0]!.id;
  const path = "/api/sessions/" + id;
  const complete = () => request(path + "/complete", undefined, post);
  const list = async (url: string) => (await (await request(url)).json<{ sessions: Session[] }>()).sessions;
  expect((await complete()).status).toBe(200);
  const weekAgo = NOW - 7 * 86400_000;
  await env.DB.prepare("UPDATE sessions SET completed_at = ?, observed_at = ? WHERE id = ?")
    .bind(weekAgo, weekAgo, id).run();
  expect(await list("/api/board/updates")).toEqual([]);
  const at = (n: number) => new Date(NOW + n).toISOString();
  await upload([{ ...original, observed_status: { state: "running", at: at(1) } }]);
  const active = [{ id, completed_at: null, observed_status: { state: "running" } }];
  for (const endpoint of ["/api/board", "/api/board/updates", "/api/board?status=running"]) {
    expect(await list(endpoint)).toMatchObject(active);
  }
  expect(await (await request(path)).json()).toMatchObject({ session: active[0] });
  expect((await complete()).status).toBe(409);
  await upload([{ ...original, observed_status: { state: "waiting", at: at(2) } }]);
  expect(await list("/api/board?status=running")).toEqual([]);
  expect(await list("/api/board/updates")).toMatchObject([{ id, completed_at: null, observed_status: { state: "waiting" } }]);
  expect((await complete()).status).toBe(200);
  expect(await list("/api/board/updates")).toMatchObject([{ id, completed_at: at(2) }]);
});

it("polls both terminal engines through running, waiting and completion without returning hidden history", async () => {
  const { request, upload, post, machine } = await setup();
  const path = "/api/board/updates";
  const stamp = (delta: number) => new Date(NOW + delta).toISOString();
  const inputs = example.sessions.map(session => ({ ...session, observed_status: { state: "running", at: stamp(-2) } }));
  async function poll() {
    const response = await request(path);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    return response.json<{ sessions: Session[]; requests: unknown[] }>();
  }
  expect((await request(path, machine)).status).toBe(403);
  await upload([...inputs, { ...inputs[0], native_session_id: "unknown", observed_status: { state: "unknown", at: stamp(-2) } }]);
  const running = await poll();
  expect(running.requests).toEqual([]);
  expect(running.sessions.map(s => s.tool).sort()).toEqual(["claude_code", "codex"]);
  expect(running.sessions.every(s => s.observed_status?.state === "running")).toBe(true);
  await upload(inputs.map(s => ({ ...s, observed_status: { state: "waiting", at: stamp(-1) } })));
  const waiting = await poll();
  expect(waiting.sessions).toHaveLength(2);
  for (const session of waiting.sessions) {
    expect(session.observed_status?.state).toBe("waiting");
    expect((await request("/api/sessions/" + session.id + "/complete", undefined, post)).status).toBe(200);
  }
  expect((await poll()).sessions.map(s => s.completed_at)).toEqual([stamp(0), stamp(0)]);
  const old = waiting.sessions[0]!;
  await env.DB.prepare("UPDATE sessions SET completed_at = ?1, observed_at = ?1 WHERE id = ?2").bind(NOW - 7 * 24 * 3600_000, old.id).run();
  expect((await poll()).sessions.map(s => s.id)).not.toContain(old.id);
  expect((await request("/api/sessions/" + old.id)).status).toBe(200);
});

it("loads current request defaults from history independently of board visibility", async () => {
  const { request, upload, register, machine } = await setup();
  const path = "/api/board/request-options";
  const options = async () => {
    const r = await request(path);
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    return r.json<{ runnerProjects: string[]; recent: { project: string; tool: string; models: string[] }[];
      available: { tool: string; models: string[] }[] }>();
  };
  expect((await request(path, machine)).status).toBe(403);
  expect(await options()).toEqual({ runnerProjects: [], pausedProjects: [], recent: [], available: [] });
  const earlier = example.sessions[1]!;
  await upload([earlier]);
  await register("registered");
  expect((await options()).recent).toMatchObject([{ project: earlier.project, models: earlier.models }]);
  const later = { ...earlier, native_session_id: "later", ended_at: "2026-11-20T03:00:00Z",
    models: ["new-model"], model_efforts: [{ model: "new-model", effort: "low" }] };
  await upload([later, example.sessions[0]!]);
  const latest = await options();
  expect(latest.runnerProjects).toEqual(["registered"]);
  expect(latest.recent).toMatchObject([
    { project: earlier.project, tool: "codex", models: later.models, model_efforts: later.model_efforts },
    { project: earlier.project, tool: "claude_code" },
  ]);
  expect(latest.available.filter(x => x.tool === "codex").flatMap(x => x.models).sort()).toEqual([...earlier.models, ...later.models].sort());
  expect(await (await request("/api/board/updates")).json()).toMatchObject({ sessions: [{ tool: "claude_code" }] });
});

it("skips unchanged task details, including after identical uploads", async () => {
  const { request, upload, board, post, machine } = await setup();
  const initial = example.sessions[0]!;
  await upload([initial]);
  const path = "/api/sessions/" + (await board()).sessions[0]!.id;
  let tag = (await request(path)).headers.get("ETag")!;
  expect(tag).toBeTruthy();
  const conditional = () => request(path, undefined, { headers: { "If-None-Match": tag } });
  const changed = async () => {
    const r = await conditional();
    expect(r.status).toBe(200);
    expect(r.headers.get("ETag")).not.toBe(tag);
    tag = r.headers.get("ETag")!;
    return r.json<{ blocks: { message_count: number }[] }>();
  };
  await upload([initial]);
  const same = await conditional();
  expect(same.status).toBe(304);
  expect(await same.text()).toBe("");
  expect((await request(path, machine, { headers: { "If-None-Match": tag } })).status).toBe(403);
  const edited = { ...initial, blocks: initial.blocks.map(b => ({ ...b, message_count: b.message_count + 1 })) };
  await upload([edited]);
  expect((await changed()).blocks[0]!.message_count).toBe(edited.blocks[0]!.message_count);
  const shorter = { ...edited, blocks: edited.blocks.slice(0, 1) };
  await upload([shorter]);
  expect((await changed()).blocks).toHaveLength(1);
  await upload([shorter], "Renamed Mac");
  await changed();
  expect((await request(path + "/complete", undefined, post)).status).toBe(200);
  await changed();
  expect((await conditional()).status).toBe(304);
});

it("searches all weeks by displayed title or project, with literal matching and stable pagination", async () => {
  const { upload, request, machine } = await setup();
  const base = example.sessions[0]!;
  const history = Array.from({ length: 32 }, (_, i) => ({
    ...base, native_session_id: "search-" + i, title: "Search " + i, project: "Archive_100%",
    started_at: "2025-01-01T00:00:00Z", ended_at: "2025-01-01T01:00:00Z",
    blocks: [{ ...base.blocks[0]!, started_at: "2025-01-01T00:00:00Z", ended_at: "2025-01-01T01:00:00Z" }],
  }));
  await upload(history);
  const search = (query: string) => request("/api/sessions/search?" + query);
  const query = new URLSearchParams({ q: "archive_100%" });
  type Page = { sessions: { id: string }[]; next: { start: number; id: string } | null };
  const first = await (await search(query.toString())).json<Page>();
  expect(first.sessions).toHaveLength(30);
  query.set("before", String(first.next!.start));
  query.set("id", first.next!.id);
  const second = await (await search(query.toString())).json<Page>();
  expect(second.next).toBeNull();
  expect(new Set([...first.sessions, ...second.sessions].map(s => s.id)).size).toBe(32);
  const id = first.sessions[0]!.id;
  await request("/api/sessions/" + id + "/title", undefined, titleUpdate("手動の名前", null));
  expect((await (await search("q=" + encodeURIComponent("手動"))).json<Page>()).sessions).toMatchObject([{ id }]);
  expect((await (await search("q=ARCHIVE_1%25")).json<Page>()).sessions).toHaveLength(0);
  expect((await search("q=&before=x")).status).toBe(400);
  expect((await request("/api/sessions/search?q=archive", machine)).status).toBe(403);
});
