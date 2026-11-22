import { env } from "cloudflare:test";
import { testApp } from "./helpers";

const ORIGIN = "https://worklog.example";
const card = { title: "Review the changes", project: "demo", engine: "codex", model: "m1", effort: "high" };
const capabilities = { projects: ["demo"], engines: ["codex"] };

async function setup() {
  let clock = 1_800_000_000_000;
  const { app, userToken, machineToken } = await testApp({ now: () => clock });
  const [user, mac, otherMac] = await Promise.all([userToken(), machineToken(), machineToken("second.access")]);
  function call(path: string, token: string, method: string, body?: object, origin = ORIGIN, bindings = env) {
    return app.request(ORIGIN + path, {
      method, headers: { "Cf-Access-Jwt-Assertion": token, Origin: origin, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, bindings);
  }
  const id = crypto.randomUUID();
  const path = "/api/board/requests/" + id;
  const put = (body: object) => call(path, user, "PUT", body);
  const claim = (token = mac, caps = capabilities) => call("/api/runner/claim", token, "PUT", caps);
  const start = (attempt: string) => call(path + "/start", user, "POST", { attempt_id: attempt });
  const result = (attempt: string, state: string, token = mac, error?: string) =>
    call("/api/runner/result", token, "PUT", { attempt_id: attempt, state, error });
  async function queue() {
    expect((await claim()).status).toBe(200);
    expect((await put(card)).status).toBe(200);
    expect((await put({ stage: "queued" })).status).toBe(200);
  }
  async function board() {
    return (await call("/api/board", user, "GET")).json<{requests: {id: string; launch?: {state: string; error: string | null}}[]}>();
  }
  return { id, path, mac, otherMac, user, userToken, call, queue, put, claim, start, result, board, tick: (ms: number) => { clock += ms; } };
}

beforeEach(async () => {
  await env.DB.batch(["board_requests", "sessions", "machines", "users"].map(t => env.DB.prepare("DELETE FROM " + t)));
});

it("selects the newest eligible Mac, snapshots the card, and claims and completes it only once", async () => {
  const s = await setup();
  await s.queue();
  await s.claim(s.otherMac);
  s.tick(1);
  await s.claim();
  const attempts = [crypto.randomUUID(), crypto.randomUUID()];
  const starts = await Promise.all(attempts.map(s.start));
  expect(starts.map(r => r.status).sort()).toEqual([200, 409]);
  const attempt = attempts[starts.findIndex(r => r.status === 200)]!;
  expect(await (await s.start(attempt)).json()).toMatchObject({ launch: { attempt_id: attempt, state: "pending" } });
  expect((await s.put({ stage: "backlog" })).status).toBe(409);
  expect((await s.put({ ...card, title: "Changed", stage: "queued", expected: { ...card, stage: "queued" } })).status).toBe(409);
  expect((await s.result(attempt, "running")).status).toBe(409);
  expect(await (await s.claim(s.otherMac)).json()).toEqual({ job: null });
  expect(await (await s.claim(s.mac, { ...capabilities, projects: ["Demo"] })).json()).toEqual({ job: null });
  expect(await (await s.claim(s.mac, { ...capabilities, engines: ["claude_code"] })).json()).toEqual({ job: null });
  const claims = await Promise.all([s.claim(), s.claim()]);
  const claimed = await Promise.all(claims.map(r => r.json<{job: object | null}>()));
  expect(claimed.map(r => r.job)).toEqual(expect.arrayContaining([null, { attempt_id: attempt, request_id: s.id, ...card }]));
  expect((await s.result(attempt, "running", s.otherMac)).status).toBe(404);
  expect((await s.result(attempt, "completed")).status).toBe(409);
  expect((await s.result(attempt, "running")).status).toBe(200);
  s.tick(24 * 60 * 60_000);
  expect((await s.board()).requests[0]?.launch?.state).toBe("running");
  expect(await (await s.claim()).json()).toEqual({ job: null });
  expect((await s.start(crypto.randomUUID())).status).toBe(409);
  expect((await s.result(attempt, "running")).status).toBe(200);
  expect((await s.result(attempt, "completed")).status).toBe(200);
  expect((await s.result(attempt, "completed")).status).toBe(200);
  expect((await s.result(attempt, "failed")).status).toBe(409);
  expect((await s.board()).requests[0]?.launch?.state).toBe("completed");
  expect((await s.put({ stage: "backlog" })).status).toBe(409);
  expect((await s.start(crypto.randomUUID())).status).toBe(409);
});

it("assigns a manual start to an idle Mac while a more recently seen Mac is running", async () => {
  const s = await setup();
  await s.queue();
  await s.claim(s.otherMac);
  s.tick(1);
  await s.claim();
  const first = crypto.randomUUID();
  await s.start(first);
  await s.claim();
  expect((await s.result(first, "running")).status).toBe(200);

  const path = "/api/board/requests/" + crypto.randomUUID();
  await s.call(path, s.user, "PUT", card);
  await s.call(path, s.user, "PUT", { stage: "queued" });
  const second = crypto.randomUUID();
  expect((await s.call(path + "/start", s.user, "POST", { attempt_id: second })).status).toBe(200);
  expect(await (await s.claim(s.otherMac)).json()).toMatchObject({ job: { attempt_id: second } });
});

it("removes completed launches from both Board reads after seven days and keeps execution history", async () => {
  const s = await setup();
  await s.queue();
  const attempt = crypto.randomUUID();
  await s.start(attempt);
  await s.claim();
  await s.result(attempt, "running");
  s.tick(8 * 86_400_000);
  await s.result(attempt, "completed");
  s.tick(7 * 86_400_000 - 1);
  expect((await s.board()).requests).toHaveLength(1);
  expect((await s.result(attempt, "completed")).status).toBe(200);
  s.tick(1);
  expect((await s.board()).requests).toEqual([]);
  expect(await (await s.call("/api/board/requests", s.user, "GET")).json()).toEqual({ requests: [] });
  expect(await env.DB.prepare("SELECT state FROM board_launches WHERE attempt_id=?").bind(attempt).first("state")).toBe("completed");
  expect(await (await s.call("/api/runner/claim", s.mac, "PUT", { ...capabilities, auto_queue: true })).json()).toEqual({ job: null });
});

it("allows a fresh attempt after failure without replaying older attempt IDs, including tied timestamps", async () => {
  const s = await setup();
  await s.queue();
  await s.claim();
  const first = crypto.randomUUID();
  expect((await s.start(first)).status).toBe(200);
  await s.claim();
  expect((await s.result(first, "failed", s.mac, "engine_missing")).status).toBe(200);
  expect((await s.result(first, "failed", s.mac, "different_message")).status).toBe(200);
  const second = crypto.randomUUID();
  const queued = { ...card, stage: "queued" };
  expect((await s.put({ ...queued, title: "Revised", expected: queued })).status).toBe(200);
  expect((await s.start(second)).status).toBe(200);
  expect(await (await s.start(first)).json()).toMatchObject({ launch: { attempt_id: first, state: "failed", error: "engine_missing" } });
  expect((await s.board()).requests).toMatchObject([{ title: "Revised", launch: { attempt_id: second, state: "pending" } }]);
  expect(await (await s.claim()).json()).toMatchObject({ job: { attempt_id: second, title: "Revised" } });
  expect(await (await s.claim()).json()).toEqual({ job: null });
});

it("expires unacknowledged claims and undelivered jobs without redelivery", async () => {
  const s = await setup();
  await s.queue();
  await s.claim();
  const first = crypto.randomUUID();
  await s.start(first);
  s.tick(10 * 60_000);
  expect((await s.board()).requests[0]?.launch).toMatchObject({ state: "failed", error: "runner_timeout" });
  expect(await (await s.claim()).json()).toEqual({ job: null });
  expect(await (await s.start(first)).json()).toMatchObject({ launch: { state: "failed", error: "runner_timeout" } });
  const second = crypto.randomUUID();
  expect((await s.start(second)).status).toBe(200);
  s.tick(9 * 60_000);
  expect(await (await s.claim()).json()).toMatchObject({ job: { attempt_id: second } });
  s.tick(2 * 60_000);
  expect((await s.board()).requests[0]?.launch?.state).toBe("claimed");
  s.tick(8 * 60_000);
  expect((await s.result(second, "running")).status).toBe(409);
  expect((await s.board()).requests[0]?.launch).toMatchObject({ state: "failed", error: "runner_timeout" });
  expect((await s.put({ stage: "backlog" })).status).toBe(200);
});

it("requires a queued, configured card and a fresh exact capability advertised for the same owner", async () => {
  const s = await setup();
  const attempt = crypto.randomUUID();
  const { engine: _, model: __, effort: ___, ...plain } = card;
  expect((await s.start(attempt)).status).toBe(404);
  expect((await s.put(plain)).status).toBe(200);
  expect(await (await s.start(attempt)).json()).toEqual({ error: "not_queued" });
  expect(await (await s.put({ stage: "queued" })).json()).toEqual({ error: "engine_required" });
  const edit = { ...card, stage: "queued", expected: { ...plain, engine: null, model: null, effort: null, stage: "backlog" } };
  const other = { ...env, OWNER_EMAIL: "other@example.com" };
  await s.call("/api/runner/claim", s.otherMac, "PUT", capabilities, ORIGIN, other);
  expect(await (await s.put(edit)).json()).toEqual({ error: "project_unregistered" });
  const otherUser = await s.userToken(other.OWNER_EMAIL);
  expect((await s.call(s.path + "/start", otherUser, "POST", { attempt_id: attempt }, ORIGIN, other)).status).toBe(404);
  await s.claim(s.mac, { ...capabilities, engines: ["claude_code"] });
  expect(await (await s.put(edit)).json()).toEqual({ error: "engine_unavailable" });
  expect((await s.board()).requests[0]).toMatchObject({ ...plain, engine: null, stage: "backlog" });
  await s.claim();
  expect((await s.put(edit)).status).toBe(200);
  s.tick(2 * 60_000);
  expect(await (await s.start(attempt)).json()).toEqual({ error: "runner_unavailable" });
  await s.claim();
  expect((await s.start(attempt)).status).toBe(200);
});

it("binds an attempt to a single owner request across concurrent retries", async () => {
  const s = await setup();
  await s.queue();
  await s.claim();
  const attempt = crypto.randomUUID();
  const starts = await Promise.all([s.start(attempt), s.start(attempt.toUpperCase())]);
  for (const response of starts) {
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: s.id, launch: { attempt_id: attempt, state: "pending" } });
  }
  const path = "/api/board/requests/" + crypto.randomUUID();
  await s.call(path, s.user, "PUT", card);
  await s.call(path, s.user, "PUT", { stage: "queued" });
  const mismatch = await s.call(path + "/start", s.user, "POST", { attempt_id: attempt });
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toEqual({ error: "launch_conflict" });
  expect(await (await s.claim()).json()).toMatchObject({ job: { request_id: s.id } });
  expect(await (await s.claim()).json()).toEqual({ job: null });
});

