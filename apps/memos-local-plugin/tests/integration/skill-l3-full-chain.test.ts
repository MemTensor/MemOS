/**
 * Full local-memory verification for the repaired Skill → L3 path.
 *
 * This deliberately keeps the same Chinese, JSON-tool evidence that used to
 * fail Skill verification, then feeds three compatible active L2 policies to
 * L3.  It proves the repaired boundaries in one deterministic SQLite run:
 * language steering, tool-name extraction, Skill persistence, L3 creation,
 * and idempotent L3 merge.
 */

import { afterEach, describe, expect, it } from "vitest";

import { rootLogger } from "../../core/logger/index.js";
import {
  createL3EventBus,
  runL3,
  type L3Config,
  type L3Event,
} from "../../core/memory/l3/index.js";
import { L3_ABSTRACTION_PROMPT } from "../../core/llm/prompts/l3-abstraction.js";
import { runL2, type L2Config } from "../../core/memory/l2/index.js";
import {
  createSkillEventBus,
  runSkill,
  type SkillEvent,
} from "../../core/skill/index.js";
import type { EpisodeId } from "../../core/types.js";
import { fakeLlm } from "../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../helpers/tmp-db.js";
import {
  makeDraft,
  makeSkillConfig,
  seedSessionOnly,
  seedTrace,
} from "../unit/skill/_helpers.js";

const L3_OP = `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`;
const log = rootLogger.child({ channel: "integration.skill-l3" });

function l3Config(): L3Config {
  return {
    minPolicies: 3,
    minPolicyGain: 0.1,
    minPolicySupport: 2,
    clusterMinSimilarity: 0.3,
    maxPoliciesPerCluster: 20,
    maxPromptChars: 32_000,
    looseMinCohesion: 0.55,
    policyCharCap: 800,
    traceCharCap: 500,
    traceEvidencePerPolicy: 1,
    useLlm: true,
    cooldownDays: 0,
    confidenceDelta: 0.1,
    minConfidenceForRetrieval: 0.2,
  };
}

function l2Config(): L2Config {
  return {
    minSimilarity: 0.95,
    candidateTtlDays: 30,
    gamma: 0.9,
    tauSoftmax: 0.4,
    useLlm: true,
    minTraceValue: 0.1,
    minEpisodesForInduction: 2,
    inductionTraceCharCap: 2_000,
    gainEmaAlpha: 0.4,
  };
}

