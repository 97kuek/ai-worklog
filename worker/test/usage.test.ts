import { env } from "cloudflare:test";
import { testApp } from "./helpers";
import type { AccountUsage } from "../ui/accounts";

const path = "/api/usage";
const report = { provider: "claude", account: "studio", session_id: crypto.randomUUID(), observed_at: Date.now() - 10_000,
  input_tokens: 45, output_tokens: 11, cost_usd: null, limits: [] };

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM account_session_usage"), env.DB.prepare("DELETE FROM account_rate_windows")]);
});

async function setup() {
  const { app, userToken, machineToken } = await testApp();
  const user = await userToken(), mac = await machineToken();
  const request = (token: string, body?: unknown) => app.request(path, {
    method: body === undefined ? "GET" : "PUT", headers: { "Cf-Access-Jwt-Assertion": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
  async function read() {
    const res = await request(user);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    return (await res.json<{accounts: AccountUsage[]}>()).accounts;
  }
  return { read, request, mac, user };
}

it("keeps accounts separate and merges retries and out-of-order observations without adding a session twice", async () => {
  const { read, request, mac } = await setup();
  async function send(body: unknown) { expect((await request(mac, body)).status).toBe(200); }
  const window = { window_seconds: 18000, used_percentage: 27.5, resets_at: Math.floor(Date.now()/1000) + 3600 };
  await send(report);
  await send(report);
  await send({ ...report, account: "w-claude", input_tokens: 8, output_tokens: 1 });
  await send({ ...report, observed_at: report.observed_at - 1, input_tokens: null, output_tokens: null, cost_usd: 0.12, limits: [window] });
  await send({ ...report, observed_at: report.observed_at - 2, input_tokens: 0, output_tokens: 0, cost_usd: 0, limits: [{ ...window, used_percentage: 0 }] });
  await send({ ...report, session_id: crypto.randomUUID(), input_tokens: 5, output_tokens: 2 });
  const [personal, work] = await read();
  expect(personal).toMatchObject({ account: "studio", sessions: 2, input_tokens: 50, output_tokens: 13, cost_usd: 0.12, cost_sessions: 1, limits: [window] });
  expect(work).toMatchObject({ account: "w-claude", sessions: 1, input_tokens: 8, cost_usd: null, limits: [] });
});
it("accepts reports only from enrolled machines and reads only from the owner", async () => {
  const { request, mac, user } = await setup();
  expect((await request(mac)).status).toBe(403);
  expect((await request(user, report)).status).toBe(403);
  expect((await request("", report)).status).toBe(401);
  for (const invalid of [{ account: "../other" }, { input_tokens: -1 }, { session_id: "a private name" },
    { observed_at: Date.now() + 3600000 }, { limits: [{ window_seconds: 18000, used_percentage: 120, resets_at: null }] }]) {
    expect((await request(mac, { ...report, ...invalid })).status).toBe(400);
  }
});

it("discovers providers and accounts from owned reports without seeding personal account names", async () => {
  const { read, request, mac } = await setup();
  expect(await read()).toEqual([]);
  for (const provider of ["claude", "another-tool"]) {
    expect((await request(mac, { ...report, provider, account: "work" })).status).toBe(200);
  }
  expect((await read()).map(({ provider, account, sessions }) => [provider, account, sessions])).toEqual([
    ["another-tool", "work", 1], ["claude", "work", 1],
  ]);
});
