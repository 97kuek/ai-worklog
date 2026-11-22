import { registerClaudeUsageRoutes } from "./routes/claude-usage";
import { Hono } from "hono";
import { ConfigError, type Authenticate } from "./auth/identity";
import { ensureMachine, ensureUser } from "./db/repo";
import { registerRunnerRoutes } from "./routes/runner";
import { registerRequestRoutes } from "./routes/requests";
import { registerBlockRoutes } from "./routes/blocks";
import { registerSessionRoutes } from "./routes/sessions";
import { registerSettingsRoutes } from "./routes/settings";
import { registerSkillRoutes } from "./routes/skills";

export type Principal =
  | { kind: "user"; userId: string }
  | { kind: "machine"; userId: string; machineId: string };
export type AppEnv = { Bindings: Env; Variables: { principal: Principal } };
export type AppDeps = { authenticate: Authenticate; now?: () => number };

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const now = () => deps.now?.() ?? Date.now();

  app.use("/api/settings/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const rawOwner = c.env.OWNER_EMAIL;
    const ownerEmail = typeof rawOwner === "string" ? rawOwner.trim().toLowerCase() : "";
    if (ownerEmail.length === 0) {
      throw new ConfigError("OWNER_EMAIL must be set");
    }
    const identity = await deps.authenticate(c.req.raw, c.env);
    if (!identity) return c.json({ error: "unauthorized" }, 401);

    if (identity.kind === "user") {
      if (identity.email.toLowerCase() !== ownerEmail) return c.json({ error: "forbidden" }, 403);
      const userId = await ensureUser(c.env.DB, ownerEmail, now());
      c.set("principal", { kind: "user", userId });
    } else {
      // A service token that passed the Access policy is the owner's machine.
      const userId = await ensureUser(c.env.DB, ownerEmail, now());
      const machineId = await ensureMachine(c.env.DB, userId, identity.clientId, now());
      if (machineId === null) return c.json({ error: "forbidden" }, 403);
      c.set("principal", { kind: "machine", userId, machineId });
    }
    await next();
  });

  app.get("/api/me", (c) => {
    const p = c.get("principal");
    return c.json(p.kind === "user" ? { kind: "user" } : { kind: "machine", machine_id: p.machineId });
  });

  registerSessionRoutes(app, now);
  registerRequestRoutes(app, now);
  registerRunnerRoutes(app, now);
  registerSettingsRoutes(app, now);
  registerBlockRoutes(app);
  registerSkillRoutes(app);
  registerClaudeUsageRoutes(app, now);

  app.onError((err, c) => {
    if (err instanceof ConfigError) {
      console.error("misconfigured:", err.message);
      return c.json({ error: "misconfigured" }, 500);
    }
    console.error("unexpected error", err);
    return c.json({ error: "internal" }, 500);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "not_found" }, 404);
    }
    // In production only /api/* reaches the Worker (run_worker_first), but the
    // Vitest harness sends every request through it, so hand the rest to assets.
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return app;
}
