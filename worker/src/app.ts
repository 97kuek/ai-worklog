import { Hono } from "hono";

export type AppEnv = { Bindings: Env };

// Task 5 adds `authenticate` here.
export type AppDeps = Record<string, never>;

export function createApp(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

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
