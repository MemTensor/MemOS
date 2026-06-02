import { beforeAll, describe, expect, it } from "vitest";

import { synthesizeReflection } from "../../../core/capture/reflection-synth.js";
import type { NormalizedStep } from "../../../core/capture/types.js";
import { initTestLogger } from "../../../core/logger/index.js";
import { fakeLlm, throwingLlm } from "../../helpers/fake-llm.js";

function step(partial: Partial<NormalizedStep>): NormalizedStep {
  return {
    key: "k",
    ts: 1_000,
    userText: partial.userText ?? "",
    agentText: partial.agentText ?? "",
    toolCalls: partial.toolCalls ?? [],
    rawReflection: null,
    depth: 0,
    isSubagent: false,
    meta: {},
    truncated: false,
  };
}

describe("capture/reflection-synth", () => {
  beforeAll(() => initTestLogger());

  it("returns the LLM text when the model answers", async () => {
    const llm = fakeLlm({
      complete: {
        "capture.reflection.synth":
          "I tried the shell first because the prompt looked shell-shaped, then verified with a read.",
      },
    });
    const out = await synthesizeReflection(
      llm,
      step({ userText: "ls", agentText: "running ls", toolCalls: [] }),
    );
    expect(out.text).toContain("shell first");
    expect(out.model).toBe("openai_compatible");
  });

  it("injects task context and last tool outcome into the prompt", async () => {
    let userPrompt = "";
    const llm = fakeLlm({
      complete: {
        "capture.reflection.synth": (input) => {
          const messages = input as Array<{ role: string; content: string }>;
          userPrompt = messages.find((m) => m.role === "user")?.content ?? "";
          return "I checked the working directory because the task needed the project path.";
        },
      },
    });

    await synthesizeReflection(
      llm,
      step({
        userText: "where am I?",
        agentText: "checking pwd",
        toolCalls: [{ name: "shell", input: { command: "pwd" }, output: "/tmp/project" }],
      }),
      { episodeId: "ep_1", phase: "reflect", taskSummary: "Task: inspect current project" },
    );

    expect(userPrompt).toContain("TASK CONTEXT:");
    expect(userPrompt).toContain("Task: inspect current project");
    expect(userPrompt).toContain("OUTCOME:");
    expect(userPrompt).toContain("/tmp/project");
  });

  it("injects downstream preview with explicit step offsets and types", async () => {
    let userPrompt = "";
    const llm = fakeLlm({
      complete: {
        "capture.reflection.synth": (input) => {
          const messages = input as Array<{ role: string; content: string }>;
          userPrompt = messages.find((m) => m.role === "user")?.content ?? "";
          return "I used the first check because the downstream output confirmed the path.";
        },
      },
    });

    await synthesizeReflection(
      llm,
      step({ userText: "inspect", agentText: "checking", toolCalls: [] }),
      {
        downstream: [
          { offset: 1, kind: "text", text: "state: user asked for tests\naction: searched test files" },
          {
            offset: 2,
            kind: "tooluse",
            toolNames: ["shell"],
            toolOutput: "tests passed",
            reflection: "I ran tests to validate the change.",
          },
        ],
      },
    );

    expect(userPrompt).toContain("DOWNSTREAM STEP PREVIEW:");
    expect(userPrompt).toContain("[step+1] type=text");
    expect(userPrompt).toContain("[step+2] type=tooluse");
    expect(userPrompt).toContain("tool_names: shell");
    expect(userPrompt).toContain("tool_output: tests passed");
    expect(userPrompt).toContain("existing_reflection: I ran tests");
  });

  it("returns null on the NO_REFLECTION sentinel", async () => {
    const llm = fakeLlm({
      complete: { "capture.reflection.synth": "NO_REFLECTION" },
    });
    const out = await synthesizeReflection(llm, step({ userText: "q", agentText: "a" }));
    expect(out.text).toBeNull();
  });

  it("returns null on empty response", async () => {
    const llm = fakeLlm({ complete: { "capture.reflection.synth": "   " } });
    const out = await synthesizeReflection(llm, step({ agentText: "a" }));
    expect(out.text).toBeNull();
  });

  it("falls back to text=null on LLM error", async () => {
    const llm = throwingLlm(new Error("boom"));
    const out = await synthesizeReflection(llm, step({ agentText: "a" }));
    expect(out.text).toBeNull();
    expect(out.model).toBe("none");
  });

  it("caps text at 1500 chars", async () => {
    const big = "Z".repeat(5_000);
    const llm = fakeLlm({ complete: { "capture.reflection.synth": big } });
    const out = await synthesizeReflection(llm, step({ agentText: "a" }));
    expect(out.text?.length).toBeLessThanOrEqual(1_500);
  });
});
