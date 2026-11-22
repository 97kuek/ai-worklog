import { env, SELF } from "cloudflare:test";

it("creates the initial tables", async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users','machines','sessions','blocks') ORDER BY name",
  ).all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual(["blocks", "machines", "sessions", "users"]);
});

it("serves the static page outside /api", async () => {
  const res = await SELF.fetch("https://example.com/");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("ai-worklog");
});

it("returns JSON 404 for unknown API paths", async () => {
  const res = await SELF.fetch("https://example.com/api/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
