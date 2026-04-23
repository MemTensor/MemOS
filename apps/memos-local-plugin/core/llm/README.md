# core/llm

LLM layer. Turns natural-language prompts into either (a) text, (b) a parsed
JSON value, or (c) a stream of chunks. Every LLM-dependent algorithm step
(reflection, reward scoring, induction, decision-repair, skill
crystallization) goes through this module.

Anywhere else in `core/` that needs an LLM must go through the `LlmClient`
facade — providers are not exported outside this directory.

## 1. Introduction

Five real providers + two sentinels, all behind one interface:

| provider            | native JSON mode | native stream | notes                         |
| ------------------- | ---------------- | ------------- | ----------------------------- |
| `openai_compatible` | ✅ (`json_object`) | ✅ (SSE)      | Works with OpenAI, Azure, Zhipu, SiliconFlow, Bailian, etc. |
| `anthropic`         | ❌ (hint-based)   | ✅ (SSE)      | Messages API.                 |
| `gemini`            | ✅ (`responseMimeType`) | ✅ (SSE) | Google generateContent.        |
| `bedrock`           | ❌ (hint-based)   | ❌            | Converse API. SigV4 is the caller's problem. |
| `host`              | ❌ (hint-based)   | ❌ (faked)    | Delegates to the host agent (OpenClaw) via `HostLlmBridge`. |
| `local_only`        | ─                | ─             | Always throws `LLM_UNAVAILABLE`. Use to explicitly disable LLM. |

Usage:

```ts
import { createLlmClient, REFLECTION_SCORE_PROMPT } from "./core/llm";

const llm = createLlmClient(cfg.llm);

// Plain text.
const res = await llm.complete("Summarize: " + text, { op: "summary.v1" });

// JSON — automatic schema hint + fence-stripping parser.
const r = await llm.completeJson<{ alpha: number; usable: boolean }>(
  [
    { role: "system", content: REFLECTION_SCORE_PROMPT.system },
    { role: "user", content: JSON.stringify(traceForReflection) },
  ],
  {
    op: "reflection.score",
    schemaHint: `{ "alpha": number 0..1, "usable": boolean, "reason": string }`,
    validate: (v) => {
      const o = v as Record<string, unknown>;
      if (typeof o.alpha !== "number") throw new Error("alpha must be number");
    },
  },
);

// Streaming.
for await (const ch of llm.stream("Tell me a story")) {
  if (!ch.done) process.stdout.write(ch.delta);
}
```

## 2. Data flow

```
  input (string | LlmMessage[])
        │
        ▼
  normalize → inject JSON system hint (if jsonMode / completeJson)
        │
        ▼
  provider.complete()  ── OK ──▶ record(log.llm, stats) ──▶ return
        │   │
        │   └─ LLM_UNAVAILABLE / LLM_RATE_LIMITED / LLM_TIMEOUT
        │
        ▼ fallbackToHost && HostLlmBridge registered?
  host.complete()  ── OK ──▶ record(servedBy="host_fallback") ──▶ return
        │
        ▼ still failed
  throw MemosError
```

`completeJson<T>()` wraps `complete` with a parse+validate step. If parsing
fails, the client performs **one** JSON-malformed retry (configurable via
`malformedRetries`) before throwing `LLM_OUTPUT_MALFORMED`.

### 2.1 JSON mode

Two paths:

1. **Native JSON mode** (openai_compatible, gemini). We set
   `response_format: { type: "json_object" }` or `responseMimeType` and
   still prepend a short system hint describing the expected shape. This
   keeps providers that ignore the hint accountable, and lets us log the
   schema we asked for.
2. **Hint-based JSON mode** (anthropic, bedrock, host). We prepend:

   > Respond with a single valid JSON value and nothing else. Do not wrap
   > in Markdown code fences. Do not include explanations.
   >
   > Expected shape:
   > `{...caller-provided...}`

   and then run the parser (`parseLlmJson`) which strips fences, walks to
   the first balanced `{…}` / `[…]`, and tolerates trailing commas.

### 2.2 Host fallback

