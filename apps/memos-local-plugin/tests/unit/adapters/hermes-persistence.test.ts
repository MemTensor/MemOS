/**
 * Hermes persistence E2E.
 *
 * Uses a real MemoryCore + SQLite database in a temp Hermes home, while
 * replacing embeddings/LLM with deterministic local fakes. This covers the
 * adapter-visible pipeline contract without booting Hermes or the Node bridge.
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMemoryCore,
  createPipeline,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome, type ResolvedConfig } from "../../../core/config/index.js";
import { rootLogger } from "../../../core/logger/index.js";
import { makeRepos, openDb, runMigrations } from "../../../core/storage/index.js";
import type {
  EmbedInput,
  EmbedStats,
  Embedder,
} from "../../../core/embedding/types.js";
import type { AgentKind } from "../../../agent-contract/dto.js";
import type { EmbeddingVector } from "../../../core/types.js";

function semanticFakeEmbedder(dims = 64): Embedder {
  const stats: EmbedStats = {
    hits: 0,
    misses: 0,
    requests: 0,
    roundTrips: 0,
    failures: 0,
    lastOkAt: null,
    lastError: null,
  };
  const vectorFor = (text: string): EmbeddingVector => {
    const arr = new Float32Array(dims);
    for (const ch of text.normalize("NFKC")) {
      arr[ch.codePointAt(0)! % dims] += 1;
    }
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i++) arr[i] /= norm;
    return arr;
  };
  return {
    dimensions: dims,
    provider: "local",
    model: "semantic-fake",
    async embedOne(input: string | EmbedInput): Promise<EmbeddingVector> {
      stats.requests++;
      stats.misses++;
      stats.roundTrips++;
      return vectorFor(typeof input === "string" ? input : input.text);
    },
    async embedMany(inputs: Array<string | EmbedInput>): Promise<EmbeddingVector[]> {
      stats.requests += inputs.length;
      stats.misses += inputs.length;
      stats.roundTrips++;
      return inputs.map((input) => vectorFor(typeof input === "string" ? input : input.text));
    },
    stats() {
      return { ...stats };
    },
    resetCache() {
      stats.hits = 0;
      stats.misses = 0;
    },
    async close(): Promise<void> {
      /* noop */
    },
  };
}

function testConfig(): ResolvedConfig {
  const cfg = structuredClone(DEFAULT_CONFIG) as ResolvedConfig;
  cfg.embedding.dimensions = 64;
  cfg.algorithm.capture.alphaScoring = false;
  cfg.algorithm.capture.synthReflections = false;
  cfg.algorithm.reward.llmScoring = false;
  cfg.algorithm.l2Induction.useLlm = false;
  cfg.algorithm.l3Abstraction.useLlm = false;
  cfg.algorithm.skill.useLlm = false;
  cfg.algorithm.feedback.useLlm = false;
  cfg.algorithm.retrieval.llmFilterEnabled = false;
  cfg.algorithm.retrieval.includeLowValue = true;
  cfg.algorithm.retrieval.minTraceSim = 0;
  cfg.algorithm.retrieval.relativeThresholdFloor = 0;
  return cfg;
}

function ensureHome(root: string): void {
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });
  mkdirSync(join(root, "daemon"), { recursive: true });
}

function buildCore(root: string, version: string): {
  core: MemoryCore;
  pipeline: PipelineHandle;
} {
  ensureHome(root);
  const agent = "hermes" as AgentKind;
  const home = resolveHome(agent, root);
  const db = openDb({ filepath: home.dbFile, agent });
  runMigrations(db);
  const repos = makeRepos(db);
  const config = testConfig();
  const deps: PipelineDeps = {
    agent,
    home,
    config,
    db,
    repos,
    llm: null,
    reflectLlm: null,
    embedder: semanticFakeEmbedder(config.embedding.dimensions),
    log: rootLogger.child({ channel: "test.adapters.hermes.persistence" }),
    namespace: { agentKind: "hermes", profileId: "default" },
    now: () => 1_700_000_000_000,
  };
  const pipeline = createPipeline(deps);
  const core = createMemoryCore(pipeline, home, version, {
    onShutdown: () => db.close(),
  });
  return { core, pipeline };
}

describe("Hermes MemoryCore persistence", () => {
  let root: string | null = null;
  let liveCore: MemoryCore | null = null;

  afterEach(async () => {
    try {
      await liveCore?.shutdown();
    } catch {
      /* ignore */
    }
    liveCore = null;
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = null;
    }
  });

  it("persists a Hermes turn and retrieves it after restart", async () => {
    root = mkdtempSync(join(tmpdir(), "memos-hermes-persist-"));

    const first = buildCore(root, "hermes-persist-1");
    liveCore = first.core;
    await first.core.init();
    const sessionId = await first.core.openSession({
      agent: "hermes" as AgentKind,
      sessionId: "hermes:e2e-session" as never,
    });
    const start = await first.core.onTurnStart({
      agent: "hermes" as AgentKind,
      sessionId,
      userText: "请记住 HERMES_MEMOS_E2E_0428 viewer 端口是 18800",
      ts: 1_700_000_000_001,
    });
    const episodeId = start.query.episodeId!;
    await first.core.onTurnEnd({
      agent: "hermes" as AgentKind,
      sessionId,
      episodeId,
      agentText: "已记录 Hermes MemOS 测试事实。",
      toolCalls: [
        {
          name: "memory_search",
          input: "{\"query\":\"HERMES_MEMOS_E2E_0428\"}",
          output: "[]",
          startedAt: 1_700_000_000_002,
          endedAt: 1_700_000_000_002,
        },
      ],
      ts: 1_700_000_000_002,
    });
    await first.pipeline.flush();
    await first.core.closeEpisode(episodeId);
    await first.core.closeSession(sessionId);
    await first.core.shutdown();
    liveCore = null;

    const second = buildCore(root, "hermes-persist-2");
    liveCore = second.core;
    await second.core.init();

    const traces = await second.core.listTraces({
      sessionId,
      q: "HERMES_MEMOS_E2E_0428",
      limit: 10,
    });
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]!.userText).toContain("HERMES_MEMOS_E2E_0428");

    const fetched = await second.core.getTrace(traces[0]!.id);
    expect(fetched?.userText).toContain("HERMES_MEMOS_E2E_0428");

    const timeline = await second.core.timeline({ episodeId });
    expect(timeline.map((trace) => trace.id)).toContain(traces[0]!.id);
    expect(timeline.some((trace) => trace.agentText.includes("已记录 Hermes MemOS 测试事实"))).toBe(
      true,
    );
    expect(timeline.some((trace) => trace.toolCalls.some((tc) => tc.name === "memory_search")))
      .toBe(true);

    const search = await second.core.searchMemory({
      agent: "hermes" as AgentKind,
      sessionId,
      query: "HERMES_MEMOS_E2E_0428 18800",
      topK: { tier1: 0, tier2: 5, tier3: 0 },
    });
    const traceIds = new Set(traces.map((trace) => trace.id));
    expect(search.hits.some((hit) => traceIds.has(hit.refId))).toBe(true);

    const logs = await second.core.listApiLogs({ toolName: "memory_search", limit: 20 });
    expect(logs.total).toBeGreaterThan(0);
  });
});
