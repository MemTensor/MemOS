import type { EmbeddingConfig, Logger } from "../../types";

export async function embedOpenAI(
  texts: string[],
  cfg: EmbeddingConfig,
  log: Logger,
): Promise<number[][]> {
  const endpoint = normalizeEmbeddingEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/embeddings");
  const model = cfg.model ?? "text-embedding-3-small";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: texts, model }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI embedding failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return json.data.map((d) => d.embedding);
}

/**
 * Normalize endpoint: if user provides a base_url (e.g. https://host/v1)
 * without the /embeddings suffix, append it automatically.
 */
function normalizeEmbeddingEndpoint(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (stripped.endsWith("/embeddings")) return stripped;
  return `${stripped}/embeddings`;
}
