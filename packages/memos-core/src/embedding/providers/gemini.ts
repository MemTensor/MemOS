import type { EmbeddingConfig, Logger } from "../../types";

export async function embedGemini(
  texts: string[],
  cfg: EmbeddingConfig,
  log: Logger,
): Promise<number[][]> {
  const model = cfg.model ?? "text-embedding-004";
  const endpoint =
    cfg.endpoint ??
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;

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
