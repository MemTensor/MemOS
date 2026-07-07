import type { EmbeddingConfig, Logger } from "../../types";

export async function embedGemini(
  texts: string[],
  cfg: EmbeddingConfig,
  log: Logger,
): Promise<number[][]> {
  // Issue #1241: default aligned with what the Viewer Test-Connection uses.
  // gemini-embedding-001 is the current officially-supported Gemini embedding
  // model; text-embedding-004 is deprecated for new deployments and now
  // returns 404 against the v1beta batchEmbedContents endpoint for many users.
  const model = cfg.model ?? "gemini-embedding-001";
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
