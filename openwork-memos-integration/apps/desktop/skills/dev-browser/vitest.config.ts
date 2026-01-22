import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60000, // Playwright tests can be slow
    hookTimeout: 60000,
    teardownTimeout: 60000,
  },
});
