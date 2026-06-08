import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMemoryCore,
  createPipeline,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { rootLogger } from "../../../core/logger/index.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import { bridgeSessionId } from "../../../adapters/openclaw/bridge.js";

let db: TmpDbHandle | null = null;
let pipeline: PipelineHandle | null = null;
let core: MemoryCore | null = null;

function buildDeps(h: TmpDbHandle): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-resolve-test"),
    config: DEFAULT_CONFIG,
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    embedder: fakeEmbedder({ dimensions: 384 }),
    log: rootLogger.child({ channel: "test.pipeline.resolve" }),
    namespace: { agentKind: "openclaw", profileId: "main" },
    now: () => 1_700_000_000_000,
  };
}

beforeEach(() => {
  db = makeTmpDb();
  pipeline = createPipeline(buildDeps(db));
  core = createMemoryCore(
    pipeline,
    resolveHome("openclaw", "/tmp/memos-resolve-test"),
    "test",
  );
});

afterEach(async () => {
  if (core) {
    try {
      await core.shutdown();
    } catch {
      /* ignore */
    }
  }
  core = null;
  pipeline = null;
  db?.cleanup();
  db = null;
});

describe("resolveOpenEpisodeId / openEpisode", () => {
  it("openEpisode returns the existing open row instead of minting a second id", async () => {
    await core!.init();
    const sessionKey = "agent:main:resolve-test";
    const sessionId = bridgeSessionId("main", sessionKey);
    await core!.openSession({ agent: "openclaw", sessionId });

    const first = await core!.openEpisode({
      sessionId,
      userMessage: "task one",
    });
    const second = await core!.openEpisode({
      sessionId,
      userMessage: "task one continued",
    });

    expect(second).toBe(first);
    expect(pipeline!.resolveOpenEpisodeId(sessionId)).toBe(first);

    const rows = await core!.listEpisodeRows({ sessionId, limit: 10 });
    expect(rows.filter((r) => r.status === "open")).toHaveLength(1);
  });
});
