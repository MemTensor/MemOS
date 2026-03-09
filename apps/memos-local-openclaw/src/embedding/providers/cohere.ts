import type { EmbeddingConfig, Logger } from "../../types";

export async function embedCohere(
  texts: string[],
  cfg: EmbeddingConfig,
  log: Logger,
): Promise<number[][]> {
  const endpoint = cfg.endpoint ?? "https://api.cohere.ai/v1/embed";
  const model = cfg.model ?? "embed-english-v3.0";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      texts,
      model,
      input_type: "search_document",
      truncate: "END",
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Cohere embedding failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { embeddings: number[][] };
  return json.embeddings;
}

export async function embedCohereQuery(
  text: string,
  cfg: EmbeddingConfig,
  log: Logger,
): Promise<number[]> {
  const endpoint = cfg.endpoint ?? "https://api.cohere.ai/v1/embed";
  const model = cfg.model ?? "embed-english-v3.0";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      texts: [text],
      model,
      input_type: "search_query",
      truncate: "END",
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Cohere query embedding failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { embeddings: number[][] };
  return json.embeddings[0];
}
