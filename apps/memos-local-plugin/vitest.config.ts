import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
      include: [
        "core/**/*.ts",
        "server/**/*.ts",
        "bridge/**/*.ts",
        "adapters/openclaw/**/*.ts",
        "adapters/deepseek-harness/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.d.ts", "**/index.ts"],
    },
  },
});