`HostLlmBridge` is registered by the adapter at startup. When the primary
provider throws a transient LLM error *and* `config.fallbackToHost === true`,
we call the host once as a best-effort fallback. The resulting completion's
`servedBy` is `"host_fallback"` so downstream dashboards can distinguish
host wins from primary wins.

Registering from an adapter:

```ts
import { registerHostLlmBridge } from "@memos/core";

registerHostLlmBridge({
  id: "openclaw.host.v1",
  async complete({ messages, temperature, maxTokens, timeoutMs, signal }) {
    // ... call OpenClaw's sharing-host completion API ...
  },
});
```

### 2.3 Retries

Two layers of retries, with different intents:

- `fetcher.httpPostJson` retries on **transport-level** transient failure
  (5xx / 429 / network / timeout) up to `config.maxRetries`.
- `client.completeJson` retries on **parse-level** malformed JSON up to
  `opts.malformedRetries` (default 1).

Both use exponential backoff with jitter. Neither retries logical-level
errors (`LLM_OUTPUT_MALFORMED` from a `validate()`, 4xx except 429, etc).

## 3. Prompts

Every V7 algorithm prompt lives under `core/llm/prompts/` as a
`PromptDef` with `id` + `version` + `system`. Call sites embed the
`{ id, version }` into their audit/event records, so when we bump a prompt
we can still replay traces authored under the old version.

Current prompts:

- `reflection.score` — score agent self-reflections (α_t)
- `reward.r_human` — infer signed reward from final human exchange
- `l2.induction` — distill L2 policy from L1 trace cluster
- `decision.repair` — preference + anti-pattern for failure loops
- `skill.crystallize` — promote L2 policy to callable Skill

## 4. Errors

| Code                       | When                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `llm_unavailable`          | Missing apiKey, transport error, host bridge not registered, `local_only`. |
| `llm_rate_limited`         | HTTP 429 after retries.                                        |
| `llm_timeout`              | AbortSignal-timeout after retries.                             |
| `llm_output_malformed`     | JSON parser failed after `malformedRetries`.                   |
| `invalid_argument`         | Empty message list, etc.                                       |

## 5. Logging channels

- `llm`                       — facade init + stream init + fallback decisions
- `llm.json`                  — malformed-JSON retry warnings
- `llm.prompts`               — prompt registry lookups (Phase 12 onward)
- `llm.openai_compatible`, `llm.anthropic`, `llm.gemini`, `llm.bedrock`,
  `llm.host`, `llm.local_only` — per-provider HTTP attempts + duration
  + status

Every successful call also produces an `llm(...)` payload:

```json
{
  "provider": "openai_compatible",
  "model": "gpt-4o-mini",
  "op": "reflection.score",
  "ms": 412,
  "promptTokens": 523,
  "completionTokens": 88,
  "status": "ok"
}
```

Prompt / completion contents are redacted according to
`config.logging.redactPrompts` / `redactCompletions`.

## 6. Testing

Unit tests live in `tests/unit/llm/`:

- `json-mode.test.ts` — fence-stripping, balanced-block extraction,
  trailing-comma repair, `buildJsonSystemHint`.
- `fetcher.test.ts` — retries on 5xx / 429 / timeout / network, SSE
  decoder golden-paths, error-code mapping.
- `providers.test.ts` — one HTTP round-trip per provider covering request
  shape, response parsing, JSON mode flag, stream decoding.
- `client.test.ts` — facade: stats, json mode, malformed-retry,
  host-fallback, streaming wrapper, `local_only` throws, logger integration.
- `prompts.test.ts` — every prompt has `{ id, version, system }` and
  non-empty text.

## 7. Caveats

- **Bedrock & SigV4.** We don't sign requests here. Deployments behind a
  signing proxy work out of the box; direct-to-AWS deployments need a
  pre-signed endpoint or a proxy.
- **Streaming for `host` is fake.** We emit one delta + one `done` chunk.
  Call sites that care about real streaming should route to a primary
  provider (openai/anthropic/gemini) instead of `host`.
- **Tokens may be undefined.** Not every provider returns usage metadata.
  Stats then under-report; this is expected and callers must not depend
  on tokens being present.
- **Changing a prompt's `id` is breaking.** Bump `version` instead.
