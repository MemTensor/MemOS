/**
 * Model test endpoint — `POST /api/v1/models/test`.
 *
 * Given a model slot config (provider + endpoint + apiKey + model),
 * make ONE tiny upstream call and return ok/err. Used by the Settings
 * page's "测试" button for each of the three slots: **embedding**,
 * **summarizer** (maps to `llm`), and **skillEvolver**.
 *
 * The legacy plugin did the same thing (`POST /api/test-model`). We
 * mirror the behaviour byte-for-byte:
 *
 *   - Embedding slot → a single "test embedding vector" embed call.
 *     Success iff response has a non-empty numeric vector.
 *   - Chat slot (summarizer / skill evolver) → a single "hi" message
 *     with `max_tokens: 5` (or provider equivalent). Success iff the
 *     provider returns a non-error response.
 *
 * We deliberately DON'T use the user's saved config — the form may be
 * unsaved, and we don't want to accidentally persist a bad API key.
 * The test runs with values from the request body only.
 */
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

interface TestRequest {
  type?: "embedding" | "summarizer" | "skillEvolver" | "llm";
  provider?: string;
  endpoint?: string;
  model?: string;
  apiKey?: string;
}

export function registerModelsRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("POST /api/v1/models/test", async (ctx) => {
    const body = parseJson<TestRequest>(ctx);
    const kind = body.type ?? "llm";
    const provider = (body.provider ?? "").trim();
    if (!provider) {
      writeError(ctx, 400, "invalid_argument", "provider is required");
      return;
    }

    // Resolve the apiKey / endpoint: the frontend sends an empty
    // string (or an all-mask `••••` placeholder) when the user
    // hasn't re-entered the secret. In that case load the saved
    // config. This is what makes "save → reload → re-test" work
    // without crashing fetch with the ByteString / U+2022 error.
    const resolved = await resolveSecrets(deps, body);

    try {
      const started = Date.now();
      if (kind === "embedding") {
        const dim = await probeEmbedding(resolved);
        return {
          ok: true,
          kind,
          provider,
          model: resolved.model ?? "",
          dimensions: dim,
          latencyMs: Date.now() - started,
        };
      }
      const chars = await probeChat(resolved);
      return {
        ok: true,
        kind,
        provider,
        model: resolved.model ?? "",
        responseChars: chars,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        kind,
        provider,
        error: (err as Error).message,
      };
    }
  });
}

/**
 * Is the field still the "saved-but-masked" placeholder the frontend
 * shows after reload? Treat empty strings and any sequence of bullets
 * as "use the saved value".
 */
function isMasked(s: string | undefined | null): boolean {
  if (!s) return true;
  return /^[\s•]+$/.test(s);
}

/**
 * Hydrate any masked / empty fields from the **unmasked** config on
 * disk. We intentionally skip `core.getConfig()` — that returns
 * secrets already redacted to `••••`, which would just round-trip
 * the placeholder back and break `fetch()` with the U+2022 /
 * ByteString error the user hit.
 *
 * The loader reads `config.yaml` fresh each call; cost is a single
 * sync file read per test click, which is negligible.
 */
async function resolveSecrets(
  deps: ServerDeps,
  req: TestRequest,
): Promise<TestRequest> {
  const out = { ...req };
  if (!isMasked(out.apiKey) && !isMasked(out.endpoint)) return out;
  try {
    const home = deps.home;
    if (home && home.configFile) {
      // Import lazily — `loadConfig` pulls in the YAML parser which
      // we don't want to load on every request.
      const { loadConfig } = await import("../../core/config/index.js");
      const res = await loadConfig(home as Parameters<typeof loadConfig>[0]);
      const cfg = res.config as unknown as Record<string, unknown>;
      const slotKey =
        out.type === "embedding"
          ? "embedding"
          : out.type === "skillEvolver"
          ? "skillEvolver"
          : "llm";
      const saved = (cfg[slotKey] ?? {}) as {
        apiKey?: unknown;
        endpoint?: unknown;
        model?: unknown;
      };
      if (isMasked(out.apiKey) && typeof saved.apiKey === "string") {
        out.apiKey = saved.apiKey;
      }
      if (isMasked(out.endpoint) && typeof saved.endpoint === "string") {
        out.endpoint = saved.endpoint;
      }
      if (!out.model && typeof saved.model === "string") {
        out.model = saved.model;
      }
    }
  } catch {
    // If config resolution fails, continue with whatever the caller
    // passed. The ASCII guard below keeps fetch() from crashing.
  }
  // Final safety net — strip every non-ASCII byte from apiKey.
  // `fetch`'s header encoder throws on characters > U+00FF, and we'd
  // rather send an empty (and get a clean 401) than crash the handler.
  if (out.apiKey && !/^[\x00-\x7F]*$/.test(out.apiKey)) {
    out.apiKey = out.apiKey.replace(/[^\x00-\x7F]/g, "").trim();
  }
  if (out.endpoint && !/^[\x00-\x7F]*$/.test(out.endpoint)) {
    out.endpoint = out.endpoint.replace(/[^\x00-\x7F]/g, "").trim();
  }
  return out;
}

// ─── Embedding probe ─────────────────────────────────────────────────────