describe("integration: Chinese Skill crystallization → L3 world model", () => {
  let handle: TmpDbHandle | null = null;

  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  it("completes Skill verification and creates then merges one L3 model", async () => {
    handle = makeTmpDb();
    const h = handle;
    const groups = [
      { packageName: "cryptography", errorCode: "EXIT_1", vector: [1, 0, 0] },
      { packageName: "lxml", errorCode: "EXIT_2", vector: [0, 1, 0] },
      { packageName: "psycopg2", errorCode: "EXIT_3", vector: [0, 0, 1] },
    ] as const;
    for (const [groupIndex, group] of groups.entries()) {
      for (let repetition = 0; repetition < 2; repetition += 1) {
        const episodeId = `ep_chain_${groupIndex + 1}_${repetition + 1}` as EpisodeId;
        const sessionId = `s_chain_${groupIndex}_${repetition}`;
        const toolCalls = [
          {
            name: "pip",
            input: JSON.stringify({ package: group.packageName }),
            output: `Error: ${group.errorCode}`,
          },
          { name: "execute_code", input: '{"code":"print(1)"}' },
        ];
        seedSessionOnly(h, sessionId);
        seedTrace(h, {
          episodeId,
          sessionId,
          userText: `在 Alpine 镜像中安装 ${group.packageName} 失败`,
          agentText: `先执行 apk add ${group.packageName}-dev，再执行 pip install ${group.packageName}`,
          reflection: "先安装系统库，再重试 pip 安装",
          value: 0.9,
          tags: ["alpine", "pip"],
          vec: new Float32Array(group.vector),
          toolCalls,
        });
      }
    }

    const skillEvents: SkillEvent[] = [];
    const skillBus = createSkillEventBus();
    skillBus.onAny((event) => skillEvents.push(event));
    const skillPrompts: unknown[] = [];
    let inductionCount = 0;
    const llm = fakeLlm({
      completeJson: {
        "l2.l2.induction.v2": () => {
          const group = groups[inductionCount++] ?? groups[0];
          return {
            title: `Alpine ${group.packageName} dependency repair`,
            trigger: `pip install ${group.packageName} fails in Alpine`,
            procedure: `apk add ${group.packageName}-dev then pip install ${group.packageName}`,
            verification: `${group.packageName} installs successfully`,
            boundary: "仅适用于 Alpine 镜像",
            rationale: "多次观察到 Alpine 原生依赖缺失",
            caveats: ["Alpine 使用 musl libc"],
            confidence: 0.8,
          };
        },
        "skill.crystallize": (input) => {
          skillPrompts.push(input);
          return makeDraft({
            name: "alpine_cryptography_fix",
            displayTitle: "Alpine cryptography 安装修复",
            summary: "在 Alpine 中先安装系统库，再重试 pip 安装 cryptography",
            preconditions: ["当前环境是 Alpine 镜像"],
            steps: [
              { title: "检查错误", body: "确认 pip install cryptography 安装失败" },
              { title: "安装系统库", body: "执行 apk add openssl-dev" },
              { title: "重新安装", body: "再次执行 pip install cryptography" },
            ],
            tools: ["execute_code"],
            tags: ["alpine", "pip"],
          });
        },
        [L3_OP]: () => ({
          title: "Alpine Python dependency environment",
          domain_tags: ["alpine", "python", "pip"],
          environment: [
            {
              label: "Alpine uses musl libc",
              description: "Alpine images commonly lack glibc-linked build dependencies by default.",
            },
          ],
          inference: [
            {
              label: "Native extensions need system headers",
              description: "Python packages with native extensions fail to build when matching headers are absent.",
            },
          ],
          constraints: [],
          body: "# Alpine Python dependency environment",
          confidence: 0.75,
          supersedes_world_ids: [],
        }),
      },
    });

    const l2Runs = [];
    const l2Deps = {
      db: h.db,
      repos: h.repos,
      llm,
      log,
      config: l2Config(),
      thresholds: { minSupport: 2, minGain: 0.1, archiveGain: -0.05 },
    };
    for (const group of groups) {
      const traces = h.repos.traces
        .list({ limit: 20 })
        .filter((trace) => trace.userText.includes(group.packageName));
      expect(traces).toHaveLength(2);
      for (const trace of traces) {
        l2Runs.push(
          await runL2(
            {
              episodeId: trace.episodeId,
              sessionId: trace.sessionId,
              traces: [trace],
              trigger: "reward.updated",
            },
            l2Deps,
          ),
        );
      }
    }

    const inducedPolicies = h.repos.policies.list({ status: "active" });
    expect(l2Runs.flatMap((run) => run.inductions).filter((induction) => induction.policyId))
      .toHaveLength(3);
    expect(inducedPolicies).toHaveLength(3);
    const p1 = inducedPolicies.find((policy) => policy.title.includes("cryptography"));
    expect(p1).toBeDefined();
    expect(p1!.metadata?.domainTags).toEqual(["alpine", "pip"]);
    expect(p1!.metadata?.toolNames).toEqual(["pip", "execute_code"]);

    const skillResult = await runSkill(
      { trigger: "manual", policyId: p1!.id, episodeId: p1!.sourceEpisodeIds[0] },
      {
        repos: h.repos,
        embedder: null,
        llm,
        log,
        bus: skillBus,
        config: makeSkillConfig({ minSupport: 2, minGain: 0.1 }),
      },
    );

    expect(skillResult).toMatchObject({ evaluated: 1, crystallized: 1, rejected: 0 });
    expect(skillEvents).toContainEqual(
      expect.objectContaining({ kind: "skill.crystallized", policyId: p1!.id }),
    );
    expect(skillEvents.some((event) => event.kind === "skill.verification.failed")).toBe(false);

    const messages = skillPrompts[0] as Array<{ role: string; content: string }>;
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: expect.stringContaining("简体中文") }),
      ]),
    );
    const payload = JSON.parse(messages.find((message) => message.role === "user")!.content) as {
      evidence_tools: string[];
    };
    expect(payload.evidence_tools).toEqual(["pip", "execute_code"]);
    expect(payload.evidence_tools).not.toContain('{"code":');

    const storedSkill = h.repos.skills.list()[0]!;
    expect(storedSkill.status).toBe("candidate");
    expect(storedSkill.sourcePolicyIds).toContain(p1!.id);

    const l3Events: L3Event[] = [];
    const l3Bus = createL3EventBus();
    l3Bus.onAny((event) => l3Events.push(event));
    const l3Deps = {
      repos: h.repos,
      llm,
      log,
      bus: l3Bus,
      config: l3Config(),
    };

    const created = await runL3(
      { trigger: "l2.policy.induced", episodeId: p1!.sourceEpisodeIds[0] },
      l3Deps,
    );
    expect(created.abstractions).toHaveLength(1);
    expect(created.abstractions[0]).toMatchObject({
      clusterKey: "alpine|pip",
      policyCount: 3,
      createdNew: true,
      skippedReason: null,
    });
    expect(h.repos.worldModel.list()).toHaveLength(1);
    expect(l3Events).toContainEqual(expect.objectContaining({ kind: "l3.world-model.created" }));

    const merged = await runL3({ trigger: "manual" }, l3Deps);
    expect(merged.abstractions).toHaveLength(1);
    expect(merged.abstractions[0]!.createdNew).toBe(false);
    expect(merged.abstractions[0]!.mergedIntoWorldId).toBe(created.abstractions[0]!.worldModelId);
    expect(h.repos.worldModel.list()).toHaveLength(1);
    expect(l3Events).toContainEqual(expect.objectContaining({ kind: "l3.world-model.updated" }));
  });
});
