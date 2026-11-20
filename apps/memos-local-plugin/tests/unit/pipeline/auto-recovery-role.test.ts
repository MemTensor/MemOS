import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { rootLogger } from "../../../core/logger/index.js";
import {
  createMemoryCore,
  createPipeline,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import type { EpisodeId, SessionId } from "../../../core/types.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

function fullMemoryConfig(): typeof DEFAULT_CONFIG {
  return {
    ...DEFAULT_CONFIG,
    algorithm: {
      ...DEFAULT_CONFIG.algorithm,
      lightweightMemory: {
        ...DEFAULT_CONFIG.algorithm.lightweightMemory,
        enabled: false,
      },
    },
  };
}

function buildDeps(db: TmpDbHandle): PipelineDeps {
  return {
    agent: "hermes",
    home: resolveHome("hermes", db.dir),
    config: fullMemoryConfig(),
    db: db.db,
    repos: db.repos,
    llm: null,
    reflectLlm: null,
    embedder: fakeEmbedder({ dimensions: 384 }),
    log: rootLogger.child({ channel: "test.auto-recovery-role" }),
    namespace: { agentKind: "hermes", profileId: "default" },
    now: () => 1_700_000_000_000,
  };
}

describe("automatic recovery role ownership", () => {
  let db: TmpDbHandle | null = null;
  let pipeline: PipelineHandle | null = null;
  let core: MemoryCore | null = null;

  afterEach(async () => {
    if (core) {
      await core.shutdown();
    } else if (pipeline) {
      await pipeline.shutdown("test.cleanup");
    }
    db?.cleanup();
    core = null;
    pipeline = null;
    db = null;
    vi.restoreAllMocks();
  });

  it("leaves startup rows untouched but keeps normal turn capture enabled", async () => {
    db = makeTmpDb({ agent: "hermes" });
    const orphanSessionId = "se_viewer_orphan" as SessionId;
    const orphanEpisodeId = "ep_viewer_orphan" as EpisodeId;
    db.repos.sessions.upsert({
      id: orphanSessionId,
      agent: "hermes",
      ownerAgentKind: "hermes",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      startedAt: 1_600_000_000_000,
      lastSeenAt: 1_600_000_000_000,
      meta: {},
    });
    db.repos.episodes.insert({
      id: orphanEpisodeId,
      sessionId: orphanSessionId,
      ownerAgentKind: "hermes",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      startedAt: 1_600_000_000_000,
      endedAt: null,
      traceIds: [],
      rTask: 0.7,
      status: "open",
      meta: { sentinel: "unchanged" },
    });

    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    pipeline = createPipeline(buildDeps(db));
    core = createMemoryCore(
      pipeline,
      resolveHome("hermes", db.dir),
      "auto-recovery-role-test",
      { autoRecovery: false },
    );
    await core.init();
    await core.waitForStartupRecovery?.();

    const untouched = db.repos.episodes.getById(orphanEpisodeId);
    expect(untouched?.status).toBe("open");
    expect(untouched?.endedAt).toBeNull();
    expect(untouched?.meta).toEqual({ sentinel: "unchanged" });
    expect(
      intervalSpy.mock.calls.some(([, delay]) => delay === 10 * 60 * 1000),
    ).toBe(false);

    const sessionId = await core.openSession({
      agent: "hermes",
      sessionId: "se_normal_capture" as SessionId,
    });
    const start = await core.onTurnStart({
      agent: "hermes",
      sessionId,
      userText: "我喜欢的水果是凤梨",
      ts: 1_700_000_000_100,
    });
    const saved = await core.onTurnEnd({
      agent: "hermes",
      sessionId,
      episodeId: start.query.episodeId!,
      agentText: "记住了。",
      toolCalls: [],
      ts: 1_700_000_000_200,
    });
    await pipeline.flush();

    const trace = await core.getTrace(saved.traceId);
    expect(trace?.userText).toBe("我喜欢的水果是凤梨");
  });

  it("uses the same Hermes-only role formula in both bridge entries", () => {
    const root = join(__dirname, "../../..");
    for (const filename of ["bridge.mts", "bridge.cts"]) {
      const source = readFileSync(join(root, filename), "utf8");
      expect(source).toContain(
        'autoRecovery: args.agent !== "hermes" || !args.daemon',
      );
    }
  });
});
