# core/embedding

Embedding layer. Turns strings into float vectors that the rest of the core can
feed into cosine similarity (see `core/storage/vector.ts`).

This module is the single place where we talk to embedding providers. Anywhere
else in `core/` that needs vectors must go through the `Embedder` facade —
providers are not exported outside this directory.

## 1. Introduction

> "Give me a vector for this text, in a way that makes cosine similarity
> reflect semantic similarity."

The answer is "depends on the provider":

- **`local`** — `@huggingface/transformers` running `Xenova/all-MiniLM-L6-v2`
  (384-dim, mean-pool + L2-normalized). No network, no API key. First call
  downloads ~23 MB.
- **`openai_compatible`** — OpenAI `/v1/embeddings` (and any drop-in: Azure,
  Zhipu, SiliconFlow, Bailian…). Requires `apiKey`.
- **`gemini`** — Google `generativelanguage.googleapis.com/v1beta/models/<model>:batchEmbedContents`.
  Requires `apiKey`. Distinguishes `RETRIEVAL_DOCUMENT` vs `RETRIEVAL_QUERY`.
- **`cohere`** — `api.cohere.ai/v1/embed`. Distinguishes `search_document` vs
  `search_query` via `input_type`.
- **`voyage`** — `api.voyageai.com/v1/embeddings`. Also has document/query roles.
- **`mistral`** — `api.mistral.ai/v1/embeddings`. OpenAI-compatible shape.

All of them are hidden behind a uniform `Embedder`:

```ts
import { createEmbedder, type EmbeddingConfig } from "./core/embedding";

const embedder = createEmbedder(cfg.embedding);
const vec  = await embedder.embedOne("hello world");
const vecs = await embedder.embedMany([
  { text: "user asked X", role: "document" },
  { text: "user asked X", role: "query"    },
]);
```

Return type: `Float32Array` of length `config.embedding.dimensions`.

## 2. Data flow

```
  inputs ─▶ normalize(input list → role-tagged {text})
            │
            ▼
       sha256(provider|model|role|text) → cache lookup (LRU)
            │             ├── hit  ──────────────────────────┐
            ▼             └── miss → batched by role          │
     batch k texts ──▶ provider.embed()                        │
            │                  │                              │
            ▼                  ▼                              ▼
     dim-enforce + L2-normalize (Float32Array) ──────▶ interleave in input order
            │
            └── cache.set(key, vec)
```

The cache is indexed by `sha256(provider|model|role|text)` in hex. Duplicate
inputs inside a single `embedMany` call collapse into **one** provider round
trip and populate all matching output slots.

### 2.1 Batching

`batchSize` (default 32) controls how many texts we send per HTTP call. Inputs
are grouped by `role` first, then chunked into batches. That way a mixed
list (some `query`, some `document`) still yields two role-correct round trips
instead of one role-ambiguous one.

### 2.2 Normalization

Providers return raw float arrays of *their* dimensionality. We enforce the
**configured** `dimensions`:

- Equal → pass through.
- Larger → truncate. This is the knob that lets you plug a 1536-dim model into
  a 384-dim store without reshaping SQLite.
- Smaller → **throw** with `EMBEDDING_UNAVAILABLE`. Silently zero-padding
  would poison cosine similarity.

Then we `Float32Array`-ize and L2-normalize (unless `config.normalize=false`).
Normalize-once means we can skip it again at query time — cosine becomes a dot
product on the stored blob.

### 2.3 Role semantics

Some providers treat "the thing you're searching against" differently from
"the thing you're searching for." We expose this via `EmbedRole`:

| role       | local | openai | gemini              | cohere          | voyage | mistral |
| ---------- | ----- | ------ | ------------------- | --------------- | ------ | ------- |
| `document` | n/a   | n/a    | `RETRIEVAL_DOCUMENT`| `search_document` | `document` | n/a |
| `query`    | n/a   | n/a    | `RETRIEVAL_QUERY`   | `search_query`  | `query`| n/a |

Callers should pass `role: "query"` when embedding the *user's search text*
and `role: "document"` (or omit) when embedding *stored* content.

## 3. Caching

Default: **in-memory LRU**, `maxItems` = 20 000. That's roughly 20 MB at
384-dim × `Float32Array` — cheap.

Why only in-memory?

1. Re-embedding on restart is free for `local`, pennies for cloud.
2. Disk-persisting text blobs (hashed or not) blurs the "secret text lives in
   SQLite blobs" surface; we prefer to keep that explicit.
3. Repositories in `core/storage/repos/*` already cache the *vectors* once
   they've been stored — retrieval-time cache hits are therefore best served
   by SQLite itself, not by a second cache in the embedding layer.

Turning the cache off (`cache.enabled: false`) swaps in a `NullEmbedCache` —
call-site code does not change.

## 4. Error handling

- **HTTP 5xx / 429 / network errors** are retried with exponential backoff
  (up to `maxRetries`, default 2). Honors caller's `AbortSignal`.
- **All unrecoverable failures** bubble up as
  `MemosError(code=embedding_unavailable)` with `details = { provider, url, … }`.
- The facade **does not auto-fallback** to `local` when a cloud provider
  fails. Higher layers (retrieval / capture) may decide to retry with a local
  embedder, but at this layer we keep errors unambiguous.

## 5. Logging channels

- `embedding` — facade init / stats
- `embedding.cache` — cache writes / clears
- `embedding.local` — HF pipeline load + per-call trace
- `embedding.openai_compatible`, `embedding.gemini`, `embedding.cohere`,
  `embedding.voyage`, `embedding.mistral` — HTTP attempt / duration / status

Every line already carries `{ traceId, sessionId, ... }` from the context
propagator in `core/logger/context.ts`.

## 6. Testing

Unit tests live in `tests/unit/embedding/`:

- `normalize.test.ts` — dim enforce, L2, Float32 conversion.
- `cache.test.ts`     — LRU eviction, hit/miss counters, null cache parity.
- `fetcher.test.ts`   — retry on 5xx/429, timeout, error mapping.
- `providers.test.ts` — fake `fetch` mounted per test; one round-trip per
  provider covering auth, role translation, response parsing, error surface.
- `local.test.ts`     — lazy-load single-instance invariant using a mocked
  provider (no real model download in unit tests).
- `embedder.test.ts`  — end-to-end facade: cache hit path, mixed roles, batch
  size, duplicate dedup, stats counters, dim enforcement.

## 7. Caveats

- `local`'s first call triggers a model download to the huggingface cache dir.
  Tests that actually exercise `local` must be opt-in (env-gated) and live
  outside unit-test budget.
- `gemini`'s `?key=<API_KEY>` puts the secret in the URL; `fetcher.ts`
  redacts query string via the logger's redaction pipeline. Do not log the
  raw URL elsewhere.
- `voyage` and `cohere` charge per token; be mindful when bumping
  `batchSize` — large batches amortize HTTP overhead but hit TPM ceilings.
- Changing `dimensions` in config after writing vectors to SQLite breaks
  cosine comparisons against old rows. Prefer bumping the model instead and
  re-embedding on next turn via `resetCache() + recomputeOnDemand` in higher
  layers (not yet implemented — Phase 9).
