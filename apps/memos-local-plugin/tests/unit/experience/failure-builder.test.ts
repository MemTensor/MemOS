import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runL2Failure } from "../../../core/experience/failure-builder.js";
import { rootLogger } from "../../../core/logger/index.js";
import type { EpisodeId, SessionId } from "../../../core/types.js";
import { fakeLlm } from "../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { NOW, seedTrace } from "../feedback/_helpers.js";

const FAILURE_SINK_OP = "l2.failure.experience.sink.v5";

function sinkPayload(
  partial: Partial<{
    title: string;
    trigger: string;
    procedure: string;
    verification: string;
    boundary: string;
    experience_type: "repair_instruction" | "failure_avoidance";
    decision_guidance: { prefer?: string[]; avoid?: string[] };
    support_trace_ids: string[];
  }> = {},
): Record<string, unknown> {
  return {
    title: "Check requested deliverable before closing",
    trigger: "A task is about to be marked done while the requested deliverable may still be missing",
    procedure:
      "Compare the final answer against the user request, identify any missing acceptance item, then complete the smallest missing deliverable before closing.",
    verification: "The final response includes the requested deliverable or explicitly names the remaining blocker.",
    boundary: "Applies to task-completion failures caused by closing before checking the requested output.",
    experience_type: "repair_instruction",
    decision_guidance: {
      prefer: ["Before closing, compare the visible result with the user's requested deliverable."],
      avoid: ["Do not mark the task complete while a requested deliverable is still absent."],
    },
    support_trace_ids: ["tr_failure_a"],
    ...partial,
  };
}

describe("failure experience builder", () => {
  let handle: TmpDbHandle;

  beforeEach(() => {
    handle = makeTmpDb({ agent: "hermes" });
  });

  afterEach(() => {
    handle.cleanup();
  });

  it("merges a repeated failure sink policy instead of creating a duplicate", async () => {
    const firstTrace = seedTrace(handle, {
      id: "tr_failure_a",
      episodeId: "ep_failure_a",
      sessionId: "se_failure_a",
      userText: "Produce the requested report and include the final artifact.",
      agentText: "Stopped after analysis without the final report.",
    });
    const secondTrace = seedTrace(handle, {
      id: "tr_failure_b",
      episodeId: "ep_failure_b",
      sessionId: "se_failure_b",
      userText: "Produce the requested report and include the final artifact.",
      agentText: "Stopped after analysis without the final report.",
    });

    const llm = fakeLlm({
      completeJson: {
        [FAILURE_SINK_OP]: (input) => {
          const text = JSON.stringify(input);
          return text.includes("ep_failure_b")
            ? sinkPayload({
                support_trace_ids: ["tr_failure_b"],
                decision_guidance: {
                  avoid: ["Do not close before checking that the requested deliverable exists."],
                },
              })
            : sinkPayload();
        },
      },
    });

    const first = await runL2Failure(
      {
        episodeId: "ep_failure_a" as EpisodeId,
        sessionId: "se_failure_a" as SessionId,
        traces: [firstTrace],
      },
      { repos: handle.repos, llm, log: rootLogger, now: () => NOW },
    );
    const second = await runL2Failure(
      {
        episodeId: "ep_failure_b" as EpisodeId,
        sessionId: "se_failure_b" as SessionId,
        traces: [secondTrace],
      },
      { repos: handle.repos, llm, log: rootLogger, now: () => NOW + 1 },
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.merged).toBe(true);
    expect(second.policyId).toBe(first.policyId);

    const policies = handle.repos.policies.list({ limit: 20 });
    expect(policies).toHaveLength(1);
    expect(policies[0]?.sourceEpisodeIds).toEqual(["ep_failure_a", "ep_failure_b"]);
    expect(policies[0]?.sourceTraceIds).toEqual(["tr_failure_a", "tr_failure_b"]);
    expect(policies[0]?.support).toBe(2);
  });

  it("does not merge failure sink policies that use default key templates", async () => {
    const firstTrace = seedTrace(handle, {
      id: "tr_default_a",
      episodeId: "ep_default_a",
      sessionId: "se_default_a",
      userText: "Finish the requested migration.",
      agentText: "Stopped without applying the migration.",
    });
    const secondTrace = seedTrace(handle, {
      id: "tr_default_b",
      episodeId: "ep_default_b",
      sessionId: "se_default_b",
      userText: "Fix the failing build.",
      agentText: "Stopped without fixing the build.",
    });

    const llm = fakeLlm({
      completeJson: {
        [FAILURE_SINK_OP]: (input) => {
          const text = JSON.stringify(input);
          return text.includes("ep_default_b")
            ? sinkPayload({
                title: "Failure sink policy",
                trigger: "失败场景触发",
                procedure: "分析失败原因并执行最小修复步骤",
                decision_guidance: { avoid: ["Do not stop before fixing the build."] },
                support_trace_ids: ["tr_default_b"],
              })
            : sinkPayload({
                title: "Failure sink policy",
                trigger: "失败场景触发",
                procedure: "分析失败原因并执行最小修复步骤",
                decision_guidance: { avoid: ["Do not stop before applying the migration."] },
                support_trace_ids: ["tr_default_a"],
              });
        },
      },
    });

    const first = await runL2Failure(
      {
        episodeId: "ep_default_a" as EpisodeId,
        sessionId: "se_default_a" as SessionId,
        traces: [firstTrace],
      },
      { repos: handle.repos, llm, log: rootLogger, now: () => NOW },
    );
    const second = await runL2Failure(
      {
        episodeId: "ep_default_b" as EpisodeId,
        sessionId: "se_default_b" as SessionId,
        traces: [secondTrace],
      },
      { repos: handle.repos, llm, log: rootLogger, now: () => NOW + 1 },
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(handle.repos.policies.list({ limit: 20 })).toHaveLength(2);
  });
});
