/** Explicit synthetic probe; registered only in an opted-in diagnostic runtime. */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { LlmClient } from "../../core/llm/types.js";
import { rootLogger } from "../../core/logger/index.js";
import { llmFilterCandidates } from "../../core/retrieval/llm-filter.js";
import type { RankedCandidate } from "../../core/retrieval/ranker.js";
import { emitDiagnostic, type DiagnosticSink } from "../../core/util/diagnostics.js";
import { extractDeepSeekHarnessLlmRoute, type DshAgentLike } from "./bridge.js";
import type { DeepSeekHarnessLlmRouteContext } from "./host-llm.js";

interface ProbeDeps {
  llm: LlmClient | null;
  routes: DeepSeekHarnessLlmRouteContext;
  onDiagnostic?: DiagnosticSink;
}

export async function runDiagnosticFilter(
  args: { candidateCount?: unknown; timeoutMs?: unknown },
  deps: ProbeDeps,
  exec: { agent?: unknown; signal: AbortSignal },
): Promise<{ candidateCount: number; timeoutMs: number; durationMs: number; outcome: string; kept: number }> {
  const count = args.candidateCount ?? 5;
  const timeoutMs = args.timeoutMs ?? 15000;
  if (typeof count !== "number" || ![1, 5, 20].includes(count) ||
      typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new MemosError(ERROR_CODES.INVALID_ARGUMENT, "probe requires candidateCount 1/5/20 and timeoutMs 100..60000");
  }
  const agent = exec.agent as DshAgentLike | undefined;
  const route = agent?.session ? extractDeepSeekHarnessLlmRoute(agent) : undefined;
  if (!route) throw new MemosError(ERROR_CODES.LLM_UNAVAILABLE, "diagnostic probe requires an active DSH agent model route");
  exec.signal.throwIfAborted();
  const ranked: RankedCandidate[] = Array.from({ length: count }, (_, i) => ({
    candidate: {
      tier: "tier2", refKind: "trace", refId: `probe-${i + 1}`, cosine: 0.9,
      ts: 1700000000000, vec: null, value: 0.5, priority: 0.5,
      episodeId: "synthetic", sessionId: "synthetic", vecKind: "summary",
      userText: "Which port does the synthetic demo use?", agentText: `The demo uses port ${18000 + i}.`,
      summary: `Synthetic demo ${i + 1} uses port ${18000 + i}.`, reflection: null,
      tags: ["synthetic"], channels: [{ channel: "vec_summary", rank: i, score: 0.9 }],
    }, relevance: 0.9, rrf: 0, score: 0.9, normSq: null,
  } as RankedCandidate));
  const startedAt = Date.now();
  const result = await deps.routes.run(route, () => llmFilterCandidates({
    query: "Which port does synthetic demo 1 use?", ranked,
  }, {
    llm: deps.llm, log: rootLogger.child({ channel: "retrieval" }),
    timeoutMs, deadlineAt: startedAt + timeoutMs, malformedRetries: 0, signal: exec.signal,
    config: { llmFilterEnabled: true, llmFilterMinCandidates: 1, llmFilterMaxKeep: count, llmFilterCandidateBodyChars: 500 },
    onDiagnostic: (event, fields) => emitDiagnostic(deps.onDiagnostic, event, { ...fields, probe: true, sessionId: route.sessionId }),
  }));
  return { candidateCount: count, timeoutMs, durationMs: Date.now() - startedAt, outcome: result.outcome, kept: result.kept.length };
}

export function registerDiagnosticFilterTool(ctx: Context, deps: ProbeDeps): () => void {
  return ctx.tools.register(defineTool({
    name: "memos_diagnostic_filter",
    description: "Synthetic filter latency probe. Run only when the user explicitly requests diagnostics. Does not search or write memory. Each invocation makes one auxiliary model call with a separate diagnostic deadline.",
    parameters: {
      candidateCount: { type: "integer", description: "Synthetic candidates: 1, 5 or 20; default 5." },
      timeoutMs: { type: "integer", description: "Diagnostic-only deadline 100..60000 ms; default 15000. Does not change normal recall/search deadlines." },
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    execute: (args, exec) => runDiagnosticFilter(args, deps, exec),
  }));
}