it("polls only the owner's requests and offers distinct registered projects on the initial board", async () => {
  const s = await setup();
  const poll = "/api/board/requests";
  await s.queue();
  await s.claim(s.mac, { projects: ["beta", "alpha"], engines: ["codex"] });
  s.tick(1);
  await s.claim(s.otherMac, { projects: ["alpha", "gamma"], engines: ["claude_code"] });
  const ownerBoard = await (await s.call("/api/board", s.user, "GET")).json<{requests: unknown; runnerProjects: string[]}>();
  expect(ownerBoard.runnerProjects).toEqual(["alpha", "beta", "gamma"]);
  const read = await s.call(poll, s.user, "GET");
  expect(read.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await read.json()).toEqual({ requests: ownerBoard.requests });
  expect((await s.call(poll, s.mac, "GET")).status).toBe(403);
  expect((await s.call(poll, "", "GET")).status).toBe(401);
  const other = { ...env, OWNER_EMAIL: "other@example.com" };
  const otherUser = await s.userToken(other.OWNER_EMAIL);
  expect(await (await s.call(poll, otherUser, "GET", undefined, ORIGIN, other)).json()).toEqual({ requests: [] });
  expect(await (await s.call("/api/board", otherUser, "GET", undefined, ORIGIN, other)).json()).toEqual({ sessions: [], requests: [] });
  expect(await (await s.call("/api/board?status=running", s.user, "GET")).json()).toEqual({ sessions: [] });
  s.tick(2 * 60_000 - 1);
  expect(await (await s.call("/api/board", s.user, "GET")).json()).toMatchObject({ runnerProjects: ["alpha", "beta", "gamma"] });
  s.tick(1);
  expect(await (await s.call("/api/board", s.user, "GET")).json()).toMatchObject({ runnerProjects: ["alpha", "beta", "gamma"] });
});

