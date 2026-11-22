import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-aud",
          OWNER_EMAIL: "owner@example.com",
        },
      },
    }),
  ],
  test: {
    globals: true,
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
