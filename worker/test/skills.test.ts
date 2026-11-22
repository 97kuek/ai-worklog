import { env } from "cloudflare:test";
import { testApp } from "./helpers";

const codex = { tool: "codex", name: "review", description: "Review code" };
const claude = { ...codex, tool: "claude_code" };

async function setup() {
  const { app, machineToken, userToken } = await testApp();
  const machine = await machineToken();
  const user = await userToken();
  function request(token: string, body?: unknown, bindings: Env = env) {
    return app.request("/api/skills", {
      method: body === undefined ? "GET" : "PUT",
      headers: { "Cf-Access-Jwt-Assertion": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, bindings);
  }
  async function put(body: unknown, token = machine, bindings = env) {
    expect((await request(token, body, bindings)).status).toBe(200);
  }
  async function list() {
    const res = await request(user);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    return (await res.json<{ skills: { tools: string[]; name: string; description: string }[] }>()).skills;
  }
  return { machine, user, machineToken, userToken, request, put, list };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM machines").run();
});

it("allows machines to replace skills and only the owner to list them", async () => {
  const { machine, user, userToken, request } = await setup();
  expect((await request("", { skills: [] })).status).toBe(401);
  expect((await request("")).status).toBe(401);
  expect((await request(machine)).status).toBe(403);
  expect((await request(user, { skills: [] })).status).toBe(403);
  expect((await request(await userToken("other@example.com"))).status).toBe(403);
});

it("merges identical metadata, keeping descriptions distinct and sorting by name", async () => {
  const { put, list, machineToken } = await setup();
  const alt = { ...codex, description: "Another review" };
  const earlier = { ...claude, name: "audit" };
  await put({ skills: [codex, alt, codex] });
  await put({ skills: [claude, earlier, codex] }, await machineToken("second.access"));
  expect(await list()).toEqual([
    { tools: ["claude_code"], name: "audit", description: "Review code" },
    { tools: ["codex"], name: "review", description: "Another review" },
    { tools: ["claude_code", "codex"], name: "review", description: "Review code" },
  ]);
});

it("replaces just the declared tools on the uploading machine, including empty inventories", async () => {
  const { put, list, machineToken } = await setup();
  await put({ skills: [codex, claude] });
  await put({ skills: [{ ...codex, name: "second-machine" }] }, await machineToken("second.access"));
  await put({ tools: ["codex"], skills: [{ ...codex, description: "updated" }] });
  expect(await list()).toEqual([
    { tools: ["claude_code"], name: "review", description: "Review code" },
    { tools: ["codex"], name: "review", description: "updated" },
    { tools: ["codex"], name: "second-machine", description: "Review code" },
  ]);
  await put({ tools: ["claude_code"], skills: [] });
  expect((await list()).map(s => s.description)).toEqual(["updated", "Review code"]);
  await put({ skills: [] });
  expect(await list()).toEqual([{ tools: ["codex"], name: "second-machine", description: "Review code" }]);
});

it("isolates owners sharing the same database", async () => {
  const { put, list, request, userToken, machineToken } = await setup();
  const other = { ...env, OWNER_EMAIL: "other@example.com" };
  const otherUser = await userToken(other.OWNER_EMAIL);
  await put({ skills: [codex] });
  expect(await (await request(otherUser, undefined, other)).json()).toEqual({ skills: [] });
  await put({ skills: [claude] }, await machineToken("other.access"), other);
  await put({ skills: [] });
  expect(await list()).toEqual([]);
  expect(await (await request(otherUser, undefined, other)).json()).toEqual({
    skills: [{ tools: ["claude_code"], name: claude.name, description: claude.description }],
  });
});

it("rejects invalid snapshots without changing the previous list", async () => {
  const { put, list, request, machine } = await setup();
  await put({ skills: [codex] });
  for (const payload of [
    {}, { skills: null }, { skills: Array(1025).fill(codex) },
    { skills: [claude], tools: ["codex"] }, { skills: [], tools: [] },
    { skills: [], tools: ["other"] }, { skills: [], tools: null },
    { skills: [null] }, { skills: [{ ...codex, tool: "other" }] },
    { skills: [{ ...codex, name: "" }] }, { skills: [{ ...codex, name: "a".repeat(257) }] },
    { skills: [{ ...codex, description: "a".repeat(4097) }] }, { skills: [{ ...codex, description: null }] },
  ]) {
    expect((await request(machine, payload)).status).toBe(400);
  }
  expect(await list()).toEqual([{ tools: ["codex"], name: codex.name, description: codex.description }]);
});

it("accepts a full snapshot and counts Unicode code points", async () => {
  const { put, list } = await setup();
  const skills = Array.from({ length: 1023 }, (_, i) => ({ ...codex, name: String(i) }));
  skills.push({ ...codex, name: "😀".repeat(256), description: "😀".repeat(4096) });
  await put({ skills });
  expect(await list()).toHaveLength(1024);
});

it("rolls back the delete and earlier insert chunks when a later write fails", async () => {
  const { put, list, request, machine } = await setup();
  await put({ skills: [codex] });
  await env.DB.prepare(`CREATE TRIGGER fail_skill_insert BEFORE INSERT ON machine_skills
    WHEN NEW.name = 'fail' BEGIN SELECT RAISE(ABORT, 'test write failure'); END`).run();
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const skills = Array.from({ length: 40 }, (_, i) => ({ ...codex, name: String(i) }));
    skills.push({ ...codex, name: "fail" });
    expect((await request(machine, { skills })).status).toBe(500);
    expect(await list()).toEqual([{ tools: ["codex"], name: codex.name, description: codex.description }]);
  } finally {
    spy.mockRestore();
    await env.DB.prepare("DROP TRIGGER fail_skill_insert").run();
  }
});