it("checks principals, origin and payloads before dispatch", async () => {
  const s = await setup();
  await s.queue();
  const startPath = s.path + "/start";
  const attempt = { attempt_id: crypto.randomUUID() };
  expect((await s.call(startPath, s.mac, "POST", attempt)).status).toBe(403);
  expect((await s.call(startPath, s.user, "POST", attempt, "https://other.example")).status).toBe(403);
  expect((await s.call(startPath, s.user, "POST", attempt, "")).status).toBe(403);
  expect((await s.call(startPath, s.user, "POST", { attempt_id: "bad" })).status).toBe(400);
  expect((await s.call("/api/runner/claim", s.user, "PUT", capabilities)).status).toBe(403);
  expect((await s.call("/api/runner/result", s.user, "PUT", { ...attempt, state: "failed" })).status).toBe(403);
  expect((await s.call("/api/runner/result", s.mac, "PUT", { ...attempt, state: "pending" })).status).toBe(400);
  expect((await s.call("/api/runner/result", s.mac, "PUT", { ...attempt, state: "failed", error: "x".repeat(257) })).status).toBe(400);
  for (const caps of [{}, { ...capabilities, projects: [""] }, { ...capabilities, engines: ["other"] }, { ...capabilities, auto_queue: "yes" }]) {
    expect((await s.call("/api/runner/claim", s.mac, "PUT", caps)).status).toBe(400);
  }
});

