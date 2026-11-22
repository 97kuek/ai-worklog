// Test-only binding injected by vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
