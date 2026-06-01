import { describe, it, expect, afterEach } from "vitest";

import {
  computeRebuildLevel,
  policyContentHash,
} from "../../../core/skill/rebuild-level.js";
import { seedPolicy, seedSkill } from "./_helpers.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import type { TraceRow } from "../../../core/types.js";

let handle: TmpDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe("skill/rebuild-level", () => {
  it("forces L0 when policy unchanged and no incremental evidence", () => {
    const h = makeTmpDb();
    handle = h;
    const policy = seedPolicy(h, {
      trigger: "t",
      procedure: "p",
      boundary: "b",
      verification: "v",
    });
    const hash = policyContentHash(policy);
    const skill = seedSkill(h, {
      procedureJson: {
        summary: "s",
        policyContentHash: hash,
        parameters: [],
        preconditions: [],
        steps: [],
        examples: [],
        decisionGuidance: { preference: [], antiPattern: [] },
        tags: [],
        tools: [],
      },
    });
    const r = computeRebuildLevel({
      policy,
      existingSkill: skill,
      incrementalEvidence: [],
    });
    expect(r.level).toBe("L0");
  });

  it("uses L2 when policy hash drifts", () => {
    const h = makeTmpDb();
    handle = h;
    const skill = seedSkill(h, {
      procedureJson: {
        summary: "s",
        policyContentHash: "old_hash_value",
        parameters: [],
        preconditions: [],
        steps: [],
        examples: [],
        decisionGuidance: { preference: [], antiPattern: [] },
        tags: [],
        tools: [],
      },
    });
    const policy = seedPolicy(h, {
      trigger: "new trigger text",
      procedure: "p",
      boundary: "b",
      verification: "v",
    });
    const r = computeRebuildLevel({
      policy,
      existingSkill: skill,
      incrementalEvidence: [{ id: "tr_x" } as TraceRow],
    });
    expect(r.level).toBe("L2");
  });
});
