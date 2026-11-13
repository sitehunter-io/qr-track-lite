import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          ADMIN_SECRET: "test-admin-secret-0123456789",
          WEBHOOK_SECRET: "test-webhook-secret",
        },
      },
    }),
  ],
  // examples/ has its own package and node:test suite (run by its own CI job).
  test: { include: ["test/**/*.test.ts"] },
});
