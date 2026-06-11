import { describe, expect, it } from "vitest";

import {
  extractQuestionSection,
  focusIrRetrievalQuery,
  isIrEvalPrompt,
} from "../../../core/retrieval/task-focus.js";

const IR_TEMPLATE_PREFIX =
  "new task\n\nYou are a deep research agent. Answer the question by using the search tool to find relevant documents from a local knowledge base.\n\n## CRITICAL RULES\n- You MUST ONLY use the \"search\" tool.\n\n## Response Format\nExplanation / Exact Answer / Confidence\n\n";

describe("retrieval/task-focus", () => {
  it("extractQuestionSection returns body after ## Question", () => {
    const raw = `${IR_TEMPLATE_PREFIX}## Question\n\n- Actor A was born in the 1950s\n- What is actor A's debut TV series called?`;
    expect(extractQuestionSection(raw)).toBe(
      "- Actor A was born in the 1950s\n- What is actor A's debut TV series called?",
    );
  });

  it("extractQuestionSection returns null when heading is missing", () => {
    expect(extractQuestionSection("Fix docker compose")).toBeNull();
  });

  it("isIrEvalPrompt matches IR eval templates only", () => {
    const ir = `${IR_TEMPLATE_PREFIX}## Question\n\nGive me the school name.`;
    expect(isIrEvalPrompt(ir)).toBe(true);
    expect(isIrEvalPrompt("Fix this docker compose file")).toBe(false);
    expect(
      isIrEvalPrompt("You are a deep research agent.\n\n## Bug Description\n\nBroken."),
    ).toBe(false);
  });

  it("focusIrRetrievalQuery keeps question body for IR templates", () => {
    const question =
      "Give me the name of the school that the below actress was expelled from: - She is 163 cm tall.";
    const raw = `${IR_TEMPLATE_PREFIX}## Question\n\n${question}`;
    const focused = focusIrRetrievalQuery(raw);
    expect(focused.method).toBe("question_section");
    expect(focused.text).toBe(question);
  });

  it("focusIrRetrievalQuery passthrough for non-IR prompts", () => {
    const raw = "Investigate memos_search policy recall for po_7x7aq1k9q4ba";
    const focused = focusIrRetrievalQuery(raw);
    expect(focused.method).toBe("passthrough");
    expect(focused.text).toBe(raw);
  });
});
