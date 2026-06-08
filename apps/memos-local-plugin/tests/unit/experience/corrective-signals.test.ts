import { describe, expect, it } from "vitest";

import { buildCorrectiveSignalsForSink } from "../../../core/experience/corrective-signals.js";
import type { FeedbackRow, TraceRow } from "../../../core/types.js";

const EP = "ep_cs" as TraceRow["episodeId"];
const TURN1 = 1_700_000_000_000;
const TURN2 = 1_700_000_100_000;

function trace(
  id: string,
  ts: number,
  turnId: number,
  user = "",
): TraceRow {
  return {
    id: id as TraceRow["id"],
    episodeId: EP,
    sessionId: "s" as TraceRow["sessionId"],
    ts: ts as TraceRow["ts"],
    userText: user,
    agentText: "agent reply",
    reflection: null,
    value: 0.5,
    alpha: 0.5 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: [],
    toolCalls: [],
    vecSummary: null,
    vecAction: null,
    turnId: turnId as TraceRow["turnId"],
    schemaVersion: 1,
    ownerAgentKind: "openclaw",
    ownerProfileId: "default",
    ownerWorkspaceId: null,
  };
}

function feedback(
  id: string,
  ts: number,
  traceId: string | null,
  rationale: string,
): FeedbackRow {
  return {
    id: id as FeedbackRow["id"],
    ts: ts as FeedbackRow["ts"],
    episodeId: EP,
    traceId: traceId as FeedbackRow["traceId"],
    channel: "explicit",
    polarity: "negative",
    magnitude: 1,
    rationale,
    raw: null,
    ownerAgentKind: "openclaw",
    ownerProfileId: "default",
    ownerWorkspaceId: null,
  };
}

describe("buildCorrectiveSignalsForSink", () => {
  it("maps traceId to turn_index and timing vs trace window", () => {
    const traces = [
      trace("tr1", TURN1, TURN1, "goal"),
      trace("tr2", TURN1 + 2_000, TURN1),
      trace("tr3", TURN2, TURN2, "follow up"),
    ];
    const fb = feedback(
      "fb1",
      TURN1 + 60_000,
      "tr2",
      "wrong package name",
    );
    const out = buildCorrectiveSignalsForSink(EP, traces, [fb]);
    expect(out.episode_timeline.turns).toHaveLength(2);
    expect(out.corrective_signals).toHaveLength(1);
    const sig = out.corrective_signals[0]!;
    expect(sig.turn_index).toBe(1);
    expect(sig.timing).toBe("between_turns");
    expect(sig.delta_ms_after_turn_end).toBe(58_000);
    expect(sig.text).toContain("wrong package");
    expect(sig.trace_id).toBe("tr2");
  });

  it("labels after_turn when feedback follows the last turn only", () => {
    const traces = [
      trace("tr1", TURN1, TURN1, "solo"),
      trace("tr2", TURN1 + 3_000, TURN1),
    ];
    const fb = feedback("fb3", TURN1 + 6_000, "tr2", "too verbose");
    const out = buildCorrectiveSignalsForSink(EP, traces, [fb]);
    expect(out.corrective_signals[0]?.timing).toBe("after_turn");
    expect(out.corrective_signals[0]?.turn_index).toBe(1);
  });

  it("infers turn from timestamp when traceId is missing", () => {
    const traces = [
      trace("tr1", TURN1, TURN1, "a"),
      trace("tr2", TURN2, TURN2, "b"),
    ];
    const fb = feedback("fb2", TURN2, null, "use poetry style");
    const out = buildCorrectiveSignalsForSink(EP, traces, [fb]);
    const sig = out.corrective_signals[0]!;
    expect(sig.turn_index).toBe(2);
    expect(sig.timing).toBe("at_turn_end");
  });

  it("skips non-substantive feedback rows", () => {
    const traces = [trace("tr1", TURN1, TURN1)];
    const empty = feedback("fb_empty", TURN1, "tr1", "");
    const out = buildCorrectiveSignalsForSink(EP, traces, [empty]);
    expect(out.corrective_signals).toHaveLength(0);
  });
});
