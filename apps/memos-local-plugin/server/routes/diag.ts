/**
 * Diagnostic endpoints — used by the E2E probe script and the
 * Settings "run self-check" button.
 *
 *   GET  /api/v1/diag/counts
 *     Returns current row counts across every V7 layer, so the user
 *     can tell at a glance whether the capture / reward / induction
 *     / crystallisation / abstraction pipelines have produced any
 *     output yet. Handy after a scripted OpenClaw conversation when
 *     you want to check "did the plugin even see my chat?" without
 *     opening the DB.
 *
 *   POST /api/v1/diag/simulate-turn
 *     Accepts `{ sessionId, user, assistant, toolCalls?, feedback? }`
 *     and pipes it through the core just like an `agent_end` event
 *     would — open session, open episode, record a turn, close
 *     episode. Used ONLY by the E2E probe script; gated behind
 *     `?allow=1` so it can't accidentally fire from the viewer.
 */
import type {
  AgentKind,
  EpisodeId,
  SessionId,
  TurnInputDTO,
  TurnResultDTO,
} from "../../agent-contract/dto.js";
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

export function registerDiagRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/diag/counts", async () => {
    const core = deps.core;
    const [traces, episodes, policies, worldModels, skills, logs] =
      await Promise.all([
        core.listTraces({ limit: 1, offset: 0 }),
        core.listEpisodeRows({ limit: 1, offset: 0 }),
        core.listPolicies({ limit: 1, offset: 0 }),
        core.listWorldModels({ limit: 1, offset: 0 }),
        core.listSkills({ limit: 1 }),
        core.listApiLogs({ limit: 1, offset: 0 }),
      ]);
    // We use `listXxx` just to get *a* row — the actual per-layer
    // counts come from the `metrics()` call + per-layer API totals.
    const m = await core.metrics({ days: 365 });
    return {
      traces: m.total,
      traces_today: m.writesToday,
      episodes: episodes.length > 0 ? await countEpisodes(core) : 0,
      policies: policies.length > 0 ? await countPolicies(core) : 0,
      worldModels: worldModels.length > 0 ? await countWorldModels(core) : 0,
      skills: skills.length > 0 ? await countSkills(core) : 0,
      apiLogs: logs.total,
      sessionsHave: m.sessions,
      embeddings: m.embeddings,
    };
  });

  routes.set("POST /api/v1/diag/simulate-turn", async (ctx) => {
    // Safety lock: accept only when explicitly opted-in with
    // `?allow=1`. Without this header the endpoint returns 403 — we
    // don't want random web traffic driving synthetic turns into the
    // user's memory store.
    if (ctx.url.searchParams.get("allow") !== "1") {
      writeError(ctx, 403, "forbidden", "use ?allow=1 to enable this endpoint");
      return;
    }
    const body = parseJson<{
      agent?: AgentKind;
      sessionId?: SessionId;
      user: string;
      assistant: string;
      toolCalls?: Array<{ name: string; input?: unknown; output?: unknown; errorCode?: string }>;
    }>(ctx);
    if (!body.user || !body.assistant) {
      writeError(ctx, 400, "invalid_argument", "user and assistant are required");
      return;
    }
    const agent: AgentKind = (body.agent as AgentKind) ?? "openclaw";
    const sessionId =
      body.sessionId ??
      ((await deps.core.openSession({ agent })) as SessionId);

    const ts = Date.now();
    const turnIn: TurnInputDTO = {
      agent,
      sessionId,
      userText: body.user,
      ts,
    };
    const packet = await deps.core.onTurnStart(turnIn);
    const episodeId = (packet.query.episodeId ?? null) as EpisodeId | null;
    if (!episodeId) {
      writeError(ctx, 500, "internal", "onTurnStart did not return an episodeId");
      return;
    }
    const now = Date.now();
    const turnOut: TurnResultDTO = {
      agent,
      sessionId,
      episodeId,
      agentText: body.assistant,
      toolCalls: (body.toolCalls ?? []).map((tc, i) => ({
        id: `sim_${now}_${i}`,
        name: tc.name,
        input: tc.input ?? {},
        output: tc.output ?? "",
        startedAt: now as never,
        endedAt: (now + 1) as never,
        errorCode: tc.errorCode,
      })),
      ts: now,
    };
    const res = await deps.core.onTurnEnd(turnOut);
    return {
      ok: true,
      sessionId,
      episodeId,
      traceId: res.traceId,
      hits: packet.hits.length,
    };
  });
}

// Poor-man's counters — we walk batches of 500 until the list turns
// up short. Safe for viewer-scale datasets; don't run on millions of
// rows (use SQL directly in that case).

async function countEpisodes(core: ServerDeps["core"]): Promise<number> {
  return walkAll((limit, offset) =>
    core.listEpisodeRows({ limit, offset }),
  );
}
async function countPolicies(core: ServerDeps["core"]): Promise<number> {
  return walkAll((limit, offset) => core.listPolicies({ limit, offset }));
}
async function countWorldModels(core: ServerDeps["core"]): Promise<number> {
  return walkAll((limit, offset) =>
    core.listWorldModels({ limit, offset }),
  );
}
async function countSkills(core: ServerDeps["core"]): Promise<number> {
  return walkAll((limit, offset) => core.listSkills({ limit }));
  void countSkills; // the offset is unused for listSkills; it returns
  // everything up to `limit` — fine for our cap.
}

async function walkAll<T>(
  fetcher: (limit: number, offset: number) => Promise<T[]>,
): Promise<number> {
  const BATCH = 500;
  let offset = 0;
  let total = 0;
  for (let safety = 0; safety < 40; safety++) {
    const rows = await fetcher(BATCH, offset);
    total += rows.length;
    if (rows.length < BATCH) break;
    offset += BATCH;
  }
  return total;
}
