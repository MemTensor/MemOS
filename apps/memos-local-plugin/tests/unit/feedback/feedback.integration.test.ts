import { afterEach, describe, it, expect, vi } from "vitest";

import { createFeedbackEventBus } from "../../../core/feedback/events.js";
import {
  attachRepairToPolicies,
  runRepair,
  type RepairDeps,
} from "../../../core/feedback/feedback.js";
import { contextHashOf } from "../../../core/feedback/signals.js";
import { rootLogger } from "../../../core/logger/index.js";
import type {
  DecisionRepairRow,
  EpisodeId,
  EpochMs,
  PolicyId,
  SessionId,
  TraceId,
} from "../../../core/types.js";
import { fakeLlm } from "../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import {
  makeFeedbackConfig,
  seedPolicy,
  seedSessionOnly,
  seedTrace,
} from "./_helpers.js";

let handle: TmpDbHandle | null = null;
afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function baseDeps(h: TmpDbHandle, overrides: Partial<RepairDeps> = {}): RepairDeps {
  return {
    repos: h.repos,
    llm: null,
    embedder: null,
    bus: createFeedbackEventBus(),
    log: rootLogger.child({ channel: "test.feedback" }),
    config: makeFeedbackConfig({ useLlm: false, cooldownMs: 0 }),
    ...overrides,
  };
}

function seedPipInstallScenario(h: TmpDbHandle, sessionId = "s1") {
  const episodeId = "ep1" as EpisodeId;
  seedSessionOnly(h, sessionId);
  seedTrace(h, {
    id: "t_hi1",
    episodeId: episodeId as string,
    sessionId,
    userText: "retry pip install with openssl-dev",
    agentText: "apk add openssl-dev && pip install cryptography succeeded",
    reflection: "Install system deps before pip on alpine",
    value: 0.9,
  });
  seedTrace(h, {
    id: "t_lo1",
    episodeId: episodeId as string,
    sessionId,
    userText: "pip install cryptography",
    agentText:
      "Error: cryptography build failed: MODULE_NOT_FOUND (libffi)",
    reflection: null,
    value: -0.7,
  });
  return { episodeId };
}

