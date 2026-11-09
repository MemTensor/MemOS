/**
 * Regression tests for the LLM completion sanitizer (issue #2336).
 *
 * The bug: the openai_compatible provider was returning
 * `choice.message.content` verbatim, so thinking-enabled DeepSeek-family
 * models on gateways that keep the `<think>` block inside `content`
 * (rather than moving it to `reasoning_content`) leaked that block —
 * plus DeepSeek gateway tokens like `<｜end▁of▁sentence｜>` — into
 * persisted feedback rationales and other memory artifacts.
 *
 * The fix is a single provider-side transform; these tests pin the
 * exact shape of that transform.
 */

import { describe, expect, it } from "vitest";

import { sanitizeCompletionText } from "../../../core/llm/sanitize.js";

describe("llm/sanitize", () => {
  describe("passthrough", () => {
    it("returns empty input untouched", () => {
      expect(sanitizeCompletionText("")).toBe("");
    });

    it("returns clean text untouched apart from trim", () => {
      expect(sanitizeCompletionText("hello world")).toBe("hello world");
      expect(sanitizeCompletionText("  hello world  ")).toBe("hello world");
    });

    it("does not touch JSON payloads that contain no think tags", () => {
      const json = '{"polarity":"negative","rationale":"user says wrong"}';
      expect(sanitizeCompletionText(json)).toBe(json);
    });
  });

  describe("matched <think> blocks", () => {
    it("removes a leading <think>...</think> block", () => {
      const raw = "<think>let me reason</think>\nfinal answer";
      expect(sanitizeCompletionText(raw)).toBe("final answer");
    });

    it("removes a multi-line <think> block including newlines", () => {
      const raw = [
        "<think>",
        "step 1: read the request",
        "step 2: decide feedback polarity",
        "</think>",
        "",
        '{"polarity":"negative"}',
      ].join("\n");
      expect(sanitizeCompletionText(raw)).toBe('{"polarity":"negative"}');
    });

    it("removes multiple <think> blocks independently (non-greedy)", () => {
      const raw = "<think>a</think>keep1<think>b</think>keep2";
      expect(sanitizeCompletionText(raw)).toBe("keep1keep2");
    });

    it("handles upper-case tag names", () => {
      const raw = "<THINK>reason</THINK>\nkeep";
      expect(sanitizeCompletionText(raw)).toBe("keep");
    });

    it("handles whitespace inside tag delimiters", () => {
      const raw = "< think >r</ think >final";
      expect(sanitizeCompletionText(raw)).toBe("final");
    });
  });

  describe("orphan closing </think>", () => {
    it("strips the orphan closing tag exactly as reported in #2336", () => {
      // This is the leading fragment the reporter observed in a stored
      // feedback rationale row. It is a gateway artifact — the opening
      // `<think>` got truncated before reaching us; only the closer +
      // DeepSeek session tokens survive.
      const raw =
        "</think>\n<｜end▁of▁sentence｜>\n<｜end▁of▁session｜>\n\n---\n\n[Writing Rule] first sentence.";
      expect(sanitizeCompletionText(raw)).toBe(
        "---\n\n[Writing Rule] first sentence.",
      );
    });

    it("strips an orphan closer without opener but keeps the actual answer", () => {
      const raw = "</think>\nthe answer is 42";
      expect(sanitizeCompletionText(raw)).toBe("the answer is 42");
    });
  });

  describe("orphan opening <think>", () => {
    it("drops the opener and everything after it (truncated reasoning)", () => {
      // Reverse failure: gateway kept `<think>` open but cut the response
      // before the closer. Anything after the opener is trailing
      // reasoning text — unactionable and not the final answer.
      const raw = "final answer here\n<think>still thinking about";
      expect(sanitizeCompletionText(raw)).toBe("final answer here");
    });
  });

  describe("DeepSeek special tokens", () => {
    it("strips <｜begin▁of▁sentence｜> using Chinese full-width bars", () => {
      const raw = "<｜begin▁of▁sentence｜>hello";
      expect(sanitizeCompletionText(raw)).toBe("hello");
    });

    it("strips <｜end▁of▁sentence｜> and <｜end▁of▁session｜>", () => {
      const raw = "the answer<｜end▁of▁sentence｜><｜end▁of▁session｜>";
      expect(sanitizeCompletionText(raw)).toBe("the answer");
    });

    it("does NOT strip an ASCII-pipe lookalike (safety guard)", () => {
      // If a user's own message legitimately contained "<|end|>" (ASCII
      // pipes) it should survive — only the full-width DeepSeek token
      // is a gateway artifact.
      const raw = "user wrote <|end|> in their prompt";
      expect(sanitizeCompletionText(raw)).toBe(
        "user wrote <|end|> in their prompt",
      );
    });
  });

  describe("interactions", () => {
    it("collapses ≥3 blank lines the strip introduced back down to a paragraph break", () => {
      const raw = "before\n\n\n\n<think>x</think>\n\n\n\nafter";
      expect(sanitizeCompletionText(raw)).toBe("before\n\n\n\nafter".replace(/\n{3,}/g, "\n\n"));
    });

    it("handles the full reported artifact soup end-to-end", () => {
      const raw = [
        "<think>",
        "user is unhappy — flag negative",
        "</think>",
        "<｜end▁of▁sentence｜>",
        '{"polarity":"negative","rationale":"user says wrong"}',
      ].join("\n");
      expect(sanitizeCompletionText(raw)).toBe(
        '{"polarity":"negative","rationale":"user says wrong"}',
      );
    });

    it("is idempotent", () => {
      const raw =
        "<think>r</think>keep<｜end▁of▁sentence｜></think>tail";
      const once = sanitizeCompletionText(raw);
      const twice = sanitizeCompletionText(once);
      expect(twice).toBe(once);
    });
  });
});