it("processes the visible eligible FIFO after reconnect, including ties, edits and explicit retries", async () => {
  const s = await setup();
  const caps = { projects: ["demo", "other"], engines: ["codex"], auto_queue: true };
  const claim = async (projects: string[]) => (await s.call("/api/runner/claim", s.mac, "PUT", { ...caps, projects }))
    .json<{ job: { attempt_id: string; request_id: string; title: string } | null }>();
  expect((await claim(caps.projects)).job).toBeNull();
  s.tick(24 * 60 * 60_000);
  // Reverse lexical order so a timestamp/ID sort cannot accidentally pass.
  const [other, first, second] = ["3","2","1"].map(n => "00000000-0000-0000-0000-00000000000" + n) as [string, string, string];
  const put = (id: string, body: object) => s.call("/api/board/requests/" + id, s.user, "PUT", body);
  for (const id of [other, first, second]) {
    const fields = { ...card, project: id === other ? "other" : "demo" };
    expect((await put(id, fields)).status).toBe(200);
    expect((await put(id, id === second
      ? { ...fields, stage: "queued", expected: { ...fields, stage: "backlog" } }
      : { stage: "queued" })).status).toBe(200);
  }
  s.tick(1);
  const queued = { ...card, stage: "queued" };
  expect((await put(first, { ...queued, title: "Edited first", expected: queued })).status).toBe(200);
  expect((await s.board()).requests.map(r => r.id)).toEqual([other, first, second]);
  expect((await (await s.claim()).json())).toEqual({ job: null });
  const claims = await Promise.all([claim(["demo"]), claim(["demo"])]);
  expect(claims.filter(c => c.job)).toHaveLength(1);
  const job = claims.find(c => c.job)!.job!;
  expect(job).toMatchObject({ request_id: first, title: "Edited first" });
  expect((await s.result(job.attempt_id, "failed")).status).toBe(200);
  const next = (await claim(["demo"])).job!;
  expect(next.request_id).toBe(second);
  expect((await s.result(next.attempt_id, "running")).status).toBe(200);
  expect((await claim(caps.projects)).job).toBeNull();
  expect((await s.result(next.attempt_id, "completed")).status).toBe(200);
  expect((await claim(["demo"])).job).toBeNull();
  const earliest = (await claim(caps.projects)).job!;
  expect(earliest.request_id).toBe(other);
  expect((await s.result(earliest.attempt_id, "failed")).status).toBe(200);
  expect((await claim(caps.projects)).job).toBeNull();
  expect((await put(first, { stage: "backlog" })).status).toBe(200);
  expect((await put(first, { stage: "queued" })).status).toBe(200);
  expect((await s.board()).requests.at(-1)).toMatchObject({ id: first });
  expect((await s.board()).requests.at(-1)).not.toHaveProperty("launch");
  const retried = (await claim(caps.projects)).job!;
  expect(retried.request_id).toBe(first);
  expect(retried.attempt_id).not.toBe(job.attempt_id);
  s.tick(10 * 60_000);
  expect((await claim(caps.projects)).job).toBeNull();
});