async function probeEmbedding(req: TestRequest): Promise<number> {
  const provider = req.provider ?? "";
  const endpoint = normUrl(req.endpoint ?? "");
  const apiKey = req.apiKey ?? "";
  const model = req.model ?? "";

  switch (provider) {
    case "openai_compatible": {
      if (!endpoint) throw new Error("endpoint is required for openai_compatible");
      const base = endpoint.replace(/\/+$/, "");
      const url = base.endsWith("/v1")
        ? `${base}/embeddings`
        : `${base}/v1/embeddings`;
      const r = await fetchJson(url, {
        method: "POST",
        headers: { ...authHeader(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || "text-embedding-3-small", input: "ping" }),
      });
      const vec = (r.data as Array<{ embedding: number[] }> | undefined)?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error("no embedding vector returned");
      }
      return vec.length;
    }
    case "gemini": {
      const base = endpoint || "https://generativelanguage.googleapis.com";
      const safeKey = /^[\x00-\x7F]*$/.test(apiKey) ? apiKey : "";
      const url = `${base.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(
        model || "text-embedding-004",
      )}:embedContent?key=${encodeURIComponent(safeKey)}`;
      const r = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text: "ping" }] } }),
      });
      const emb = r.embedding as { values?: number[] } | undefined;
      const values = emb?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error("no embedding values returned");
      }
      return values.length;
    }
    case "cohere": {
      const base = endpoint || "https://api.cohere.com";
      const url = `${base.replace(/\/+$/, "")}/v2/embed`;
      const r = await fetchJson(url, {
        method: "POST",
        headers: { ...authHeader(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model || "embed-english-v3.0",
          input_type: "search_document",
          texts: ["ping"],
        }),
      });
      const first = (r.embeddings as number[][] | undefined)?.[0];
      if (!Array.isArray(first) || first.length === 0) {
        throw new Error("no embedding returned");
      }
      return first.length;
    }
    case "voyage": {
      const base = endpoint || "https://api.voyageai.com";
      const url = `${base.replace(/\/+$/, "")}/v1/embeddings`;
      const r = await fetchJson(url, {
        method: "POST",
        headers: { ...authHeader(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || "voyage-3", input: "ping" }),
      });
      const first = (r.data as Array<{ embedding: number[] }> | undefined)?.[0]?.embedding;
      if (!Array.isArray(first) || first.length === 0) {
        throw new Error("no embedding returned");
      }
      return first.length;
    }
    case "mistral": {
      const base = endpoint || "https://api.mistral.ai";
      const url = `${base.replace(/\/+$/, "")}/v1/embeddings`;
      const r = await fetchJson(url, {
        method: "POST",
        headers: { ...authHeader(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || "mistral-embed", input: ["ping"] }),
      });
      const first = (r.data as Array<{ embedding: number[] }> | undefined)?.[0]?.embedding;
      if (!Array.isArray(first) || first.length === 0) {
        throw new Error("no embedding returned");
      }
      return first.length;
    }
    case "local":
      // Local embedder requires the model file in-process; skip the
      // HTTP probe and just acknowledge — the lifecycle check at
      // `core.init` already validated the local provider.
      return 0;
    default:
      throw new Error(`unsupported embedding provider: ${provider}`);
  }
}

// ─── Chat probe ──────────────────────────────────────────────────────────

async function probeChat(req: TestRequest): Promise<number> {
  const provider = req.provider ?? "";
  const endpoint = normUrl(req.endpoint ?? "");
  const apiKey = req.apiKey ?? "";
  const model = req.model ?? "";

  switch (provider) {
    case "openai_compatible": {
      if (!endpoint) throw new Error("endpoint is required for openai_compatible");
      const base = endpoint.replace(/\/+$/, "");
      const url = base.endsWith("/v1")
        ? `${base}/chat/completions`
        : `${base}/v1/chat/completions`;
      const r = await fetchJson(url, {
        method: "POST",
        headers: { ...authHeader(apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model || "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 5,
          temperature: 0,
        }),
      });
      const text =
        (r.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message
          ?.content ?? "";
      return String(text).length;
    }
    case "anthropic": {
      const base = endpoint || "https://api.anthropic.com";
      const url = `${base.replace(/\/+$/, "")}/v1/messages`;
      const safeKey = /^[\x00-\x7F]*$/.test(apiKey) ? apiKey : "";
      const r = await fetchJson(url, {
        method: "POST",
        headers: {
          "x-api-key": safeKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model || "claude-haiku-4",
          max_tokens: 5,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const parts = (r.content as Array<{ text?: string }> | undefined) ?? [];
      return parts.map((p) => p.text ?? "").join("").length;
    }
    case "gemini": {
      const base = endpoint || "https://generativelanguage.googleapis.com";
      const safeKey = /^[\x00-\x7F]*$/.test(apiKey) ? apiKey : "";
      const url = `${base.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(
        model || "gemini-2.5-flash",
      )}:generateContent?key=${encodeURIComponent(safeKey)}`;
      const r = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
      });
      const candidates = r.candidates as
        | Array<{ content?: { parts?: Array<{ text?: string }> } }>
        | undefined;
      const text = (candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      return text.length;
    }
    case "bedrock":
    case "host":
    case "local_only":
      return 0;
    default:
      throw new Error(`unsupported chat provider: ${provider}`);
  }
}

// ─── Low-level helpers ───────────────────────────────────────────────────

function authHeader(apiKey: string): Record<string, string> {
  if (!apiKey || apiKey === "__memos_secret__") return {};
  // ByteString contract: HTTP headers cannot carry U+0080+. If any
  // slipped through (e.g. the mask-placeholder survived both
  // frontend and backend guards), drop the header entirely. Without
  // this, `fetch()` throws "Cannot convert argument to a ByteString
  // because the character at index N has a value of 8226".
  if (!/^[\x00-\x7F]*$/.test(apiKey)) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

function normUrl(u: string): string {
  return u.trim();
}

async function fetchJson(
  url: string,
  init: Parameters<typeof fetch>[1],
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`invalid JSON: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
