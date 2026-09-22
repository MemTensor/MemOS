import type { PolicyMetadata } from "../types.js";
import type { StorageDb } from "./types.js";

const DEFAULT_BATCH_SIZE = 100;

interface LegacyPolicyRow {
  id: string;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  source_episodes_json: string | null;
  source_trace_ids_json: string | null;
}

interface LegacyTraceRow {
  id: string;
  episode_id: string;
  user_text: string;
  agent_text: string;
  reflection: string | null;
  tags_json: string | null;
  tool_calls_json: string | null;
}

/**
 * Fill metadata for legacy policies without holding the migration transaction
 * open. The query is deliberately bounded: a large 2.0.x database is healed
 * over several normal boots instead of making the first upgrade block on a
 * full-table rewrite. Rows are selected by `metadata_json IS NULL`, making the
 * operation idempotent and safe to resume after an interrupted boot.
 */
export function backfillLegacyPolicyMetadata(
  db: StorageDb,
  options: { batchSize?: number } = {},
): number {
  if (!tableExists(db, "policies") || !hasColumn(db, "policies", "metadata_json")) return 0;

  const limit = Math.max(1, Math.min(500, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE)));
  const policies = db
    .prepare<{ limit: number }, LegacyPolicyRow>(
      `SELECT id, title, trigger, procedure, verification, boundary,
              source_episodes_json, source_trace_ids_json
         FROM policies
        WHERE metadata_json IS NULL
        ORDER BY updated_at ASC, id ASC
        LIMIT @limit`,
    )
    .all({ limit });
  if (policies.length === 0) return 0;

  const traceById = new Map<string, LegacyTraceRow>();
  if (tableExists(db, "traces")) {
    const traceIds = new Set<string>();
    const episodeIds = new Set<string>();
    for (const policy of policies) {
      for (const id of parseStringArray(policy.source_trace_ids_json)) traceIds.add(id);
      for (const id of parseStringArray(policy.source_episodes_json)) episodeIds.add(id);
    }
    if (traceIds.size > 0 || episodeIds.size > 0) {
      const idPlaceholders = Array.from(traceIds, (_, i) => `@id${i}`);
      const episodePlaceholders = Array.from(episodeIds, (_, i) => `@episode${i}`);
      const predicates = [];
      if (idPlaceholders.length > 0) predicates.push(`id IN (${idPlaceholders.join(",")})`);
      if (episodePlaceholders.length > 0) predicates.push(`episode_id IN (${episodePlaceholders.join(",")})`);
      const params = {
        ...Object.fromEntries(Array.from(traceIds, (id, i) => [`id${i}`, id])),
        ...Object.fromEntries(Array.from(episodeIds, (id, i) => [`episode${i}`, id])),
      };
      const keyed = db
        .prepare<Record<string, string>, LegacyTraceRow>(
          `SELECT id, episode_id, user_text, agent_text, reflection, tags_json, tool_calls_json
             FROM traces WHERE ${predicates.join(" OR ")}`,
        )
        .all(params);
      for (const row of keyed) traceById.set(row.id, row);
    }
  }

  const update = db.prepare<{ id: string; metadata_json: string }>(
    `UPDATE policies SET metadata_json=@metadata_json WHERE id=@id AND metadata_json IS NULL`,
  );
  return db.tx(() => {
    let updated = 0;
    for (const policy of policies) {
      const traces = parseStringArray(policy.source_trace_ids_json)
        .map((id) => traceById.get(id))
        .filter((trace): trace is LegacyTraceRow => trace !== undefined);
      if (traces.length === 0) {
        const episodes = new Set(parseStringArray(policy.source_episodes_json));
        for (const trace of traceById.values()) {
          if (episodes.has(trace.episode_id)) traces.push(trace);
          if (traces.length >= 8) break;
        }
      }
      const metadata = deriveLegacyMetadata(policy, traces);
      updated += update.run({ id: policy.id, metadata_json: JSON.stringify(metadata) }).changes;
    }
    return updated;
  });
}

function deriveLegacyMetadata(
  policy: LegacyPolicyRow,
  traces: readonly LegacyTraceRow[],
): PolicyMetadata {
  const domainTags = unique(traces.flatMap((trace) => parseStringArray(trace.tags_json)));
  const toolNames = unique(
    traces.flatMap((trace) => parseJsonArray(trace.tool_calls_json)
      .map((call) => typeof call.name === "string" ? call.name : "")
      .filter(Boolean)),
  );
  const errorCodes = unique(
    traces.flatMap((trace) => extractErrorCodes([
      trace.agent_text,
      trace.reflection ?? "",
      ...parseJsonArray(trace.tool_calls_json).map((call) =>
        typeof call.output === "string" ? call.output : "",
      ),
    ].join(" "))),
  );
  const prose = traces.length > 0
    ? traces.flatMap((trace) => [trace.user_text, trace.agent_text, trace.reflection ?? ""])
    : [policy.title, policy.trigger, policy.procedure, policy.verification, policy.boundary];
  const language = detectLanguage(prose);
  return { version: 1, language, domainTags, toolNames, errorCodes };
}

function detectLanguage(values: readonly string[]): PolicyMetadata["language"] {
  let zh = 0;
  let en = 0;
  for (const value of values) {
    for (const char of value) {
      const code = char.charCodeAt(0);
      if (code >= 0x4e00 && code <= 0x9fff) zh++;
      else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) en++;
    }
  }
  if (zh === 0 && en === 0) return "unknown";
  if (zh > 0 && en > 0) return zh / en >= 1.5 ? "zh" : en / zh >= 1.5 ? "en" : "mixed";
  return zh > 0 ? "zh" : "en";
}

function extractErrorCodes(text: string): string[] {
  return Array.from(text.matchAll(/\b[A-Z][A-Z0-9]{2,}_[A-Z0-9_]+\b/g), (match) => match[0]!);
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseJsonArray(raw: string | null): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
      : [];
  } catch {
    return [];
  }
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, 32);
}

function tableExists(db: StorageDb, table: string): boolean {
  return Boolean(db.prepare<{ name: string }, { name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=@name`,
  ).get({ name: table }));
}

function hasColumn(db: StorageDb, table: string, column: string): boolean {
  return db.prepare<unknown, { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}