it("assigns a queued request atomically across eligible Macs and a concurrent legacy start", async () => {
  const s = await setup();
  await s.queue();
  const caps = { ...capabilities, auto_queue: true };
  const manual = crypto.randomUUID();
  const [a,b] = await Promise.all([
    s.call("/api/runner/claim", s.mac, "PUT", caps),
    s.call("/api/runner/claim", s.otherMac, "PUT", caps),
    s.start(manual),
  ]);
  const claimed = await Promise.all([a,b].map(r => r.json<{job: {request_id: string} | null}>()));
  expect(claimed.filter(c => c.job)).toHaveLength(1);
  expect(claimed.find(c => c.job)?.job?.request_id).toBe(s.id);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM board_launches WHERE request_id=?").bind(s.id).first("n")).toBe(1);
});

it("validates project keys and engines on a move or an in-queue edit, even when a runner changes configuration", async () => {
  const s = await setup();
  expect((await s.put(card)).status).toBe(200);
  const move = () => s.put({ stage: "queued" });
  expect(await (await move()).json()).toEqual({ error: "project_unregistered" });
  await s.claim(s.mac, { projects: ["Demo"], engines: ["codex"] });
  expect(await (await move()).json()).toEqual({ error: "project_unregistered" });
  await s.claim(s.mac, { projects: ["demo"], engines: ["claude_code"] });
  expect(await (await move()).json()).toEqual({ error: "engine_unavailable" });
  await s.claim(s.otherMac, { projects: ["other"], engines: ["codex"] });
  expect(await (await move()).json()).toEqual({ error: "engine_unavailable" });
  await s.claim();
  s.tick(24 * 60 * 60_000);
  expect((await move()).status).toBe(200);
  const queued = { ...card, stage: "queued" };
  const update = { ...queued, title: "Edited", expected: queued };
  expect(await (await s.put({ ...update, project: "Demo" })).json()).toEqual({ error: "project_unregistered" });
  await s.claim(s.mac, { projects: ["replacement"], engines: ["codex"] });
  expect(await (await s.put(update)).json()).toEqual({ error: "project_unregistered" });
  expect((await s.board()).requests[0]).toMatchObject(queued);
  expect((await s.put({ stage: "backlog" })).status).toBe(200);
});

it("lists collectors and legacy runners, and waits for the target Mac's next authenticated poll", async () => {
  const s = await setup();
  const list = async () => (await s.call("/api/settings", s.user, "GET")).json<{ machines: {id: string; online: boolean}[] }>();
  expect(await list()).toEqual({ machines: [] });
  const { machine_id: id } = await (await s.call("/api/me", s.mac, "GET")).json<{machine_id: string}>();
  const machine = { id, name: "Mac " + id.slice(0, 8), seen_at: null, online: false, projects: [], engines: [], connection_test: null };
  expect(await list()).toEqual({ machines: [machine] });
  const path = "/api/settings/machines/" + id + "/test";
  const requested_at = 1_800_000_000_000;
  expect(await (await s.call(path, s.user, "POST", {})).json()).toEqual({ requested_at });
  s.tick(10);
  await s.claim(s.otherMac);
  await s.call("/api/me", s.mac, "GET");
  expect(await (await s.call(path, s.user, "POST", {})).json()).toEqual({ requested_at });
  expect((await list()).machines.find(m => m.id === id)).toEqual({ ...machine, connection_test: { requested_at, acknowledged_at: null } });
  s.tick(90_000 - 10);
  const refreshed = requested_at + 90_000;
  expect(await (await s.call(path, s.user, "POST", {})).json()).toEqual({ requested_at: refreshed });
  s.tick(5);
  await s.call("/api/runner/claim", s.mac, "PUT", { projects: ["demo","demo"], engines: ["codex"], machine_name: "Lab Mac" });
  expect((await list()).machines.find(m => m.id === id)).toEqual({
    ...machine, name: "Lab Mac", seen_at: refreshed + 5, online: true, engines: ["codex"],
    projects: [{ key: "demo", enabled: true }], connection_test: { requested_at: refreshed, acknowledged_at: refreshed + 5 },
  });
  s.tick(2 * 60_000);
  expect((await list()).machines.find(m => m.id === id)?.online).toBe(false);
  expect(await (await s.call(path, s.user, "POST", {})).json()).toEqual({ requested_at: refreshed + 120_005 });
});

