import type { Hono } from "hono";
import type { AppEnv } from "../app";
import { listMachines, requestConnectionTest, setProjectEnabled } from "../db/settings";

export function registerSettingsRoutes(app: Hono<AppEnv>, now: () => number) {
  app.use("/api/settings/*", async (c, next) => {
    if (c.get("principal").kind !== "user"
      || (c.req.method !== "GET" && c.req.header("Origin") !== new URL(c.req.url).origin)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });

  app.get("/api/settings", async c => {
    return c.json({ machines: await listMachines(c.env.DB, c.get("principal").userId, now()) });
  });

  app.put("/api/settings/machines/:id/project", async c => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.project !== "string" || !body.project.trim() || body.project.length > 256
      || typeof body.enabled !== "boolean") return c.json({ error: "invalid_payload" }, 400);
    const updated = await setProjectEnabled(c.env.DB, c.get("principal").userId, c.req.param("id"), body.project, body.enabled);
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json({ project: body.project, enabled: body.enabled });
  });

  app.post("/api/settings/machines/:id/test", async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const requested_at = await requestConnectionTest(c.env.DB, c.get("principal").userId, c.req.param("id"), now());
    if (requested_at === null) return c.json({ error: "not_found" }, 404);
    return c.json({ requested_at });
  });
}
