/**
 * Seed helpers shared by the L2 integration tests.
 *
 * Traces have FK constraints pointing at episodes + sessions, so every
 * scenario that writes traces must first ensure both rows exist.
 */

import type { ToolCallDTO } from "../../../../agent-contract/dto.js";
import type { SessionRow } from "../../../../core/storage/repos/sessions.js";
import type {
  EpisodeId,
  EpisodeRow,
  SessionId,
} from "../../../../core/types.js";
import type { TmpDbHandle } from "../../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000;

/**
 * Shorthand type for a tool-call literal used in tests. `startedAt` and
 * `endedAt` default to `NOW`; tests just need `name` + `input` (+ optional
 * `output` / `errorCode`).
 */
export type PartialToolCall = Partial<ToolCallDTO> & Pick<ToolCallDTO, "name" | "input">;

/**
 * Fill in any missing `startedAt` / `endedAt` fields on a partial tool-call
 * literal used in tests.
 */
export function toolCall(partial: PartialToolCall): ToolCallDTO {
  return {
    startedAt: (partial.startedAt ?? NOW) as ToolCallDTO["startedAt"],
    endedAt: (partial.endedAt ?? NOW) as ToolCallDTO["endedAt"],
    ...partial,
  };
}

/**
 * Normalise an array of partial tool-call literals into full `ToolCallDTO[]`.
 */
export function toolCalls(arr: ReadonlyArray<PartialToolCall>): ToolCallDTO[] {
  return arr.map(toolCall);
}

export function ensureSession(
  handle: TmpDbHandle,
  id: string,
  agent: "openclaw" | "hermes" = "openclaw",
): void {
  const existing = handle.repos.sessions.getById(id as unknown as SessionId);
  if (existing) return;
  const row: SessionRow = {
    id: id as unknown as SessionRow["id"],
    agent: agent as unknown as SessionRow["agent"],
    startedAt: NOW as SessionRow["startedAt"],
    lastSeenAt: NOW as SessionRow["lastSeenAt"],
    meta: {},
  };
  handle.repos.sessions.upsert(row);
}

export function ensureEpisode(
  handle: TmpDbHandle,
  episodeId: string,
  sessionId: string,
): void {
  ensureSession(handle, sessionId);
  const row: EpisodeRow & { meta: Record<string, unknown> } = {
    id: episodeId as unknown as EpisodeId,
    sessionId: sessionId as unknown as SessionId,
    startedAt: NOW as EpisodeRow["startedAt"],
    endedAt: NOW as EpisodeRow["endedAt"],
    status: "closed",
    rTask: null,
    traceIds: [],
    meta: {},
  };
  const existing = handle.repos.episodes.getById(row.id);
  if (existing) return;
  handle.repos.episodes.insert(row);
}
