import type { EmbeddingConfig, Logger } from "../../types";

function normalizeGeminiEmbeddingEndpoint(endpoint: string, model: string): string {
  let out = endpoint.trim();
  if (!out) {
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;
  }
  out = out.replace('/v1/models/', '/v1beta/models/');
  out = out.replace(/:embedContent\b/, ':batchEmbedContents');
  return out;
}

export async function embedGemini(
  texts: string[],
  cfg: EmbeddingConfig,
  log: Logger,
): Promise<number[][]> {
  const model = cfg.model ?? "gemini-embedding-001";
  const endpoint = normalizeGeminiEmbeddingEndpoint(
    cfg.endpoint ?? `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
    model,
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...cfg.headers,
  };

  const url = `${endpoint}?key=${cfg.apiKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      })),
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gemini embedding failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as {
    embeddings: Array<{ values: number[] }>;
  };
  return json.embeddings.map((e) => e.values);
}
