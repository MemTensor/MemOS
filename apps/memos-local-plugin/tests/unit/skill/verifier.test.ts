import { describe, it, expect } from "vitest";

import { rootLogger } from "../../../core/logger/index.js";
import { verifyDraft } from "../../../core/skill/verifier.js";
import type { TraceRow } from "../../../core/types.js";
import { NOW, makeDraft, vec } from "./_helpers.js";

function trace(id: string, userText: string, agentText: string): TraceRow {
  return {
    id: id as TraceRow["id"],
    episodeId: "ep_1" as TraceRow["episodeId"],
    sessionId: "s_1" as TraceRow["sessionId"],
    ts: NOW,
    userText,
    agentText,
    toolCalls: [],
    reflection: null,
    value: 0.5,
    alpha: 0.5 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: [],
    vecSummary: vec([1, 0, 0]),
    vecAction: null,
    schemaVersion: 1,
  };
}

const log = rootLogger.child({ channel: "core.skill.verifier" });

describe("skill/verifier", () => {
  it("accepts drafts that resonate with the evidence", () => {
    const draft = makeDraft({
      summary: "Ensure apk add openssl-dev before pip install cryptography",
      steps: [
        { title: "apk add", body: "apk add openssl-dev libffi-dev" },
        { title: "retry pip", body: "retry pip install cryptography" },
      ],
    });
    const evidence = [
      trace("tr_1", "pip install cryptography failing", "apk add openssl-dev libffi-dev"),
      trace("tr_2", "pip install pycrypto", "retry pip install after apk add"),
    ];
    const r = verifyDraft({ draft, evidence }, { log });
    expect(r.ok).toBe(true);
    expect(r.coverage).toBeGreaterThan(0);
    expect(r.resonance).toBeGreaterThanOrEqual(0.5);
  });

  it("flags drafts whose command tokens don't appear in evidence", () => {
    const draft = makeDraft({
      summary: "Invoke telemetry.upload to finish",
      steps: [
        { title: "call telemetry.upload", body: "run telemetry.upload then verify with checker.exe" },
      ],
    });
    const evidence = [trace("tr_1", "pip failure", "apk add libffi-dev")];
    const r = verifyDraft({ draft, evidence }, { log });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("fails when there is no evidence at all", () => {
    const r = verifyDraft({ draft: makeDraft(), evidence: [] }, { log });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-evidence");
  });
});
