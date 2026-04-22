import { afterEach, describe, it, expect } from "vitest";

import {
  capTrace,
  gatherRepairEvidence,
} from "../../../core/feedback/evidence.js";
import { rootLogger } from "../../../core/logger/index.js";
import type { EpisodeId, SessionId, TraceRow } from "../../../core/types.js";
import type { ToolCallDTO } from "../../../agent-contract/dto.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { makeFeedbackConfig, seedTrace } from "./_helpers.js";

let handle: TmpDbHandle | null = null;
afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe("feedback/evidence", () => {
  it("splits traces by value into high / low lists", () => {
    handle = makeTmpDb();
    const h = handle;
    const sessionId = "s1";
    const episodeId = "ep1" as EpisodeId;

    seedTrace(h, {
      episodeId: episodeId as string,
      sessionId,
      userText: "pip install cryptography",
      agentText: "pip install cryptography ok",
      value: 0.8,
    });
    seedTrace(h, {
      episodeId: episodeId as string,
      sessionId,
      userText: "pip install cryptography",
      agentText: "pip install cryptography failed: MODULE_NOT_FOUND",
      value: -0.5,
    });

    const res = gatherRepairEvidence(
      { sessionId: sessionId as SessionId, limit: 4 },
      {
        repos: h.repos,
        config: makeFeedbackConfig(),
        log: rootLogger.child({ channel: "test.evidence" }),
      },
    );
    expect(res.highValue).toHaveLength(1);
    expect(res.lowValue).toHaveLength(1);
    expect(res.highValue[0]!.value).toBeGreaterThan(0);
    expect(res.lowValue[0]!.value).toBeLessThan(0);
  });

  it("treats failure-like agentText as low-value even when value=0", () => {
    handle = makeTmpDb();
    const h = handle;
    const sessionId = "s2";
    const episodeId = "ep2" as EpisodeId;

    seedTrace(h, {
      episodeId: episodeId as string,
      sessionId,
      agentText: "Traceback (most recent call last): ModuleNotFoundError",
      value: 0,
    });

    const res = gatherRepairEvidence(
      { sessionId: sessionId as SessionId },
      {
        repos: h.repos,
        config: makeFeedbackConfig(),
        log: rootLogger.child({ channel: "test.evidence" }),
      },
    );
    expect(res.lowValue).toHaveLength(1);
  });

  it("treats error-coded toolCalls as low-value even with positive value", () => {
    handle = makeTmpDb();
    const h = handle;
    const sessionId = "s3";
    const episodeId = "ep3" as EpisodeId;

    const toolCalls: ToolCallDTO[] = [
      {
        name: "pip.install",
        input: { pkg: "cryptography" },
        errorCode: "MODULE_NOT_FOUND",
        startedAt: 1_700_000_000_000 as ToolCallDTO["startedAt"],
        endedAt: 1_700_000_000_500 as ToolCallDTO["endedAt"],
      },
    ];
    seedTrace(h, {
      episodeId: episodeId as string,
      sessionId,
      agentText: "ran pip",
      value: 0,
      toolCalls,
    });

    const res = gatherRepairEvidence(
      { sessionId: sessionId as SessionId },
      {
        repos: h.repos,
        config: makeFeedbackConfig(),
        log: rootLogger.child({ channel: "test.evidence" }),
      },
    );
    expect(res.lowValue).toHaveLength(1);
  });

  it("keyword filter matches agentText/userText/reflection", () => {
    handle = makeTmpDb();
    const h = handle;
    const sessionId = "s4";
    const episodeId = "ep4" as EpisodeId;

    seedTrace(h, {
      episodeId: episodeId as string,
      sessionId,
      userText: "retry pip install openssl",
      agentText: "apk add openssl-dev and retry",
      value: 0.9,
    });
    seedTrace(h, {
      episodeId: episodeId as string,
      sessionId,
      userText: "totally unrelated thing",
      agentText: "done",
      value: 0.6,
    });

    const res = gatherRepairEvidence(
      { sessionId: sessionId as SessionId, keyword: "openssl" },
      {
        repos: h.repos,
        config: makeFeedbackConfig(),
        log: rootLogger.child({ channel: "test.evidence" }),
      },
    );
    expect(res.highValue).toHaveLength(1);
    expect(res.highValue[0]!.agentText).toContain("openssl");
  });

  it("caps each class at limit (high/low) without starving one side", () => {
    handle = makeTmpDb();
    const h = handle;
    const sessionId = "s5";
    const episodeId = "ep5" as EpisodeId;

    for (let i = 0; i < 6; i += 1) {
      seedTrace(h, {
        episodeId: episodeId as string,
        sessionId,
        agentText: `good run ${i}`,
        value: 0.8,
      });
    }
    for (let i = 0; i < 6; i += 1) {
      seedTrace(h, {
        episodeId: episodeId as string,
        sessionId,
        agentText: `bad run ${i}`,
        value: -0.3,
      });
    }

    const res = gatherRepairEvidence(
      { sessionId: sessionId as SessionId, limit: 2 },
      {
        repos: h.repos,
        config: makeFeedbackConfig(),
        log: rootLogger.child({ channel: "test.evidence" }),
      },
    );
    expect(res.highValue).toHaveLength(2);
    expect(res.lowValue).toHaveLength(2);
  });

  it("returns empty lists when the session is empty", () => {
    handle = makeTmpDb();
    const h = handle;
    const res = gatherRepairEvidence(
      { sessionId: "nosession" as SessionId },
      {
        repos: h.repos,
        config: makeFeedbackConfig(),
        log: rootLogger.child({ channel: "test.evidence" }),
      },
    );
    expect(res.highValue).toHaveLength(0);
    expect(res.lowValue).toHaveLength(0);
  });

  it("capTrace keeps the tail when content is longer than the cap", () => {
    const trace: TraceRow = {
      id: "t1" as TraceRow["id"],
      episodeId: "e1" as TraceRow["episodeId"],
      sessionId: "s1" as TraceRow["sessionId"],
      ts: 0 as TraceRow["ts"],
      userText: "a".repeat(500) + "USER_TAIL",
      agentText: "b".repeat(500) + "AGENT_TAIL",
      toolCalls: [],
      reflection: "c".repeat(500) + "REFLECTION_TAIL",
      value: 0.5,
      alpha: 0.5 as TraceRow["alpha"],
      rHuman: null,
      priority: 0,
      tags: [],
      vecSummary: null,
      vecAction: null,
      schemaVersion: 1,
    };
    const capped = capTrace(trace, 50);
    expect(capped.userText.endsWith("USER_TAIL")).toBe(true);
    expect(capped.agentText.endsWith("AGENT_TAIL")).toBe(true);
    expect(capped.reflection?.endsWith("REFLECTION_TAIL")).toBe(true);
    expect(capped.userText.startsWith("...")).toBe(true);
    expect(capTrace(trace, 0)).toBe(trace); // no-op
  });
});
