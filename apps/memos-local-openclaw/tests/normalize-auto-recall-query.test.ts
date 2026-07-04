import { describe, it, expect } from "vitest";
import { normalizeAutoRecallQuery } from "../index";

describe("normalizeAutoRecallQuery — instructional-prompt filtering (issue #1595)", () => {
  it("returns the original short user query unchanged", () => {
    const query = "What did we decide about the migration plan?";
    expect(normalizeAutoRecallQuery(query)).toBe(query);
  });

  it("returns empty string for prompts longer than 300 characters", () => {
    const longInstructional =
      "Please carefully review the following lengthy set of system instructions and follow them precisely without deviation. ".repeat(
        4,
      );
    expect(longInstructional.length).toBeGreaterThan(300);
    expect(normalizeAutoRecallQuery(longInstructional)).toBe("");
  });

  it("returns empty string for system prompts starting with 'You are'", () => {
    const sysPrompt = "You are a helpful assistant tasked with summarizing logs.";
    expect(normalizeAutoRecallQuery(sysPrompt)).toBe("");
  });

  it("'You are' check is case-insensitive", () => {
    const sysPrompt = "you are an expert reviewer.";
    expect(normalizeAutoRecallQuery(sysPrompt)).toBe("");
  });

  it("returns empty string for the Hermes _SKILL_REVIEW_PROMPT (canonical reproducer from #1595)", () => {
    const hermesReview =
      "Review the conversation above, consider saving / updating a skill if appropriate. " +
      "Focus on what was non-trivial — approach used to complete a task that required trial / error, " +
      "changing course due to experiential findings along the way. Did the user expect / desire a " +
      "different method or outcome? If a relevant skill already exists, update it with what you " +
      "learned. Otherwise, create a new skill if the approach is reusable. If nothing is worth " +
      "saving, just say 'Nothing to save' and stop.";
    expect(normalizeAutoRecallQuery(hermesReview)).toBe("");
  });

  it("matches 'Review the conversation above' case-insensitively", () => {
    const review = "review the conversation above and think about what skill to add.";
    expect(normalizeAutoRecallQuery(review)).toBe("");
  });

  it("does not falsely strip a normal-length user message that happens to be > 300 chars after sanitization", () => {
    // Boundary: exactly 300 chars should still pass (the rule is strictly > 300).
    const boundary = "a".repeat(300);
    expect(normalizeAutoRecallQuery(boundary)).toBe(boundary);
  });

  it("still strips known new-session preamble before applying the instructional-prompt filter", () => {
    const newSession =
      "A new session was started via /new or /reset. Execute your Session Startup sequence now.";
    expect(normalizeAutoRecallQuery(newSession)).toBe("");
  });
});
