import { env, SELF } from "cloudflare:test";
import { testApp } from "./helpers";

const H = "Cf-Access-Jwt-Assertion";

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM machines"), env.DB.prepare("DELETE FROM users")]);
});

it("returns_401_without_a_token", async () => {
  const { app } = await testApp();
  const res = await app.request("/api/me", {}, env);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

it("identifies_the_owner", async () => {
  const { app, userToken } = await testApp();
  const res = await app.request("/api/me", { headers: { [H]: await userToken() } }, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ kind: "user" });
  expect(await count("users")).toBe(1);
});

it("matches_owner_email_case_insensitively", async () => {
  const { app, userToken } = await testApp();
  const res = await app.request("/api/me", { headers: { [H]: await userToken("OWNER@example.com") } }, env);
  expect(res.status).toBe(200);
});

it("forbids_other_people", async () => {
  const { app, userToken } = await testApp();
  const res = await app.request("/api/me", { headers: { [H]: await userToken("someone@example.com") } }, env);
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "forbidden" });
  expect(await count("users")).toBe(0);
});

it("registers_a_machine_under_the_owner", async () => {
  const { app, machineToken } = await testApp();
  const res = await app.request("/api/me", { headers: { [H]: await machineToken() } }, env);
  expect(res.status).toBe(200);
  const body = await res.json<{ kind: string; machine_id: string }>();
  expect(body.kind).toBe("machine");
  expect(body.machine_id).toBeTruthy();
  const owner = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind("owner@example.com").first<{ id: string }>();
  const machine = await env.DB.prepare("SELECT id, user_id FROM machines WHERE access_client_id = ?")
    .bind("test-machine.access")
    .first<{ id: string; user_id: string }>();
  expect(machine!.user_id).toBe(owner!.id);
  expect(machine!.id).toBe(body.machine_id);
});

it("reuses_the_same_machine", async () => {
  const { app, machineToken } = await testApp();
  const token = await machineToken("same.access");
  const a = await (await app.request("/api/me", { headers: { [H]: token } }, env)).json<{ machine_id: string }>();
  const b = await (await app.request("/api/me", { headers: { [H]: token } }, env)).json<{ machine_id: string }>();
  expect(a.machine_id).toBe(b.machine_id);
  expect(await count("machines")).toBe(1);
});

it("fails_closed_when_access_config_is_missing", async () => {
  const { app, userToken } = await testApp();
  const res = await app.request("/api/me", { headers: { [H]: await userToken() } }, { ...env, ACCESS_AUD: "" });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "misconfigured" });
});

it("fails_closed_when_owner_email_is_missing", async () => {
  const { app, userToken, machineToken } = await testApp();
  const e = { ...env, OWNER_EMAIL: "" };
  for (const token of [await userToken(), await machineToken()]) {
    const res = await app.request("/api/me", { headers: { [H]: token } }, e);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "misconfigured" });
  }
  expect(await count("users")).toBe(0);
});

it("logs_config_errors_with_the_setting_name_but_not_in_the_response", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { app, userToken } = await testApp();
    const res = await app.request("/api/me", { headers: { [H]: await userToken() } }, { ...env, OWNER_EMAIL: "" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "misconfigured" });
    expect(spy.mock.calls.flat().join(" ")).toContain("OWNER_EMAIL");
  } finally {
    spy.mockRestore();
  }
});

it("leaves_static_paths_alone", async () => {
  const res = await SELF.fetch("https://example.com/");
  expect(res.status).toBe(200);
});
