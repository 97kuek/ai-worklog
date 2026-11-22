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
  await s.put({ stage: "queued" });
  expect(await (await s.start(attempt)).json()).toEqual({ error: "engine_required" });
  await s.put({ ...card, stage: "queued", expected: { ...plain, engine: null, model: null, effort: null, stage: "queued" } });
  const other = { ...env, OWNER_EMAIL: "other@example.com" };
  await s.call("/api/runner/claim", s.otherMac, "PUT", capabilities, ORIGIN, other);
  expect(await (await s.start(attempt)).json()).toEqual({ error: "runner_unavailable" });
  const otherUser = await s.userToken(other.OWNER_EMAIL);
  expect((await s.call(s.path + "/start", otherUser, "POST", { attempt_id: attempt }, ORIGIN, other)).status).toBe(404);
  await s.claim(s.mac, { ...capabilities, engines: ["claude_code"] });
  expect(await (await s.start(attempt)).json()).toEqual({ error: "runner_unavailable" });
  await s.claim();
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

it("polls only the owner's requests and offers distinct online projects on the initial board", async () => {
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
  expect(await (await s.call("/api/board", s.user, "GET")).json()).toMatchObject({ runnerProjects: ["alpha", "gamma"] });
  s.tick(1);
  expect(await (await s.call("/api/board", s.user, "GET")).json()).not.toHaveProperty("runnerProjects");
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
  for (const caps of [{}, { ...capabilities, projects: [""] }, { ...capabilities, engines: ["other"] }]) {
    expect((await s.call("/api/runner/claim", s.mac, "PUT", caps)).status).toBe(400);
  }
});
