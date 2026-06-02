/**
 * Stable per-episode turn grouping for capture + trace dedupe.
 *
 * `anchorTurnId` is stamped when an episode opens (first user message ts).
 * All L1 traces in that episode share it so content signatures do not drift
 * when tool rows carry historical timestamps from gateway replay.
 *
 * `captureLiteTurnCount` records how many in-memory turns were processed by
 * the last successful lite capture so we only extract steps from new turns.
 */

import type { EpisodeSnapshot } from "../session/types.js";
import type { EpochMs } from "../types.js";
import type { StepCandidate } from "../capture/types.js";
import type { TraceRow } from "../types.js";

export const ANCHOR_TURN_ID_META = "anchorTurnId";
export const CAPTURE_LITE_TURN_CURSOR_META = "captureLiteTurnCount";

/** Anchor stamped on episode open (`episode-manager.start`). */
export function readAnchorTurnId(episode: EpisodeSnapshot): EpochMs | undefined {
  const raw = episode.meta?.[ANCHOR_TURN_ID_META];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw as EpochMs;
  }
  return undefined;
}

/** Anchor for persist/dedupe; falls back for legacy episodes missing meta. */
export function resolveAnchorTurnId(episode: EpisodeSnapshot): EpochMs {
  return readAnchorTurnId(episode) ?? fallbackAnchorTurnId(episode);
}

function fallbackAnchorTurnId(episode: EpisodeSnapshot): EpochMs {
  const firstUser = episode.turns.find((t) => t.role === "user");
  if (firstUser) return firstUser.ts;
  return episode.startedAt;
}

export function anchorTurnIdFromFirstUserTs(ts: EpochMs): EpochMs {
  return ts;
}

export function liteCaptureTurnCursor(episode: EpisodeSnapshot): number {
  const raw = episode.meta?.[CAPTURE_LITE_TURN_CURSOR_META];
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return 0;
}

/** Resolve the display/grouping turn id for a concrete step/trace row. */
export function pickTurnId(
  meta: Record<string, unknown> | undefined,
  fallbackTs: number,
): number {
  const raw = meta?.turnId;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallbackTs;
}

export function episodeAlreadyHasUserTextTrace(
  existing: readonly Pick<TraceRow, "turnId" | "userText">[],
  anchorTurnId: number,
): boolean {
  return existing.some(
    (r) => r.turnId === anchorTurnId && (r.userText ?? "").trim().length > 0,
  );
}

export function stripRepeatedEpisodeUserText(
  rows: TraceRow[],
  existing: readonly TraceRow[],
  _anchorTurnId: number,
): TraceRow[] {
  const seenUserTexts = new Set(
    existing
      .map((row) => (row.userText ?? "").trim())
      .filter((text) => text.length > 0),
  );
  if (seenUserTexts.size === 0) return rows;
  return rows.map((row) => {
    const userText = (row.userText ?? "").trim();
    if (!userText) return row;
    if (seenUserTexts.has(userText)) return { ...row, userText: "" };
    seenUserTexts.add(userText);
    return row;
  });
}

function stableJson(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, sortJson(val)]),
  );
}

/** Content signature for a not-yet-persisted step (matches persisted trace rows). */
export function stepIdentitySignature(
  step: Pick<StepCandidate, "toolCalls" | "ts" | "userText" | "agentText" | "meta">,
  anchorTurnId?: number,
): string {
  // Signature key can stay episode-stable (anchor) even when persisted
  // row `turnId` is per-segment for viewer ordering/grouping.
  const turnId =
    typeof anchorTurnId === "number" && Number.isFinite(anchorTurnId)
      ? anchorTurnId
      : pickTurnId(step.meta, step.ts);
  const tool = step.toolCalls[0];
  if (tool) {
    const hasRealTiming =
      typeof tool.startedAt === "number" || typeof tool.endedAt === "number";
    return [
      "tool",
      turnId,
      tool.name,
      hasRealTiming ? tool.startedAt ?? "" : step.ts,
      hasRealTiming ? tool.endedAt ?? "" : "",
      stableJson(tool.input),
      stableJson(tool.output),
      tool.errorCode ?? "",
    ].join("\x1f");
  }
  if (step.agentText.trim()) {
    return ["assistant", turnId, step.ts, step.agentText.trim()].join("\x1f");
  }
  return ["user", turnId, step.ts, step.userText.trim()].join("\x1f");
}
