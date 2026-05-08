/**
 * OpenClaw Host Model Proxy
 *
 * Reads the host's configured model providers (api.config.models.providers)
 * and proxies completion / embedding requests via OpenAI-compatible HTTP calls.
 */

import type { Logger, OpenClawAPI } from "./types";

// ── Request / Response types ────────────────────────────────────────

export interface OpenClawEmbedRequest {
  texts: string[];
  model?: string;
}

export interface OpenClawEmbedResponse {
  embeddings: number[][];
  dimensions: number;
}

export interface OpenClawCompleteRequest {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface OpenClawCompleteResponse {
  text: string;
}

// ── Host model config (mirrors OpenClaw SDK types loosely) ──────────

export interface HostModelDefinition {
  id: string;
  name: string;
  api?: string;
  [key: string]: unknown;
}

export interface HostModelProvider {
  baseUrl: string;
  apiKey?: string | { source: string; provider: string; id: string };
  api?: string;
  headers?: Record<string, string>;
  models: HostModelDefinition[];
}

export interface HostModelsConfig {
  providers?: Record<string, HostModelProvider>;
}

// ── Resolved provider info (internal) ───────────────────────────────

interface ResolvedProvider {
  name: string;
  baseUrl: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  model: string;
}

// ── Client ──────────────────────────────────────────────────────────

export class OpenClawAPIClient implements OpenClawAPI {
  private completionProvider: ResolvedProvider | undefined;
  private embeddingProvider: ResolvedProvider | undefined;

  constructor(
    private log: Logger,
    hostModels?: HostModelsConfig,
  ) {
    if (hostModels?.providers) {
      this.completionProvider = pickCompletionProvider(hostModels.providers, log);
      this.embeddingProvider = pickEmbeddingProvider(hostModels.providers, log);
    }
  }

  // ── Embedding ─────────────────────────────────────────────────────

  async embed(request: OpenClawEmbedRequest): Promise<OpenClawEmbedResponse> {
    const provider = this.embeddingProvider;
    if (!provider) {
      throw new Error(
        "No host embedding provider available. " +
        "Configure a model provider with an embedding model in OpenClaw, " +
        "or use an explicit embedding provider (openai, gemini, cohere, etc.)."
      );
    }

    const model = request.model ?? provider.model;
    const endpoint = normalizeEndpoint(provider.baseUrl, "/embeddings");

    this.log.debug(`OpenClawAPI.embed → ${provider.name} (${model}) [${request.texts.length} texts]`);

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: buildHeaders(provider),
      body: JSON.stringify({ input: request.texts, model }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Host embedding failed (${provider.name} ${resp.status}): ${body}`);
    }

    const json = (await resp.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    const embeddings = json.data.map((d) => d.embedding);
    const dimensions = embeddings[0]?.length ?? 0;

    this.log.debug(`OpenClawAPI.embed ← ${embeddings.length} vectors, dim=${dimensions}`);
    return { embeddings, dimensions };
  }

  // ── Completion ────────────────────────────────────────────────────

  async complete(request: OpenClawCompleteRequest): Promise<OpenClawCompleteResponse> {
    const provider = this.completionProvider;
    if (!provider) {
      throw new Error(
        "No host completion provider available. " +
        "Configure a model provider in OpenClaw, " +
        "or use an explicit summarizer provider (openai, anthropic, gemini, etc.)."
      );
    }

    const model = request.model ?? provider.model;
    const endpoint = normalizeEndpoint(provider.baseUrl, "/chat/completions");

    this.log.debug(`OpenClawAPI.complete → ${provider.name} (${model})`);

    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: request.prompt }],
      temperature: request.temperature ?? 0,
    };
    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: buildHeaders(provider),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`Host completion failed (${provider.name} ${resp.status}): ${respBody}`);
    }

    const json = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = json.choices?.[0]?.message?.content ?? "";
    this.log.debug(`OpenClawAPI.complete ← ${text.length} chars`);
    return { text };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve a SecretInput (string | SecretRef) to a plain string.
 * For env-sourced SecretRef, reads from process.env.
 * Other sources are not supported — returns undefined.
 */
function resolveApiKey(
  input: string | { source: string; provider: string; id: string } | undefined,
): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return input;
  // SecretRef — only env source is supported in plugin context
  if (input.source === "env") return process.env[input.id];
  return undefined;
}

function buildHeaders(provider: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...provider.headers,
  };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

/**
 * Normalize base URL + path suffix.
 * e.g. "https://api.openai.com/v1" + "/chat/completions"
 *   → "https://api.openai.com/v1/chat/completions"
 */
function normalizeEndpoint(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  // If baseUrl already ends with the suffix, don't double-append
  if (base.endsWith(suffix)) return base;
  return `${base}${suffix}`;
}

/**
 * Pick the best provider for chat completions.
 * Priority: openai-completions API > has apiKey > first with models.
 */
function pickCompletionProvider(
  providers: Record<string, HostModelProvider>,
  log: Logger,
): ResolvedProvider | undefined {
  const entries = Object.entries(providers).filter(([, p]) => p.models?.length > 0);
  if (entries.length === 0) return undefined;

  // Sort: prefer openai-completions api, then providers with apiKey
  entries.sort(([, a], [, b]) => {
    const aScore = (a.api === "openai-completions" ? 2 : 0) + (resolveApiKey(a.apiKey) ? 1 : 0);
    const bScore = (b.api === "openai-completions" ? 2 : 0) + (resolveApiKey(b.apiKey) ? 1 : 0);
    return bScore - aScore;
  });

  const [name, provider] = entries[0];
  const model = provider.models[0].id;
  log.info(`Host completion provider: ${name} → ${model}`);

  return {
    name,
    baseUrl: provider.baseUrl,
    apiKey: resolveApiKey(provider.apiKey),
    api: provider.api,
    headers: provider.headers,
    model,
  };
}

/**
 * Pick the best provider for embeddings.
 * Priority: model name contains "embed" > first provider with apiKey.
 */
function pickEmbeddingProvider(
  providers: Record<string, HostModelProvider>,
  log: Logger,
): ResolvedProvider | undefined {
  const entries = Object.entries(providers).filter(([, p]) => p.models?.length > 0);
  if (entries.length === 0) return undefined;

  // Try to find a provider that has an embedding model
  for (const [name, provider] of entries) {
    const embedModel = provider.models.find((m) =>
      m.id.toLowerCase().includes("embed") || m.name.toLowerCase().includes("embed"),
    );
    if (embedModel) {
      log.info(`Host embedding provider: ${name} → ${embedModel.id}`);
      return {
        name,
        baseUrl: provider.baseUrl,
        apiKey: resolveApiKey(provider.apiKey),
        api: provider.api,
        headers: provider.headers,
        model: embedModel.id,
      };
    }
  }

  // Fallback: use first provider with apiKey, pick first model
  const withKey = entries.find(([, p]) => !!resolveApiKey(p.apiKey));
  if (withKey) {
    const [name, provider] = withKey;
    const model = provider.models[0].id;
    log.info(`Host embedding provider (fallback): ${name} → ${model}`);
    return {
      name,
      baseUrl: provider.baseUrl,
      apiKey: resolveApiKey(provider.apiKey),
      api: provider.api,
      headers: provider.headers,
      model,
    };
  }

  return undefined;
}
