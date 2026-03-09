import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { initPlugin, type MemosLocalPlugin } from "../src/index";

let plugin: MemosLocalPlugin;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-integration-"));
  plugin = initPlugin({
    stateDir: tmpDir,
    config: {
      // No summarizer → rule-based fallback
      // No embedding → local MiniLM fallback
    },
  });

  // Simulate a conversation: user talks about deploying a service
  plugin.onConversationTurn([
    { role: "user", content: "I'm deploying our API service to port 8443 using Docker. The command is: `docker compose -f docker-compose.prod.yml up -d`. The Postgres password is configured via POSTGRES_PASSWORD env var." },
    { role: "assistant", content: "Got it. I'll help you deploy. Make sure the firewall allows port 8443 and that POSTGRES_PASSWORD is set in your .env file. The docker-compose.prod.yml should have health checks configured." },
  ], "session-deploy");

  // Second turn about a different topic
  plugin.onConversationTurn([
    { role: "user", content: "Now let's discuss the React frontend. We're using Next.js 14 with App Router. The main page component is at app/page.tsx and it fetches data from /api/dashboard." },
    { role: "assistant", content: "For the Next.js 14 App Router setup, your app/page.tsx should use server components by default. The /api/dashboard route handler should be in app/api/dashboard/route.ts." },
  ], "session-frontend");

  // Third turn with an error stack
  plugin.onConversationTurn([
    { role: "user", content: `The build is failing with this error:
Error: Module not found: Can't resolve '@/components/Chart'
    at ModuleNotFoundError (webpack/lib/ModuleNotFoundError.js:28:12)
    at factorize (webpack/lib/Compilation.js:2045:24)
    at resolve (webpack/lib/NormalModuleFactory.js:439:20)

I think the path alias is wrong in the tsconfig configuration.` },
    { role: "assistant", content: "The error shows a missing path alias for @/components/Chart. Check your tsconfig.json paths configuration - it should have: \"@/*\": [\"./src/*\"] or similar mapping." },
  ], "session-frontend");

  plugin.onConversationTurn([
    { role: "user", content: "alpha private marker only alpha should see this rollout note" },
    { role: "assistant", content: "Recorded alpha private marker deployment note." },
  ], "session-alpha-private", "agent:alpha");

  plugin.onConversationTurn([
    { role: "user", content: "beta private marker only beta should see this rollback note" },
    { role: "assistant", content: "Recorded beta private marker rollback note." },
  ], "session-beta-private", "agent:beta");

  plugin.onConversationTurn([
    { role: "user", content: "shared public marker all agents can use this shared convention" },
    { role: "assistant", content: "Recorded shared public marker convention." },
  ], "session-public", "public");

  // Wait for all async ingest to complete
  await plugin.flush();
}, 120_000);

afterAll(() => {
  plugin.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Integration: memory_search", () => {
  it("should find docker deployment details", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "docker deploy port 8443" })) as any;

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.meta.usedMinScore).toBe(0.45);
    expect(result.meta.usedMaxResults).toBe(6);

    const hit = result.hits[0];
    expect(hit.summary).toBeTruthy();
    expect(hit.original_excerpt).toBeTruthy();
    expect(hit.ref).toBeDefined();
    expect(hit.ref.sessionKey).toBeTruthy();
    expect(hit.ref.chunkId).toBeTruthy();
    expect(hit.score).toBeGreaterThanOrEqual(0);
    expect(hit.score).toBeLessThanOrEqual(1);
    expect(hit.source.ts).toBeGreaterThan(0);
  });

  it("should find Next.js frontend details", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "Next.js App Router page.tsx" })) as any;

    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("should find error stack information", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "Module not found Chart component" })) as any;

    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("should respect maxResults parameter", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "deploy", maxResults: 2 })) as any;

    expect(result.hits.length).toBeLessThanOrEqual(2);
    expect(result.meta.usedMaxResults).toBe(2);
  });

  it("should produce note on repeated identical query", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

    await searchTool.handler({ query: "unique test query xyz", maxResults: 6, minScore: 0.45 });
    const result2 = (await searchTool.handler({ query: "unique test query xyz", maxResults: 6, minScore: 0.45 })) as any;

    expect(result2.meta.note).toBeDefined();
    expect(result2.meta.note).toContain("already");
  });
});

