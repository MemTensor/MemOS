/** OpenClaw hook/tool core backed by the shared runtime's local JSON-RPC socket. */
import { RPC_METHODS } from "../../agent-contract/jsonrpc.js";
import type { MemoryCore } from "../../agent-contract/memory-core.js";
import type {
  EpisodeId,
  SessionId,
  SkillId,
  ToolOutcomeDTO,
} from "../../agent-contract/dto.js";
import type { SocketClient } from "../../bridge/socket.js";
import type { OpenClawRuntimeCore } from "./runtime-core.js";

export function createRemoteMemoryCore(client: SocketClient): OpenClawRuntimeCore {
  return {
    health: () => client.request(RPC_METHODS.CORE_HEALTH),
    async openSession(input) {
      const result = await client.request<{ sessionId: SessionId }>(
        RPC_METHODS.SESSION_OPEN,
        input,
      );
      return result.sessionId;
    },
    async closeSession(sessionId) {
      await client.request(RPC_METHODS.SESSION_CLOSE, { sessionId }, { timeoutMs: 10_000 });
    },
    async openEpisode(input) {
      const result = await client.request<{ episodeId: EpisodeId }>(
        RPC_METHODS.EPISODE_OPEN,
        input,
      );
      return result.episodeId;
    },
    async closeEpisode(episodeId) {
      await client.request(RPC_METHODS.EPISODE_CLOSE, { episodeId });
    },
    onTurnStart: (turn) =>
      client.request(RPC_METHODS.TURN_START, turn, { timeoutMs: 180_000 }),
    onTurnEnd: (result) =>
      client.request(RPC_METHODS.TURN_END, result, { timeoutMs: 25_000 }),
    recordToolOutcome(outcome: ToolOutcomeDTO) {
      void client.request(RPC_METHODS.TOOL_OUTCOME_RECORD, outcome).catch(() => {
        // This OpenClaw hook is fire-and-forget. The next awaited call and
        // daemon health expose transport failures.
      });
    },
    searchMemory: (query) =>
      client.request(RPC_METHODS.MEMORY_SEARCH, query, { timeoutMs: 180_000 }),
    getTrace: (id, namespace) =>
      client.request(RPC_METHODS.MEMORY_GET_TRACE, { id, namespace }),
    getPolicy: (id, namespace) =>
      client.request(RPC_METHODS.MEMORY_GET_POLICY, { id, namespace }),
    getWorldModel: (id, namespace) =>
      client.request(RPC_METHODS.MEMORY_GET_WORLD, { id, namespace }),
    async listWorldModels(input) {
      const result = await client.request<{
        worldModels: Awaited<ReturnType<MemoryCore["listWorldModels"]>>;
      }>(RPC_METHODS.MEMORY_LIST_WORLDS, input);
      return result.worldModels;
    },
    async timeline(input) {
      const result = await client.request<{
        traces: Awaited<ReturnType<MemoryCore["timeline"]>>;
      }>(RPC_METHODS.MEMORY_TIMELINE, input);
      return result.traces;
    },
    async listSkills(input) {
      const result = await client.request<{
        skills: Awaited<ReturnType<MemoryCore["listSkills"]>>;
      }>(RPC_METHODS.SKILL_LIST, input);
      return result.skills;
    },
    getSkill(id: SkillId, options) {
      return client.request(RPC_METHODS.SKILL_GET, { id, ...options });
    },
  };
}
