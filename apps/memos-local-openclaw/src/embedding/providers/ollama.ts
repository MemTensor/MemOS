import type { EmbeddingConfig, Logger } from "../../types";

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

export async function embedOllama(
  texts: string[],
  cfg: EmbeddingConfig,
  log: Logger,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const endpoint = cfg.endpoint ?? "http://localhost:11434";
  const model = cfg.model ?? "nomic-embed-text";
  const baseUrl = endpoint.replace(/\/+$/, "");
  const url = baseUrl.endsWith("/api/embed") ? baseUrl : `${baseUrl}/api/embed`;

  log.debug(`Calling Ollama embedding API for ${texts.length} texts`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...cfg.headers,
    },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama embedding failed (${response.status}): ${body}`);
  }

  const payload = await response.json() as OllamaEmbedResponse;
  if (!Array.isArray(payload.embeddings)
    || payload.embeddings.length !== texts.length
    || payload.embeddings.some((vector) => !Array.isArray(vector)
      || vector.some((value) => typeof value !== "number"))) {
    throw new Error("Ollama embedding response has an invalid embeddings shape");
  }

  return payload.embeddings as number[][];
}
