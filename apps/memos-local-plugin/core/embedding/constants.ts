/**
 * Shared embedding constants. Kept dependency-free so `core/config/`
 * (schema + defaults) can import from here without dragging in the
 * provider implementations behind `embedder.ts`.
 */

/**
 * Default per-input character cap for embedding inputs.
 *
 * Chosen at 4000 chars with 智谱 embedding-3's 3072-token single-input
 * hard limit as the reference worst case: GLM tokenizers average
 * ~1.3–1.5 chars per token for Chinese, so 4000 CJK chars ≈ 2700–3000
 * tokens — under the cap for typical content (the previous 6000
 * default mapped to ≈ 4000–4600 tokens and could still trip HTTP 400
 * `code:1210` on CJK-dominant inputs). ASCII tokenizes at ~4
 * chars/token, so 4000 chars ≈ 1000 tokens, safe for every supported
 * provider. The cap is a guard, not a hard guarantee — pathological
 * inputs that still overflow are isolated per-slot by the
 * divide-and-conquer retry in `pipeline/memory-core.ts`.
 *
 * Callers can override via `EmbeddingConfig.maxInputChars`; `0`, a
 * negative value, or `Infinity` disables truncation (see
 * `resolveMaxInputChars` in `embedder.ts`). See issue #2121.
 *
 * This constant is the single source of truth — `config/schema.ts` and
 * `config/defaults.ts` import it so the schema default, the runtime
 * default, and the facade fallback can never drift apart.
 */
export const DEFAULT_MAX_INPUT_CHARS = 4000;