it("keeps a busy Mac online and acknowledges connection tests only for its active attempt", async () => {
  const s = await setup();
  await s.queue();
  const attempt = crypto.randomUUID();
  await s.start(attempt);
  await s.claim();
  const startedAt = 1_800_000_000_000;
  expect((await s.result(attempt, "running")).status).toBe(200);
  await s.claim(s.otherMac);
  const macIds = await Promise.all([s.mac, s.otherMac].map(async token =>
    (await (await s.call("/api/me", token, "GET")).json<{machine_id: string}>()).machine_id));
  const [id, otherId] = macIds;
  const testPath = (machine: string) => "/api/settings/machines/" + machine + "/test";
  const list = async () => (await (await s.call("/api/settings", s.user, "GET"))
    .json<{machines: {id: string; online: boolean}[]}>()).machines;

  s.tick(120_000);
  for (const machine of macIds) await s.call(testPath(machine), s.user, "POST", {});
  s.tick(30_000);
  expect((await s.result(attempt, "running", s.otherMac)).status).toBe(404);
  expect((await s.result(attempt, "running")).status).toBe(200);
  const machines = await list();
  expect(machines.find(m => m.id === id)).toMatchObject({
    online: true, seen_at: startedAt + 150_000, connection_test: { acknowledged_at: startedAt + 150_000 },
    projects: [{ key: "demo", enabled: true }], engines: ["codex"],
  });
  expect(machines.find(m => m.id === otherId)).toMatchObject({
    online: false, seen_at: startedAt, connection_test: { acknowledged_at: null },
  });
  expect(await env.DB.prepare("SELECT state_since FROM board_launches WHERE attempt_id=?")
    .bind(attempt).first("state_since")).toBe(startedAt);

  expect((await s.result(attempt, "completed")).status).toBe(200);
  s.tick(120_000);
  await s.call(testPath(id), s.user, "POST", {});
  expect((await s.result(attempt, "running")).status).toBe(409);
  expect((await list()).find(m => m.id === id)).toMatchObject({
    online: false, seen_at: startedAt + 150_000, connection_test: { acknowledged_at: null },
  });
});

it("restricts machine settings to their owner, current local keys, and same-origin changes", async () => {
  const s = await setup();
  await s.claim();
  const { machine_id } = await (await s.call("/api/me", s.mac, "GET")).json<{machine_id: string}>();
  const path = "/api/settings/machines/" + machine_id;
  const change = { project: "demo", enabled: false };
  for (const [url, method, body] of [
    ["/api/settings", "GET", undefined], [path + "/project", "PUT", change], [path + "/test", "POST", {}],
  ] as const) {
    expect((await s.call(url, s.mac, method, body)).status).toBe(403);
    const anonymous = await s.call(url, "", method, body);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("Cache-Control")).toContain("no-store");
    if (body) expect((await s.call(url, s.user, method, body, "https://other.example")).status).toBe(403);
    const other = { ...env, OWNER_EMAIL: "other@example.com" };
    const response = await s.call(url, await s.userToken(other.OWNER_EMAIL), method, body, ORIGIN, other);
    if (body) expect(response.status).toBe(404);
    else expect(await response.json()).toEqual({ machines: [] });
  }
  expect((await s.call(path + "/project", s.user, "PUT", {project: "/unregistered", enabled: true})).status).toBe(404);
  expect((await s.call(path + "/project", s.user, "PUT", {project: "demo", enabled: "false"})).status).toBe(400);
});

