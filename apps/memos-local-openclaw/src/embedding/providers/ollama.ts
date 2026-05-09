import type { EmbeddingConfig, Logger } from "../../types";

export async function embedOllama(
  texts: string[],
  cfg: EmbeddingConfig,
  log: Logger,
): Promise<number[][]> {
  const endpoint = cfg.endpoint ?? "http://localhost:11434";
  const model = cfg.model ?? "qwen";
  
  // Ollama embedding API endpoint
  const url = `${endpoint.replace(/\/+$/, "")}/api/embed`;
  
  const results: number[][] = [];
  
  // Ollama 支持批量 embedding，但某些模型可能有限制
  // 这里使用单个处理以确保兼容性
  for (const text of texts) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...cfg.headers,
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Ollama embedding failed (${resp.status}): ${body}`);
    }

    const json = (await resp.json()) as {
      embeddings: number[][] | number[];
    };
    
    // Ollama 返回的 embeddings 可能是二维数组或一维数组
    const embedding = Array.isArray(json.embeddings[0]) 
      ? (json.embeddings as number[][])[0]
      : (json.embeddings as number[]);
    
    results.push(embedding);
  }

  return results;
}
