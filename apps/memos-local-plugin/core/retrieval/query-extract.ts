import type { LlmClient } from "../llm/index.js";
import { RETRIEVAL_QUERY_EXTRACT_PROMPT } from "../llm/prompts/index.js";
import type { Logger } from "../logger/types.js";
import type { EpisodeId } from "../types.js";
import type { RetrievalQueryExtract } from "./query-builder.js";

const MAX_INPUT_CHARS = 4_000;
const MAX_KEYWORDS = 5;

export interface RetrievalQueryExtractDeps {
  llm: LlmClient | null;
  log: Logger;
  episodeId?: EpisodeId;
  timeoutMs?: number;
}

export async function extractRetrievalQueryWithLlm(
  rawQuery: string,
  deps: RetrievalQueryExtractDeps,
): Promise<RetrievalQueryExtract | null> {
  const raw = String(rawQuery ?? "").trim();
  if (!raw || !deps.llm) return null;

  try {
    const rsp = await deps.llm.completeJson<{
      queryVecText?: unknown;
      keywords?: unknown;
    }>(
      [
        { role: "system", content: RETRIEVAL_QUERY_EXTRACT_PROMPT.system },
        {
          role: "user",
          content: `COMPLETE USER INPUT:\n${raw.slice(0, MAX_INPUT_CHARS)}`,
        },
      ],
      {
        op: `retrieval.${RETRIEVAL_QUERY_EXTRACT_PROMPT.id}.v${RETRIEVAL_QUERY_EXTRACT_PROMPT.version}`,
        phase: "retrieve",
        episodeId: deps.episodeId,
        temperature: 0,
        timeoutMs: deps.timeoutMs,
        maxTokens: 320,
        malformedRetries: 1,
      },
    );
    const queryVecText = String(rsp.value?.queryVecText ?? "").trim();
    const keywords = normalizeKeywords(rsp.value?.keywords);
    if (!queryVecText && keywords.length === 0) {
      deps.log.debug("query_extract.empty_fallback");
      return null;
    }
    return { queryVecText, keywords };
  } catch (err) {
    deps.log.warn("query_extract.failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function normalizeKeywords(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const keyword = String(item ?? "").trim();
    if (!keyword) continue;
    const normalized = keyword.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(keyword);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}