it("applies per-Mac project switches to queue validation, board choices, manual and automatic claims", async () => {
  const s = await setup();
  await s.queue();
  const { machine_id } = await (await s.call("/api/me", s.mac, "GET")).json<{machine_id: string}>();
  const switchProject = (enabled: boolean) => s.call("/api/settings/machines/" + machine_id + "/project", s.user, "PUT", {project: "demo", enabled});
  const auto = () => s.call("/api/runner/claim", s.mac, "PUT", {...capabilities, auto_queue: true});
  expect((await switchProject(false)).status).toBe(200);
  expect((await switchProject(false)).status).toBe(200);
  await s.claim(s.mac, {projects: [], engines: []});
  expect(await (await auto()).json()).toEqual({job: null});
  expect(await (await s.start(crypto.randomUUID())).json()).toEqual({error: "runner_unavailable"});
  expect(await (await s.call("/api/board", s.user, "GET")).json()).not.toHaveProperty("runnerProjects");
  expect((await s.put({stage: "backlog"})).status).toBe(200);
  expect(await (await s.put({stage: "queued"})).json()).toEqual({error: "project_unregistered"});
  await s.claim(s.otherMac, {projects: ["demo"], engines: ["claude_code"]});
  expect(await (await s.put({stage: "queued"})).json()).toEqual({error: "engine_unavailable"});
  expect((await switchProject(true)).status).toBe(200);
  expect((await s.put({stage: "queued"})).status).toBe(200);
  const attempt = crypto.randomUUID();
  expect((await s.start(attempt)).status).toBe(200);
  expect((await switchProject(false)).status).toBe(200);
  expect(await (await s.claim()).json()).toEqual({job: null});
  expect((await switchProject(true)).status).toBe(200);
  expect(await (await s.claim()).json()).toMatchObject({job: {attempt_id: attempt}});
  expect((await s.result(attempt, "running")).status).toBe(200);
  expect((await switchProject(false)).status).toBe(200);
  expect((await s.result(attempt, "completed")).status).toBe(200);
});

it("stops a previously delivered claim if its Mac loses permission before confirming execution", async () => {
  const s = await setup();
  await s.queue();
  const attempt = crypto.randomUUID();
  expect((await s.start(attempt)).status).toBe(200);
  expect(await (await s.claim()).json()).toMatchObject({ job: { attempt_id: attempt } });
  const { machine_id } = await (await s.call("/api/me", s.mac, "GET")).json<{machine_id: string}>();
  const update = await s.call("/api/settings/machines/" + machine_id + "/project", s.user, "PUT", {project: "demo", enabled: false});
  expect(update.status).toBe(200);
  expect((await s.result(attempt, "running")).status).toBe(409);
  expect((await s.board()).requests[0]?.launch).toMatchObject({state: "failed", error: "project_disabled"});
});

it("explains queued waits using only eligible Macs and keeps busy workers distinct from sleeping ones", async () => {
  const s = await setup();
  await s.queue();
  const waitingPath = "/api/board/requests/" + crypto.randomUUID();
  const waitingId = waitingPath.split("/").pop();
  await s.call(waitingPath, s.user, "PUT", card);
  await s.call(waitingPath, s.user, "PUT", { stage: "queued" });
  async function queuedCard() {
    return (await s.board()).requests.find(r => r.id === waitingId);
  }

  expect(await queuedCard()).toMatchObject({ wait_reason: "next_poll" });
  s.tick(120_000);
  expect(await queuedCard()).toMatchObject({ wait_reason: "waiting_for_mac" });
  await s.claim(s.otherMac, { projects: ["other"], engines: ["codex"] });
  expect(await queuedCard()).toMatchObject({ wait_reason: "waiting_for_mac" });

  const { job } = await (await s.call("/api/runner/claim", s.mac, "PUT", { ...capabilities, auto_queue: true }))
    .json<{job: { attempt_id: string }}>();
  await s.result(job.attempt_id, "running");
  s.tick(180_000);
  expect(await queuedCard()).toMatchObject({ wait_reason: "mac_busy" });
  await s.claim(s.otherMac);
  expect(await queuedCard()).toMatchObject({ wait_reason: "next_poll" });
  await s.result(job.attempt_id, "completed");
  await s.claim(s.otherMac, { projects: ["other"], engines: ["codex"] });
  await s.claim(s.mac, { projects: ["demo"], engines: ["claude_code"] });
  expect(await queuedCard()).toMatchObject({ wait_reason: "check_settings" });
});