describe("Integration: memory_timeline", () => {
  it("should return neighboring context around a hit", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const timelineTool = plugin.tools.find((t) => t.name === "memory_timeline")!;

    const searchResult = (await searchTool.handler({ query: "docker compose" })) as any;
    if (searchResult.hits.length === 0) return; // skip if no hits

    const ref = searchResult.hits[0].ref;
    const timelineResult = (await timelineTool.handler({ ref, window: 2 })) as any;

    expect(timelineResult.entries).toBeDefined();
    expect(timelineResult.entries.length).toBeGreaterThan(0);
    expect(timelineResult.anchorRef).toEqual(ref);

    const entry = timelineResult.entries[0];
    expect(entry.excerpt).toBeTruthy();
    expect(entry.ref).toBeDefined();
    expect(["before", "current", "after"]).toContain(entry.relation);
  });
});

describe("Integration: memory_get", () => {
  it("should return full original text of a chunk", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const getTool = plugin.tools.find((t) => t.name === "memory_get")!;

    const searchResult = (await searchTool.handler({ query: "docker compose" })) as any;
    if (searchResult.hits.length === 0) return;

    const ref = searchResult.hits[0].ref;
    const getResult = (await getTool.handler({ ref })) as any;

    expect(getResult.content).toBeTruthy();
    expect(getResult.ref).toBeDefined();
    expect(getResult.source).toBeDefined();
    expect(getResult.source.ts).toBeGreaterThan(0);
  });

  it("should respect maxChars parameter", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const getTool = plugin.tools.find((t) => t.name === "memory_get")!;

    const searchResult = (await searchTool.handler({ query: "docker" })) as any;
    if (searchResult.hits.length === 0) return;

    const ref = searchResult.hits[0].ref;
    const getResult = (await getTool.handler({ ref, maxChars: 50 })) as any;

    expect(getResult.content.length).toBeLessThanOrEqual(52); // 50 + "…"
  });
});

describe("Integration: owner isolation for initPlugin tools", () => {
  it("memory_search should respect owner on initPlugin path", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;

    const betaSearch = (await searchTool.handler({
      query: "alpha private marker",
      owner: "agent:beta",
    })) as any;

    expect(betaSearch.hits).toHaveLength(0);

    const publicSearch = (await searchTool.handler({
      query: "shared public marker",
      owner: "agent:beta",
    })) as any;

    expect(publicSearch.hits.length).toBeGreaterThan(0);
    expect(publicSearch.hits.some((hit: any) => hit.ref.sessionKey === "session-public")).toBe(true);
  });

  it("memory_timeline should not expose another owner's chunks on initPlugin path", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const timelineTool = plugin.tools.find((t) => t.name === "memory_timeline")!;

    const alphaSearch = (await searchTool.handler({
      query: "alpha private marker",
      owner: "agent:alpha",
    })) as any;

    expect(alphaSearch.hits.length).toBeGreaterThan(0);

    const ref = alphaSearch.hits[0].ref;
    const leaked = (await timelineTool.handler({ ref, owner: "agent:beta", window: 2 })) as any;

    expect(leaked.entries).toEqual([]);
  });

  it("memory_get should not expose another owner's chunk on initPlugin path", async () => {
    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const getTool = plugin.tools.find((t) => t.name === "memory_get")!;

    const alphaSearch = (await searchTool.handler({
      query: "alpha private marker",
      owner: "agent:alpha",
    })) as any;

    expect(alphaSearch.hits.length).toBeGreaterThan(0);

    const ref = alphaSearch.hits[0].ref;
    const leaked = (await getTool.handler({ ref, owner: "agent:beta" })) as any;

    expect(leaked.error).toContain(ref.chunkId);
  });
});

describe("Integration: evidence anti-writeback", () => {
  it("should not store evidence wrapper blocks in memory", async () => {
    plugin.onConversationTurn([
      { role: "assistant", content: "Based on [STORED_MEMORY]old data about port 3000[/STORED_MEMORY] the answer is port 8443." },
    ], "session-test");

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const searchTool = plugin.tools.find((t) => t.name === "memory_search")!;
    const result = (await searchTool.handler({ query: "old data port 3000" })) as any;

    for (const hit of result.hits) {
      expect(hit.original_excerpt).not.toContain("[STORED_MEMORY]");
      expect(hit.original_excerpt).not.toContain("old data about port 3000");
    }
  });
});
