/**
 * Strips gateway artifacts from LLM completion text before it is returned
 * from a provider — see issue #2336.
 *
 * Thinking-enabled DeepSeek-family models served through gateways that keep
 * the model's `<think>...</think>` reasoning block inside
 * `choice.message.content` (rather than surfacing it via a separate
 * `reasoning_content` field) leak that block into `ProviderCompletion.text`.
 * Ops that persist this text — most notably `feedback.classify`, which
 * writes into `FeedbackRow.rationale` — then pollute retrieval-visible
 * memory with strings like `"</think>\n<｜end▁of▁sentence｜>\n..."`, and
 * that pollution flows back into the model's own context on future turns.
 *
 * This module centralizes the sanitizer so every provider strips the same
 * set of artifacts. Fixing it here is O(1) call sites for O(N) ops.
 */

/**
 * Matched `<think>...</think>` block. Non-greedy so multiple blocks are
 * stripped independently; multi-line so newlines inside the block are
 * consumed. Case-insensitive because some gateways upcase tag names.
 */
const THINK_BLOCK_RE = /<\s*think\b[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi;

/**
 * Orphan closing `</think>` fragment. The reporter's evidence in #2336
 * starts with one — a gateway that truncates thinking-block output can
 * drop the opener while leaving the closer intact.
 */
const ORPHAN_CLOSE_THINK_RE = /<\s*\/\s*think\s*>/gi;

/**
 * Orphan opening `<think>` fragment plus everything after it. Symmetric
 * defense against the reverse failure mode: gateway keeps the opener but
 * cuts before the closer, leaving reasoning trailing off the response.
 * We drop everything from the opener onward because the model has already
 * committed to reasoning-mode output — retaining it would still be
 * unactionable thinking text.
 */
const ORPHAN_OPEN_THINK_RE = /<\s*think\b[^>]*>[\s\S]*$/i;

/**
 * DeepSeek-family special tokens. Uses the Chinese full-width `｜`
 * (U+FF5C) that the model actually emits — NOT the ASCII `|`. Some
 * gateways strip these before sending, others don't; strip them here
 * unconditionally so the invariant is provider-agnostic.
 */
const DEEPSEEK_SPECIAL_TOKENS_RE =
  /<｜(?:begin|end)▁(?:of▁sentence|of▁session)｜>/g;

/**
 * Collapse runs of ≥3 blank lines that the strip may have introduced.
 * Two consecutive newlines (a paragraph break) are still allowed.
 */
const EXCESS_BLANK_LINES_RE = /\n{3,}/g;

/**
 * Remove `<think>` blocks and DeepSeek gateway tokens from LLM completion
 * text. Idempotent and safe on empty input.
 *
 * Order matters: strip matched blocks first, THEN orphan fragments — the
 * orphan patterns are broad and would eat surrounding content if a
 * well-formed block hadn't been removed first.
 */
export function sanitizeCompletionText(text: string): string {
  if (!text) return text;
  let out = text.replace(THINK_BLOCK_RE, "");
  out = out.replace(ORPHAN_OPEN_THINK_RE, "");
  out = out.replace(ORPHAN_CLOSE_THINK_RE, "");
  out = out.replace(DEEPSEEK_SPECIAL_TOKENS_RE, "");
  out = out.replace(EXCESS_BLANK_LINES_RE, "\n\n");
  return out.trim();
}