describe("feedback/runRepair (integration)", () => {
  it("persists a template draft and returns a non-skipped result", async () => {
    handle = makeTmpDb();
    const h = handle;
    const { episodeId } = seedPipInstallScenario(h);
    seedPolicy(h, {
      id: "po_alpine_pip" as PolicyId,
      sourceEpisodeIds: [episodeId],
    });

    const bus = createFeedbackEventBus();
    const events: string[] = [];
    bus.onAny((e) => events.push(e.kind));

    const deps = baseDeps(h, { bus });
    const result = await runRepair(
      {
        trigger: "user.negative",
        contextHash: "ctx_alpine_pip",
        sessionId: "s1" as SessionId,
        userText: "no, that didn't work",
      },
      deps,
    );
    expect(result.skipped).toBe(false);
    expect(result.draft?.preference).toBeTruthy();
    expect(result.draft?.antiPattern).toBeTruthy();
    expect(result.repairId).toMatch(/^dr_/);

    const stored = h.repos.decisionRepairs.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.contextHash).toBe("ctx_alpine_pip");
    expect(events).toEqual(
      expect.arrayContaining([
        "feedback.classified",
        "repair.triggered",
        "repair.persisted",
        "repair.attached",
      ]),
    );
  });

  it("LLM path uses the decision-repair prompt output when enabled", async () => {
    handle = makeTmpDb();
    const h = handle;
    seedPipInstallScenario(h);

    const llm = fakeLlm({
      completeJson: {
        "decision.repair": {
          preference: "Use apk add openssl-dev then pip install cryptography",
          anti_pattern: "Running pip install cryptography before apk add",
          severity: "warn",
          confidence: 0.82,
        },
      },
    });

    const result = await runRepair(
      {
        trigger: "user.negative",
        contextHash: "ctx_alpine_pip_llm",
        sessionId: "s1" as SessionId,
        userText: "use apk add openssl-dev instead of skipping",
      },
      baseDeps(h, {
        llm,
        config: makeFeedbackConfig({ useLlm: true, cooldownMs: 0 }),
      }),
    );
    expect(result.skipped).toBe(false);
    expect(result.draft?.preference).toContain("apk add openssl-dev");
    expect(result.draft?.antiPattern).toContain("cryptography");
    const rows = h.repos.decisionRepairs.list();
    expect(rows[0]!.preference).toContain("apk add");
    expect(rows[0]!.antiPattern).toContain("cryptography");
  });

  it("is idempotent under cooldown — repeat within cooldown returns skipped(cooldown)", async () => {
    handle = makeTmpDb();
    const h = handle;
    seedPipInstallScenario(h);

    const deps = baseDeps(h, {
      config: makeFeedbackConfig({ useLlm: false, cooldownMs: 10_000 }),
    });

    const first = await runRepair(
      {
        trigger: "user.negative",
        contextHash: "ctx_cd",
        sessionId: "s1" as SessionId,
        userText: "no",
      },
      deps,
    );
    expect(first.skipped).toBe(false);

    const second = await runRepair(
      {
        trigger: "user.negative",
        contextHash: "ctx_cd",
        sessionId: "s1" as SessionId,
        userText: "still wrong",
      },
      deps,
    );
    expect(second.skipped).toBe(true);
    expect(second.skippedReason).toBe("cooldown");
    expect(h.repos.decisionRepairs.list()).toHaveLength(1);
  });

  it("skips when no sessionId is provided (can't gather evidence)", async () => {
    handle = makeTmpDb();
    const h = handle;
    const result = await runRepair(
      { trigger: "manual", contextHash: "ctx_nosess" },
      baseDeps(h),
    );
    expect(result.skipped).toBe(true);
    expect(result.skippedReason).toBe("no-session");
  });

  it("skips when value delta is below threshold and no user signal", async () => {
    handle = makeTmpDb();
    const h = handle;
    const sessionId = "s_delta";
    seedSessionOnly(h, sessionId);
    seedTrace(h, {
      episodeId: "ep_delta",
      sessionId,
      agentText: "ok result",
      value: 0.1,
    });
    seedTrace(h, {
      episodeId: "ep_delta",
      sessionId,
      agentText: "meh result",
      value: -0.05,
    });
    const deps = baseDeps(h, {
      config: makeFeedbackConfig({
        useLlm: false,
        cooldownMs: 0,
        valueDelta: 0.9,
      }),
    });
    const result = await runRepair(
      {
        trigger: "failure-burst",
        contextHash: "ctx_delta",
        sessionId: sessionId as SessionId,
      },
      deps,
    );
    expect(result.skipped).toBe(true);
    expect(result.skippedReason).toBe("value-delta-low");
  });

  it("fires when classifier detected a user signal even if value delta is small", async () => {
    handle = makeTmpDb();
    const h = handle;
    const sessionId = "s_delta2";
    seedSessionOnly(h, sessionId);
    seedTrace(h, {
      episodeId: "ep_delta2",
      sessionId,
      agentText: "ok result",
      reflection: "use A",
      value: 0.2,
    });
    seedTrace(h, {
      episodeId: "ep_delta2",
      sessionId,
      agentText: "meh result",
      reflection: "avoid B",
      value: -0.1,
    });
    const deps = baseDeps(h, {
      config: makeFeedbackConfig({
        useLlm: false,
        cooldownMs: 0,
        valueDelta: 0.9,
      }),
    });
    const result = await runRepair(
      {
        trigger: "user.preference",
        contextHash: "ctx_delta2",
        sessionId: sessionId as SessionId,
        userText: "use A instead of B",
      },
      deps,
    );
    expect(result.skipped).toBe(false);
  });

  it("skips with insufficient-evidence when the session is empty", async () => {
    handle = makeTmpDb();
    const h = handle;
    seedSessionOnly(h, "s_empty");
    const bus = createFeedbackEventBus();
    const skipEvents: string[] = [];
    bus.on("repair.skipped", (e) => {
      if (e.kind === "repair.skipped") skipEvents.push(e.reason);
    });
    const result = await runRepair(
      {
        trigger: "user.negative",
        contextHash: "ctx_empty",
        sessionId: "s_empty" as SessionId,
        userText: "no",
      },
      baseDeps(h, { bus }),
    );
    expect(result.skipped).toBe(true);
    expect(result.skippedReason).toBe("insufficient-evidence");
    expect(skipEvents).toContain("insufficient-evidence");
  });

  it("attachToPolicy=false does not update boundary even when drafts exist", async () => {
    handle = makeTmpDb();
    const h = handle;
    const { episodeId } = seedPipInstallScenario(h);
    const policy = seedPolicy(h, {
      id: "po_noattach" as PolicyId,
      sourceEpisodeIds: [episodeId],
      boundary: "original",
    });

    await runRepair(
      {
        trigger: "failure-burst",
        contextHash: "ctx_noattach",
        sessionId: "s1" as SessionId,
      },
      baseDeps(h, {
        config: makeFeedbackConfig({
          useLlm: false,
          cooldownMs: 0,
          attachToPolicy: false,
        }),
      }),
    );
    const after = h.repos.policies.getById(policy.id)!;
    expect(after.boundary).toBe("original");
  });

  it("attachToPolicy=true appends an @repair block to the policy boundary", async () => {
    handle = makeTmpDb();
    const h = handle;
    const { episodeId } = seedPipInstallScenario(h);
    const policy = seedPolicy(h, {
      id: "po_attach" as PolicyId,
      sourceEpisodeIds: [episodeId],
      boundary: "alpine musl",
    });

    await runRepair(
      {
        trigger: "user.negative",
        contextHash: "ctx_attach",
        sessionId: "s1" as SessionId,
        userText: "no, use apk add openssl-dev first",
      },
      baseDeps(h),
    );
    const after = h.repos.policies.getById(policy.id)!;
    expect(after.boundary).toContain("@repair");
    expect(after.boundary).toContain("preference");
    expect(after.boundary).toContain("antiPattern");
    expect(after.boundary.startsWith("alpine musl")).toBe(true);
  });

  it("attachRepairToPolicies dedupes and skips unchanged guidance blocks", async () => {
    handle = makeTmpDb();
    const h = handle;
    seedPipInstallScenario(h);
    const policyId = "po_dedup" as PolicyId;
    seedPolicy(h, {
      id: policyId,
      boundary: '@repair {"preference":["Prefer: do X"],"antiPattern":["Avoid: do Y"]}',
    });

    const updated = attachRepairToPolicies(
      {
        contextHash: "c",
        preference: "Prefer: do X",
        antiPattern: "Avoid: do Y",
        highValueTraceIds: [] as TraceId[],
        lowValueTraceIds: [] as TraceId[],
        severity: "warn",
        confidence: 0.5,
        attachToPolicyIds: [policyId],
      },
      { repos: h.repos, log: rootLogger.child({ channel: "test.attach" }) },
    );
    expect(updated).toHaveLength(0);

    const updated2 = attachRepairToPolicies(
      {
        contextHash: "c",
        preference: "Prefer: do Z",
        antiPattern: "Avoid: do W",
        highValueTraceIds: [] as TraceId[],
        lowValueTraceIds: [] as TraceId[],
        severity: "warn",
        confidence: 0.5,
        attachToPolicyIds: [policyId],
      },
      { repos: h.repos, log: rootLogger.child({ channel: "test.attach" }) },
    );
    expect(updated2).toEqual([policyId]);
    const p = h.repos.policies.getById(policyId)!;
    expect(p.boundary).toContain("Prefer: do Z");
    expect(p.boundary).toContain("Avoid: do W");
    // Old keys preserved
    expect(p.boundary).toContain("Prefer: do X");
    expect(p.boundary).toContain("Avoid: do Y");
  });

  it("contextHash flows through persist + cooldown consistently", async () => {
    handle = makeTmpDb();
    const h = handle;
    seedPipInstallScenario(h);
    const hash = contextHashOf("pip.install", "alpine");
    const deps = baseDeps(h, {
      config: makeFeedbackConfig({ useLlm: false, cooldownMs: 5_000 }),
    });
    const r = await runRepair(
      {
        trigger: "failure-burst",
        contextHash: hash,
        sessionId: "s1" as SessionId,
      },
      deps,
    );
    expect(r.skipped).toBe(false);
    const stored: DecisionRepairRow[] = h.repos.decisionRepairs.recentForContext(hash);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.contextHash).toBe(hash);
  });
});
