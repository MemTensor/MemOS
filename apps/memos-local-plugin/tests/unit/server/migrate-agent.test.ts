import { describe, expect, it } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { registerMigrateRoutes } from "../../../server/routes/migrate.js";
import { Routes } from "../../../server/routes/registry.js";

describe("legacy migration agent routing", () => {
  it("does not reinterpret DeepSeek Harness as OpenClaw", async () => {
    const routes = new Routes();
    registerMigrateRoutes(
      routes,
      { core: {} as MemoryCore },
      { agent: "deepseek-harness" },
    );

    const scan = routes.getExact("GET /api/v1/migrate/legacy/scan");
    const result = await scan!({} as never);

    expect(result).toEqual({
      found: false,
      agent: "deepseek-harness",
      path: "",
      error: "No legacy memory database is defined for this agent.",
    });
  });
});
