import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import plugin from "../plugin-impl";

function makeApi(stateDir: string) {
  const tools = new Map<string, any>();
  const events = new Map<string, Function>();
  let service: any;

  const api = {
    pluginConfig: {},
    resolvePath(input: string) {
      return input === "~/.openclaw" ? stateDir : input;
    },
    logger: {
      info: () => {},
      warn: () => {},
    },
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerService(def: any) {
      service = def;
    },
    on(eventName: string, handler: Function) {
      events.set(eventName, handler);
    },
  } as any;

  plugin.register(api);

  return { tools, events, service };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

describe("plugin-impl owner isolation", () => {
  let tmpDir: string;
  let tools: Map<string, any>;
  let events: Map<string, Function>;
  let service: any;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-plugin-impl-access-"));
    ({ tools, events, service } = makeApi(tmpDir));

    const agentEnd = events.get("agent_end")!;

    await agentEnd({
      success: true,
      agentId: "alpha",
      sessionKey: "alpha-session",
      messages: [
        { role: "user", content: "alpha private marker deployment guide" },
        { role: "assistant", content: "alpha private marker response" },
      ],
    });

    await agentEnd({
      success: true,
      agentId: "beta",
      sessionKey: "beta-session",
      messages: [
        { role: "user", content: "beta private marker rollback guide" },
        { role: "assistant", content: "beta private marker response" },
      ],
    });

    const publicWrite = tools.get("memory_write_public");
    await publicWrite.execute("call-public", { content: "shared public marker convention" }, { agentId: "alpha" });

    const search = tools.get("memory_search");
    await waitFor(async () => {
      const result = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
      return (result?.details?.hits?.length ?? 0) > 0;
    });
  });

  afterEach(() => {
    service?.stop?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memory_search should scope results by agentId", async () => {
    const search = tools.get("memory_search");

    const alpha = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
    const beta = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "beta" });
    const publicHit = await search.execute("call-search", { query: "shared public marker", maxResults: 5, minScore: 0.1 }, { agentId: "beta" });

    expect(alpha.details.hits.length).toBeGreaterThan(0);
    expect(beta.details?.hits ?? []).toEqual([]);
    expect(publicHit.details.hits.length).toBeGreaterThan(0);
  });

  it("memory_timeline should not leak another agent's private neighbors", async () => {
    const search = tools.get("memory_search");
    const timeline = tools.get("memory_timeline");

    const alpha = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
    const ref = alpha.details.hits[0].ref;
    const betaTimeline = await timeline.execute("call-timeline", ref, { agentId: "beta" });

    expect(betaTimeline.details.entries).toEqual([]);
  });

  it("memory_get should not return another agent's private chunk", async () => {
    const search = tools.get("memory_search");
    const getTool = tools.get("memory_get");

    const alpha = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
    const ref = alpha.details.hits[0].ref;
    const betaGet = await getTool.execute("call-get", { chunkId: ref.chunkId }, { agentId: "beta" });

    expect(betaGet.details.error).toBe("not_found");
  });
});
