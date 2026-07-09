import type { EmbeddingConfig, Logger } from "../../types";

export async function embedMistral(
  texts: string[],
  cfg: EmbeddingConfig,
  log: Logger,
): Promise<number[][]> {
  const endpoint = cfg.endpoint ?? "https://api.mistral.ai/v1/embeddings";
  const model = cfg.model ?? "mistral-embed";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: texts, model, encoding_format: "float" }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Mistral embedding failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return json.data.map((d) => d.embedding);
}
