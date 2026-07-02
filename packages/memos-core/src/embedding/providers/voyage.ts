import type { EmbeddingConfig, Logger } from "../../types";

export async function embedVoyage(
  texts: string[],
  cfg: EmbeddingConfig,
  log: Logger,
): Promise<number[][]> {
  const endpoint = cfg.endpoint ?? "https://api.voyageai.com/v1/embeddings";
  const model = cfg.model ?? "voyage-2";
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
    throw new Error(`Voyage embedding failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return json.data.map((d) => d.embedding);
}
