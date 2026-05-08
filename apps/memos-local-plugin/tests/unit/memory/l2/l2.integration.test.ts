/**
 * End-to-end integration for `core/memory/l2/l2.ts`.
 *
 * Scenario mirrors V7 §2.4.5 example 1 (container + pip):
 *   - episode A: Alpine / lxml → xmlsec1 missing  → V=+0.8
 *   - episode B: Debian / psycopg2 → pg_config    → V=+0.9
 *  Same primary tag (pip/docker) and same errCode (EXIT_1 here) but
 *  different tools. Expected: both traces land in a single candidate bucket;
 *  after the second episode the bucket clears `minEpisodesForInduction` and
 *  the mocked LLM mints a new `candidate` policy.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createL2EventBus,
  runL2,
  type L2Config,
  type L2Event,
} from "../../../../core/memory/l2/index.js";
import { makeCandidatePool } from "../../../../core/memory/l2/candidate-pool.js";
import { rootLogger } from "../../../../core/logger/index.js";
import type {
  EmbeddingVector,
  EpisodeId,
  SessionId,
  TraceRow,
} from "../../../../core/types.js";
import { fakeLlm } from "../../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../../helpers/tmp-db.js";
import { ensureEpisode, toolCalls as tc, type PartialToolCall } from "./_helpers.js";

const NOW = 1_700_000_000_000;

function cfg(): L2Config {
  return {
    minSimilarity: 0.8,
    candidateTtlDays: 30,
    gamma: 0.9,
    tauSoftmax: 0.4,
    useLlm: true,
    minTraceValue: 0.1,
    minEpisodesForInduction: 2,
    inductionTraceCharCap: 2_000,
  };
}

function vec(values: readonly number[]): EmbeddingVector {
  return new Float32Array(values) as unknown as EmbeddingVector;
}

type TraceOverrides = Omit<Partial<TraceRow>, "toolCalls"> & {
  id: string;
  episodeId: string;
  toolCalls?: readonly PartialToolCall[];
};

function mkTrace(partial: TraceOverrides): TraceRow {
  return {
    id: partial.id as TraceRow["id"],
    episodeId: partial.episodeId as TraceRow["episodeId"],
    sessionId: "s_int" as TraceRow["sessionId"],
    ts: NOW as TraceRow["ts"],
    userText: partial.userText ?? "",
    agentText: partial.agentText ?? "",
    toolCalls: partial.toolCalls ? tc(partial.toolCalls) : [],
    reflection: partial.reflection ?? null,
    value: partial.value ?? 0.8,
    alpha: (partial.alpha ?? 0.5) as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: partial.tags ?? [],
    vecSummary: partial.vecSummary ?? null,
    vecAction: partial.vecAction ?? null,
    turnId: 0 as never,
    schemaVersion: 1,
  };
}

describe("memory/l2/integration", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  it("adds candidates on episode A, induces new policy on episode B", async () => {
    ensureEpisode(handle, "ep_A", "s_int");
    ensureEpisode(handle, "ep_B", "s_int");
    ensureEpisode(handle, "ep_C", "s_int");
    // ── Episode A: Alpine + lxml, no existing L2 → ends up in candidate pool
    const trA = mkTrace({
      id: "tr_a",
      episodeId: "ep_A",
      tags: ["docker", "pip"],
      toolCalls: [
        { name: "pip.install", input: { pkg: "lxml" }, output: "Error: MODULE_NOT_FOUND xmlsec1" },
      ],
      reflection: "alpine missing system lib",
      value: 0.8,
      alpha: 0.6 as TraceRow["alpha"],
      vecSummary: vec([1, 0, 0]),
    });
    handle.repos.traces.insert(trA);

    const bus = createL2EventBus();
    const events: L2Event[] = [];
    bus.onAny((e) => events.push(e));

    const llm = fakeLlm({
      completeJson: {
        "l2.l2.induction.v2": {
          title: "install missing system libs in container",
          trigger: "pip install fails in container with MODULE_NOT_FOUND due to missing system lib",
          procedure: "1. detect lib 2. use distro pkg manager 3. retry pip",
          verification: "pip install succeeds",
          boundary: "native systems with dev libs present",
          rationale: "container images don't ship dev libs",
          caveats: ["alpine uses musl libc"],
          confidence: 0.78,
        },
      },
    });

    const depsA = {
      db: handle.db,
      repos: handle.repos,
      llm,
      log: rootLogger.child({ channel: "core.memory.l2" }),
      bus,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    };

    const runA = await runL2(
      {
        episodeId: "ep_A" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [trA],
        trigger: "manual",
      },
      depsA,
    );
    expect(runA.inductions).toHaveLength(0);
    expect(runA.associations[0].matchedPolicyId).toBeNull();
    expect(runA.associations[0].addedToCandidatePool).toBe(true);
    expect(events.some((e) => e.kind === "l2.candidate.added")).toBe(true);

    // ── Episode B: Debian + psycopg2, same primary tag + errCode
    const trB = mkTrace({
      id: "tr_b",
      episodeId: "ep_B",
      tags: ["docker", "pip"],
      toolCalls: [
        { name: "pip.install", input: { pkg: "psycopg2" }, output: "Error: MODULE_NOT_FOUND pg_config" },
      ],
      reflection: "debian missing pg dev lib",
      value: 0.9,
      alpha: 0.5 as TraceRow["alpha"],
      vecSummary: vec([0.98, 0.2, 0]),
    });
    handle.repos.traces.insert(trB);

    const runB = await runL2(
      {
        episodeId: "ep_B" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [trB],
        trigger: "manual",
      },
      depsA,
    );
    expect(runB.inductions).toHaveLength(1);
    const induced = runB.inductions[0];
    expect(induced.policyId).not.toBeNull();
    expect(induced.skippedReason).toBeNull();
    expect(induced.episodeIds.sort()).toEqual(["ep_A", "ep_B"]);
    expect(
      events.some((e) => e.kind === "l2.policy.induced" && e.policyId === induced.policyId),
    ).toBe(true);

    // ── Policy exists and candidate-pool rows were promoted
    const persisted = handle.repos.policies.getById(induced.policyId!)!;
    expect(persisted.status).toBe("candidate");
    expect(persisted.sourceEpisodeIds.sort()).toEqual(["ep_A", "ep_B"]);

    // ── A third run with a trace that cosine-matches the new policy should
    //    associate (not re-induce) and bump gain/support.
    const trC = mkTrace({
      id: "tr_c",
      episodeId: "ep_C",
      tags: ["docker", "pip"],
      toolCalls: [
        { name: "pip.install", input: { pkg: "Pillow" }, output: "Error: MODULE_NOT_FOUND jpeg" },
      ],
      value: 0.85,
      vecSummary: persisted.vec, // re-use policy vector so it *always* matches
    });
    handle.repos.traces.insert(trC);

    const runC = await runL2(
      {
        episodeId: "ep_C" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [trC],
        trigger: "manual",
      },
      depsA,
    );
    expect(runC.associations[0].matchedPolicyId).toBe(induced.policyId);
    const afterC = handle.repos.policies.getById(induced.policyId!)!;
    expect(afterC.support).toBeGreaterThan(0);
  });

  it("uses duplicate bucket evidence as with-traces when updating an existing policy", async () => {
    ensureEpisode(handle, "ep_A", "s_int");
    ensureEpisode(handle, "ep_B", "s_int");

    const trA = mkTrace({
      id: "tr_dup_a",
      episodeId: "ep_A",
      tags: ["docker"],
      toolCalls: [
        { name: "pip.install", input: { pkg: "lxml" }, output: "Error: MODULE_NOT_FOUND xmlsec1" },
      ],
      value: 0.82,
      vecSummary: vec([1, 0, 0]),
    });
    const trB = mkTrace({
      id: "tr_dup_b",
      episodeId: "ep_B",
      tags: ["docker"],
      toolCalls: [
        { name: "pip.install", input: { pkg: "psycopg2" }, output: "Error: MODULE_NOT_FOUND pg_config" },
      ],
      value: 0.86,
      vecSummary: vec([1, 0, 0]),
    });
    handle.repos.traces.insert(trA);
    handle.repos.traces.insert(trB);

    const pool = makeCandidatePool({ db: handle.db, repos: handle.repos });
    const ttlMs = cfg().candidateTtlDays * 24 * 60 * 60 * 1000;
    pool.addCandidate({ trace: trA, ttlMs, now: NOW });
    pool.addCandidate({ trace: trB, ttlMs, now: NOW });

    handle.repos.policies.insert({
      id: "po_existing" as never,
      title: "install missing system libraries before retrying pip",
      trigger: "docker pip install fails with missing native dependency",
      procedure: "install the matching distro package, then retry pip",
      verification: "pip install succeeds",
      boundary: "non-container environments with libraries already present",
      support: 0,
      gain: 0,
      status: "active",
      sourceEpisodeIds: [],
      inducedBy: "unit-test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: vec([1, 0, 0]),
      createdAt: NOW as never,
      updatedAt: NOW as never,
    });

    const bus = createL2EventBus();
    const events: L2Event[] = [];
    bus.onAny((e) => events.push(e));

    const result = await runL2(
      {
        episodeId: "ep_B" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [],
        trigger: "manual",
        now: NOW,
      },
      {
        db: handle.db,
        repos: handle.repos,
        llm: fakeLlm({ completeJson: {} }),
        log: rootLogger.child({ channel: "core.memory.l2" }),
        bus,
        config: cfg(),
        thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
      },
    );

    expect(result.inductions).toHaveLength(1);
    expect(result.inductions[0].skippedReason).toBe("duplicate_of");
    expect(result.inductions[0].duplicateOfPolicyId).toBe("po_existing");

    const updated = handle.repos.policies.getById("po_existing" as never)!;
    expect(updated.support).toBe(2);
    expect(updated.gain).toBeGreaterThan(0.3);
    expect(updated.status).toBe("active");
    expect(
      events.some(
        (e) =>
          e.kind === "l2.policy.updated" &&
          e.policyId === "po_existing" &&
          e.gain > 0,
      ),
    ).toBe(true);
  });

  it("reuses an existing policy when induction returns duplicate content", async () => {
    ensureEpisode(handle, "ep_A", "s_int");
    ensureEpisode(handle, "ep_B", "s_int");

    const trA = mkTrace({
      id: "tr_content_dup_a",
      episodeId: "ep_A",
      tags: ["chat"],
      userText: "今天天气不错",
      agentText: "是的，适合出门。",
      value: 0.82,
      vecSummary: vec([1, 0, 0]),
    });
    const trB = mkTrace({
      id: "tr_content_dup_b",
      episodeId: "ep_B",
      tags: ["chat"],
      userText: "聊聊天",
      agentText: "当然可以。",
      value: 0.86,
      vecSummary: vec([0, 1, 0]),
    });
    handle.repos.traces.insert(trA);
    handle.repos.traces.insert(trB);

    const pool = makeCandidatePool({ db: handle.db, repos: handle.repos });
    const ttlMs = cfg().candidateTtlDays * 24 * 60 * 60 * 1000;
    pool.addCandidate({ trace: trA, ttlMs, now: NOW });
    pool.addCandidate({ trace: trB, ttlMs, now: NOW });

    handle.repos.policies.insert({
      id: "po_content_existing" as never,
      title: "闲聊场景下避免使用emoji",
      trigger: "用户发起非任务性闲聊，且未明确要求使用emoji",
      procedure: "以简洁、自然的文字回应，但不添加任何emoji或表情符号",
      verification: "回复不包含emoji",
      boundary: "用户明确要求使用emoji时不适用",
      support: 3,
      gain: 0.2,
      status: "active",
      sourceEpisodeIds: ["ep_A" as EpisodeId],
      inducedBy: "unit-test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: null,
      createdAt: NOW as never,
      updatedAt: NOW as never,
    });

    const result = await runL2(
      {
        episodeId: "ep_B" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [],
        trigger: "manual",
        now: NOW + 1,
      },
      {
        db: handle.db,
        repos: handle.repos,
        llm: fakeLlm({
          completeJson: {
            "l2.l2.induction.v2": {
              title: " 闲聊场景下避免使用emoji ",
              trigger: "用户发起非任务性闲聊，且未明确要求使用emoji",
              procedure: "以简洁、自然的文字回应，但不添加任何emoji或表情符号",
              verification: "回复不包含emoji",
              boundary: "用户明确要求使用emoji时不适用",
              rationale: "保持简洁",
              caveats: [],
              confidence: 0.8,
            },
          },
        }),
        log: rootLogger.child({ channel: "core.memory.l2" }),
        bus: createL2EventBus(),
        config: cfg(),
        thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
      },
    );

    expect(result.inductions).toHaveLength(1);
    expect(result.inductions[0].skippedReason).toBe("duplicate_of");
    expect(result.inductions[0].duplicateOfPolicyId).toBe("po_content_existing");
    const policies = handle.repos.policies.list({ limit: 10 });
    expect(policies).toHaveLength(1);
    const existing = handle.repos.policies.getById("po_content_existing" as never)!;
    expect(existing.sourceEpisodeIds.sort()).toEqual(["ep_A", "ep_B"]);
    expect(existing.support).toBeGreaterThan(3);
  });

  it("reuses an existing policy when induction returns a near-duplicate wording", async () => {
    ensureEpisode(handle, "ep_weather_a", "s_int");
    ensureEpisode(handle, "ep_weather_b", "s_int");

    const trA = mkTrace({
      id: "tr_policy_near_dup_a",
      episodeId: "ep_weather_a",
      tags: ["weather", "api"],
      userText: "查一下北京天气",
      agentText: "以结构化格式展示天气、气温、湿度和风速。",
      value: 0.83,
      vecSummary: vec([1, 0, 0]),
    });
    const trB = mkTrace({
      id: "tr_policy_near_dup_b",
      episodeId: "ep_weather_b",
      tags: ["weather", "api"],
      userText: "海南现在天气怎么样",
      agentText: "提取天气 API 字段并给出简短建议。",
      value: 0.87,
      vecSummary: vec([0, 1, 0]),
    });
    handle.repos.traces.insert(trA);
    handle.repos.traces.insert(trB);

    const pool = makeCandidatePool({ db: handle.db, repos: handle.repos });
    const ttlMs = cfg().candidateTtlDays * 24 * 60 * 60 * 1000;
    pool.addCandidate({ trace: trA, ttlMs, now: NOW });
    pool.addCandidate({ trace: trB, ttlMs, now: NOW });

    handle.repos.policies.insert({
      id: "po_weather_existing" as never,
      title: "结构化呈现外部数据查询结果",
      trigger: "agent通过工具调用获取到外部数据源的原始响应（天气API、搜索结果、数据库查询等），需要向用户呈现信息",
      procedure: "1) 从原始数据中提取关键信息字段；2) 按逻辑分类组织信息（如天气按：天气状况/气温/湿度/风速/降水分类）；3) 使用结构化格式呈现（emoji图标+粗体标签+数值，或分段文本）；4) 添加简短的实用性总结或建议",
      verification: "",
      boundary: "",
      support: 3,
      gain: 0.2,
      status: "active",
      sourceEpisodeIds: ["ep_weather_a" as EpisodeId],
      inducedBy: "unit-test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: null,
      createdAt: NOW as never,
      updatedAt: NOW as never,
    });

    const result = await runL2(
      {
        episodeId: "ep_weather_b" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [],
        trigger: "manual",
        now: NOW + 1,
      },
      {
        db: handle.db,
        repos: handle.repos,
        llm: fakeLlm({
          completeJson: {
            "l2.l2.induction.v2": {
              title: "结构化呈现外部数据查询结果",
              trigger: "agent通过工具调用获取到外部数据源的原始响应（搜索结果、API返回、数据库查询等），需要向用户呈现信息",
              procedure: "1) 从原始数据中提取关键信息要素；2) 按逻辑分类组织信息（时间、地点、数值、状态等）；3) 使用结构化格式呈现（分类标题、列表、表格等）；4) 可选：基于数据添加简短的实用性总结或建议",
              verification: "",
              boundary: "",
              rationale: "提升外部数据可读性",
              caveats: [],
              confidence: 0.8,
            },
          },
        }),
        log: rootLogger.child({ channel: "core.memory.l2" }),
        bus: createL2EventBus(),
        config: cfg(),
        thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
      },
    );

    expect(result.inductions).toHaveLength(1);
    expect(result.inductions[0].skippedReason).toBe("duplicate_of");
    expect(result.inductions[0].duplicateOfPolicyId).toBe("po_weather_existing");
    expect(handle.repos.policies.list({ limit: 10 })).toHaveLength(1);
    const existing = handle.repos.policies.getById("po_weather_existing" as never)!;
    expect(existing.sourceEpisodeIds.sort()).toEqual(["ep_weather_a", "ep_weather_b"]);
  });

  it("does not merge duplicate-looking policies when explicit boundaries conflict", async () => {
    ensureEpisode(handle, "ep_boundary_a", "s_int");
    ensureEpisode(handle, "ep_boundary_b", "s_int");

    const trA = mkTrace({
      id: "tr_policy_boundary_a",
      episodeId: "ep_boundary_a",
      tags: ["format"],
      userText: "展示天气数据",
      agentText: "以清晰格式展示天气结果。",
      value: 0.83,
      vecSummary: vec([1, 0, 0]),
    });
    const trB = mkTrace({
      id: "tr_policy_boundary_b",
      episodeId: "ep_boundary_b",
      tags: ["format"],
      userText: "展示数据库事务结果",
      agentText: "以清晰格式展示事务结果。",
      value: 0.87,
      vecSummary: vec([0, 1, 0]),
    });
    handle.repos.traces.insert(trA);
    handle.repos.traces.insert(trB);

    const pool = makeCandidatePool({ db: handle.db, repos: handle.repos });
    const ttlMs = cfg().candidateTtlDays * 24 * 60 * 60 * 1000;
    pool.addCandidate({ trace: trA, ttlMs, now: NOW });
    pool.addCandidate({ trace: trB, ttlMs, now: NOW });

    const shared = {
      title: "结构化呈现外部数据查询结果",
      trigger: "agent通过工具调用获取到外部数据源的原始响应，需要向用户呈现信息",
      procedure: "1) 提取关键信息字段；2) 按逻辑分类组织信息；3) 使用结构化格式呈现；4) 添加简短总结",
      verification: "",
    };
    handle.repos.policies.insert({
      id: "po_boundary_existing" as never,
      ...shared,
      boundary: "仅适用于天气API和公开搜索结果，不适用于数据库事务或写入操作",
      support: 3,
      gain: 0.2,
      status: "active",
      sourceEpisodeIds: ["ep_boundary_a" as EpisodeId],
      inducedBy: "unit-test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: null,
      createdAt: NOW as never,
      updatedAt: NOW as never,
    });

    const result = await runL2(
      {
        episodeId: "ep_boundary_b" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [],
        trigger: "manual",
        now: NOW + 1,
      },
      {
        db: handle.db,
        repos: handle.repos,
        llm: fakeLlm({
          completeJson: {
            "l2.l2.induction.v2": {
              ...shared,
              boundary: "仅适用于数据库事务和写入操作，不适用于天气API或公开搜索结果",
              rationale: "边界不同，不能复用天气呈现经验",
              caveats: [],
              confidence: 0.8,
            },
          },
        }),
        log: rootLogger.child({ channel: "core.memory.l2" }),
        bus: createL2EventBus(),
        config: cfg(),
        thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
      },
    );

    expect(result.inductions).toHaveLength(1);
    expect(result.inductions[0].skippedReason).toBeNull();
    expect(handle.repos.policies.list({ limit: 10 })).toHaveLength(2);
  });

  it("reuses an existing policy when procedures are rewritten but title and trigger match", async () => {
    ensureEpisode(handle, "ep_tool_fail_a", "s_int");
    ensureEpisode(handle, "ep_tool_fail_b", "s_int");

    const trA = mkTrace({
      id: "tr_tool_fail_a",
      episodeId: "ep_tool_fail_a",
      tags: ["search", "fallback"],
      userText: "查实时信息但搜索失败",
      agentText: "说明搜索工具失效并回退到已有知识。",
      value: 0.84,
      vecSummary: vec([1, 0, 0]),
    });
    const trB = mkTrace({
      id: "tr_tool_fail_b",
      episodeId: "ep_tool_fail_b",
      tags: ["search", "fallback"],
      userText: "多个搜索源都不可用",
      agentText: "坦诚说明失败原因并提示时效性。",
      value: 0.86,
      vecSummary: vec([0, 1, 0]),
    });
    handle.repos.traces.insert(trA);
    handle.repos.traces.insert(trB);

    const pool = makeCandidatePool({ db: handle.db, repos: handle.repos });
    const ttlMs = cfg().candidateTtlDays * 24 * 60 * 60 * 1000;
    pool.addCandidate({ trace: trA, ttlMs, now: NOW });
    pool.addCandidate({ trace: trB, ttlMs, now: NOW });

    handle.repos.policies.insert({
      id: "po_tool_fail_existing" as never,
      title: "工具全部失效时坦诚说明并回退到已有知识",
      trigger: "连续尝试多个同类工具（如多个搜索引擎、多个新闻源）后全部因反爬、封禁或网络问题失效，无法获取实时信息",
      procedure: "1) 明确告知用户所有尝试过的工具都已失效及原因（如'搜狗、360、百度全都被封了'）2) 回退到自身知识库，提供最接近的已知信息 3) 明确标注信息的时间戳和时效性限制（如'根据已有知识...2023年底到任'）4) 提醒用户当前时间与信息时间的差距，建议后续通过其他渠道确认",
      verification: "",
      boundary: "",
      support: 3,
      gain: 0.2,
      status: "active",
      sourceEpisodeIds: ["ep_tool_fail_a" as EpisodeId],
      inducedBy: "unit-test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: null,
      createdAt: NOW as never,
      updatedAt: NOW as never,
    });

    const result = await runL2(
      {
        episodeId: "ep_tool_fail_b" as EpisodeId,
        sessionId: "s_int" as SessionId,
        traces: [],
        trigger: "manual",
        now: NOW + 1,
      },
      {
        db: handle.db,
        repos: handle.repos,
        llm: fakeLlm({
          completeJson: {
            "l2.l2.induction.v2": {
              title: "工具全部失效时坦诚说明并回退到已有知识",
              trigger: "连续尝试多个同类工具（如多个搜索引擎、多个新闻源）后全部因反爬、封禁或网络错误失效，且用户问题需要实时信息",
              procedure: "1) 明确告知用户所有尝试过的工具都已失效（列出具体工具名）；2) 基于训练数据中的已有知识提供最接近的答案；3) 明确标注该信息的时间戳或来源时间，并提醒用户可能存在时效性差异；4) 建议用户通过其他渠道（如直接搜索、官方网站）验证",
              verification: "",
              boundary: "",
              rationale: "工具全部失效时需要透明说明并降低时效性风险",
              caveats: [],
              confidence: 0.8,
            },
          },
        }),
        log: rootLogger.child({ channel: "core.memory.l2" }),
        bus: createL2EventBus(),
        config: cfg(),
        thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
      },
    );

    expect(result.inductions).toHaveLength(1);
    expect(result.inductions[0].skippedReason).toBe("duplicate_of");
    expect(result.inductions[0].duplicateOfPolicyId).toBe("po_tool_fail_existing");
    expect(handle.repos.policies.list({ limit: 10 })).toHaveLength(1);
  });

  it("minEpisodesForInduction=3 suppresses induction until a third episode arrives", async () => {
    const cfg3 = { ...cfg(), minEpisodesForInduction: 3 };
    const bus = createL2EventBus();
    const events: L2Event[] = [];
    bus.onAny((e) => events.push(e));

    const llm = fakeLlm({
      completeJson: {
        "l2.l2.induction.v2": {
          title: "t",
          trigger: "tr",
          procedure: "pr",
          verification: "v",
          boundary: "b",
          rationale: "why",
          caveats: [],
          confidence: 0.5,
        },
      },
    });
    const deps = {
      db: handle.db,
      repos: handle.repos,
      llm,
      log: rootLogger.child({ channel: "core.memory.l2" }),
      bus,
      config: cfg3,
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    };

    const mk = (i: number, ep: string) => {
      ensureEpisode(handle, ep, "s_int");
      const t = mkTrace({
        id: `tr_${i}`,
        episodeId: ep,
        tags: ["docker", "pip"],
        toolCalls: [
          { name: "pip.install", input: {}, output: "Error: MODULE_NOT_FOUND x" },
        ],
        value: 0.8,
        vecSummary: vec([1, 0, 0]),
      });
      handle.repos.traces.insert(t);
      return t;
    };
    const t1 = mk(1, "ep_1");
    const t2 = mk(2, "ep_2");
    for (const t of [t1, t2]) {
      await runL2(
        {
          episodeId: t.episodeId,
          sessionId: t.sessionId,
          traces: [t],
          trigger: "manual",
        },
        deps,
      );
    }
    expect(events.filter((e) => e.kind === "l2.policy.induced")).toHaveLength(0);

    const t3 = mk(3, "ep_3");
    const r3 = await runL2(
      {
        episodeId: t3.episodeId,
        sessionId: t3.sessionId,
        traces: [t3],
        trigger: "manual",
      },
      deps,
    );
    expect(r3.inductions.some((i) => i.policyId !== null)).toBe(true);
  });
});
