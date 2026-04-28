import { describe, it, expect } from "vitest";

import { rootLogger } from "../../../core/logger/index.js";
import { verifyDraft } from "../../../core/skill/verifier.js";
import type { ToolCallDTO } from "../../../agent-contract/dto.js";
import type { TraceRow } from "../../../core/types.js";
import { NOW, makeDraft, vec } from "./_helpers.js";

function trace(
  id: string,
  userText: string,
  agentText: string,
  toolCalls: Partial<ToolCallDTO>[] = [],
): TraceRow {
  return {
    id: id as TraceRow["id"],
    episodeId: "ep_1" as TraceRow["episodeId"],
    sessionId: "s_1" as TraceRow["sessionId"],
    ts: NOW,
    userText,
    agentText,
    toolCalls: toolCalls.map((tc) => ({
      name: tc.name ?? "unknown",
      input: tc.input,
      output: tc.output,
      startedAt: 0 as ToolCallDTO["startedAt"],
      endedAt: 0 as ToolCallDTO["endedAt"],
    })),
    reflection: null,
    value: 0.5,
    alpha: 0.5 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: [],
    vecSummary: vec([1, 0, 0]),
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
  };
}

const log = rootLogger.child({ channel: "core.skill.verifier" });

describe("skill/verifier", () => {
  it("accepts drafts whose tools are a subset of evidence toolCalls", () => {
    const draft = makeDraft({
      summary: "Ensure apk add openssl-dev before pip install cryptography",
      tools: ["shell", "pip.install"],
      steps: [
        { title: "apk add", body: "apk add openssl-dev libffi-dev" },
        { title: "retry pip", body: "retry pip install cryptography" },
      ],
    });
    const evidence = [
      trace("tr_1", "pip install cryptography failing", "apk add openssl-dev libffi-dev", [
        { name: "shell", input: "apk add openssl-dev libffi-dev" },
        { name: "pip.install", input: { pkg: "cryptography" } },
      ]),
      trace("tr_2", "pip install pycrypto", "retry pip install after apk add", [
        { name: "pip.install", input: { pkg: "pycrypto" } },
      ]),
    ];
    const r = verifyDraft({ draft, evidence }, { log });
    expect(r.ok).toBe(true);
    expect(r.coverage).toBe(1);
    expect(r.resonance).toBeGreaterThanOrEqual(0.5);
  });

  it("flags drafts whose tools are not in evidence toolCalls", () => {
    const draft = makeDraft({
      summary: "Invoke telemetry.upload to finish",
      tools: ["telemetry.upload", "checker.exe"],
      steps: [
        { title: "call telemetry.upload", body: "run telemetry.upload then verify with checker.exe" },
      ],
    });
    const evidence = [
      trace("tr_1", "pip failure", "apk add libffi-dev", [
        { name: "shell", input: "apk add libffi-dev" },
      ]),
    ];
    const r = verifyDraft({ draft, evidence }, { log });
    expect(r.ok).toBe(false);
    expect(r.coverage).toBe(0);
    expect(r.unmappedTokens).toEqual(["telemetry.upload", "checker.exe"]);
  });

  it("passes when draft.tools is empty (no tool references)", () => {
    const draft = makeDraft({
      summary: "A purely narrative skill about project conventions",
      tools: [],
      steps: [
        { title: "check naming", body: "verify naming convention" },
      ],
    });
    const evidence = [
      trace("tr_1", "naming question", "naming convention explained", []),
    ];
    const r = verifyDraft({ draft, evidence }, { log });
    expect(r.ok).toBe(true);
    expect(r.coverage).toBe(1);
  });

  it("extracts command-level names from string tc.input", () => {
    const draft = makeDraft({
      summary: "Install system libs",
      tools: ["shell", "apk"],
      steps: [
        { title: "install", body: "apk add openssl-dev" },
      ],
    });
    const evidence = [
      trace("tr_1", "install libs", "apk add openssl-dev", [
        { name: "shell", input: "apk add openssl-dev" },
      ]),
    ];
    const r = verifyDraft({ draft, evidence }, { log });
    expect(r.ok).toBe(true);
    expect(r.coverage).toBe(1);
  });

  it("partial coverage below threshold fails", () => {
    const draft = makeDraft({
      summary: "Use several tools",
      tools: ["shell", "docker.build", "npm.publish", "kubectl"],
      steps: [
        { title: "build", body: "build and deploy" },
      ],
    });
    const evidence = [
      trace("tr_1", "build app", "building docker image", [
        { name: "shell", input: "docker build ." },
      ]),
    ];
    const r = verifyDraft({ draft, evidence }, { log });
    expect(r.ok).toBe(false);
    expect(r.coverage).toBe(0.25);
    expect(r.unmappedTokens).toContain("docker.build");
    expect(r.unmappedTokens).toContain("npm.publish");
    expect(r.unmappedTokens).toContain("kubectl");
  });

  it("does not count plain prose words as coverage tokens", () => {
    const draft = makeDraft({
      summary: "Create modular storage backends with consistent interface",
      steps: [
        {
          title: "Implement storage backend",
          body: "Create a modular implementation that mirrors JSONStore with load and save methods.",
        },
      ],
    });
    const evidence = [
      trace(
        "tr_1",
        "Add a YAML storage backend",
        "Wrote YAMLStore mirroring JSONStore with load and save methods.",
      ),
      trace(
        "tr_2",
        "Verify storage files",
        "Checked task_cli/storage/yaml_store.py and __init__.py exports.",
      ),
    ];
    const r = verifyDraft({ draft, evidence }, { log });
    expect(r.ok).toBe(true);
    expect(r.unmappedTokens).not.toContain("modular");
    expect(r.unmappedTokens).not.toContain("interface");
    expect(r.unmappedTokens).not.toContain("implementation");
  });

  it("fails when there is no evidence at all", () => {
    const r = verifyDraft({ draft: makeDraft(), evidence: [] }, { log });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-evidence");
  });

  it("fails on low resonance even when coverage is fine", () => {
    const draft = makeDraft({
      summary: "completely unrelated topic about quantum computing",
      tools: ["shell"],
      steps: [
        { title: "quantum", body: "run quantum simulation algorithm" },
      ],
    });
    const evidence = [
      trace("tr_1", "pip install cryptography", "apk add openssl-dev", [
        { name: "shell", input: "apk add openssl-dev" },
      ]),
    ];
    const r = verifyDraft({ draft, evidence }, { log });
    expect(r.coverage).toBe(1);
    expect(r.resonance).toBeLessThan(0.5);
    expect(r.ok).toBe(false);
  });
});
