import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../app";
import { listSkills, replaceSkills } from "../db/skills";
import { parseSkillInventory } from "../domain/skills";

export function registerSkillRoutes(app: Hono<AppEnv>): void {
  app.put("/api/skills", bodyLimit({
    maxSize: 8 * 1024 * 1024,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "machine") return c.json({ error: "forbidden" }, 403);

    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: "invalid_payload", path: "", message: "body must be valid JSON" }, 400);
    }
    const parsed = parseSkillInventory(json);
    if (!parsed.ok) return c.json({ error: "invalid_payload", path: parsed.path, message: parsed.message }, 400);
    await replaceSkills(c.env.DB, principal.machineId, parsed.value);
    return c.json({ skills: parsed.value.skills.length });
  });

  app.get("/api/skills", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "user") return c.json({ error: "forbidden" }, 403);
    const skills = await listSkills(c.env.DB, principal.userId);
    return c.json({ skills }, 200, { "Cache-Control": "private, no-store" });
  });
}
