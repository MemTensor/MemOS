/**
 * Decorates a `CoreEvent` with everything the overview activity
 * dashboard needs to render it: category, icon, human title, and
 * one-line detail string. The mapping is exhaustive over the closed
 * set of `CoreEventType` literals (see `agent-contract/events.ts`).
 *
 * Intentionally split from the React component so:
 *   - The ~30-row mapping is unit-testable in isolation.
 *   - A new event type added in the bridge can extend `EVENT_META`
 *     in one place without touching presentation.
 *   - Other surfaces (logs view, dev tools, …) can reuse the same
 *     human-readable labels later without copy-paste.
 *
 * Vocabulary follows the product's existing i18n labels — L2 is
 * "经验" (NOT 策略), L3 is "环境认知" (NOT 世界观).
 */
import type { IconName } from "../../components/Icon";
import type { CoreEvent, CoreEventType } from "../../api/types";
import { t } from "../../stores/i18n";

// ─── Public types ────────────────────────────────────────────────────────

/** High-level activity grouping the dashboard tiles are sliced by. */
export type EventCategory =
  | "session"
  | "memory"
  | "experience"
  | "world"
  | "skill"
  | "retrieval"
  | "feedback"
  | "system"
  | "hub";

/** The six categories surfaced as tiles, in row-major (3 × 2) order. */
export const TILE_CATEGORIES: readonly EventCategory[] = [
  "memory",
  "experience",
  "world",
  "skill",
  "retrieval",
  "feedback",
] as const;

/** Static metadata for a category (icon / i18n label key). */
export interface CategoryMeta {
  icon: IconName;
  /** i18n key under `overview.live.cat.*`. */
  labelKey: string;
}

export const CATEGORY_META: Record<EventCategory, CategoryMeta> = {
  session:    { icon: "message-square-text", labelKey: "overview.live.cat.session" },
  memory:     { icon: "brain-circuit",       labelKey: "overview.live.cat.memory" },
  experience: { icon: "workflow",            labelKey: "overview.live.cat.experience" },
  world:      { icon: "globe",               labelKey: "overview.live.cat.world" },
  skill:      { icon: "sparkles",            labelKey: "overview.live.cat.skill" },
  retrieval:  { icon: "search",              labelKey: "overview.live.cat.retrieval" },
  feedback:   { icon: "check-circle-2",      labelKey: "overview.live.cat.feedback" },
  system:     { icon: "settings-2",          labelKey: "overview.live.cat.system" },
  hub:        { icon: "share",               labelKey: "overview.live.cat.hub" },
};

/** Decorated event ready for the activity tile / pill UI. */
export interface DecoratedEvent {
  /** Category bucket the event belongs to. */
  cat: EventCategory;
  /** Icon name (Lucide) — defaults to category icon, may override per type. */
  icon: IconName;
  /** Human title — fully localised. */
  title: string;
  /** One-line detail string — fully localised, may be empty. */
  detail: string;
  /** Original event preserved for tooltip / debug payload reveal. */
  evt: CoreEvent;
}

// ─── Mapping tables ──────────────────────────────────────────────────────

const TYPE_TO_CAT: Record<CoreEventType, EventCategory> = {
  "session.opened": "session",
  "session.closed": "session",
  "episode.opened": "session",
  "episode.closed": "session",

  "trace.created": "memory",
  "trace.value_updated": "memory",
  "trace.priority_decayed": "memory",

  "l2.candidate_added": "experience",
  "l2.candidate_expired": "experience",
  "l2.associated": "experience",
  "l2.induced": "experience",
  "l2.revised": "experience",
  "l2.boundary_shrunk": "experience",

  "l3.abstracted": "world",
  "l3.revised": "world",

  "feedback.received": "feedback",
  "feedback.classified": "feedback",
  "reward.computed": "feedback",

  "skill.crystallized": "skill",
  "skill.eta_updated": "skill",
  "skill.boundary_updated": "skill",
  "skill.archived": "skill",
  "skill.repaired": "skill",

  "decision_repair.generated": "feedback",
  "decision_repair.validated": "feedback",

  "retrieval.triggered": "retrieval",
  "retrieval.tier1.hit": "retrieval",
  "retrieval.tier2.hit": "retrieval",
  "retrieval.tier3.hit": "retrieval",
  "retrieval.empty": "retrieval",

  "hub.client_connected": "hub",
  "hub.client_disconnected": "hub",
  "hub.share_published": "hub",
  "hub.share_received": "hub",

  "system.started": "system",
  "system.shutdown": "system",
  "system.error": "system",
  "system.config_changed": "system",
  "system.update_available": "system",
};

/**
 * Per-type icon overrides. When a type is absent we fall back to the
 * category icon. Keep overrides reserved for events that carry a
 * meaning visibly different from their bucket — e.g. a decay event
 * shouldn't look identical to a fresh write.
 */
const TYPE_ICON_OVERRIDE: Partial<Record<CoreEventType, IconName>> = {
  "trace.value_updated": "refresh-cw",
  "trace.priority_decayed": "clock",
  "l2.revised": "refresh-cw",
  "l2.associated": "layers",
  "l2.boundary_shrunk": "filter",
  "l3.revised": "refresh-cw",
  "skill.archived": "archive",
  "skill.eta_updated": "gauge",
  "skill.boundary_updated": "filter",
  "skill.repaired": "wand-sparkles",
  "decision_repair.generated": "wand-sparkles",
  "decision_repair.validated": "check-circle-2",
  "system.started": "zap",
  "system.error": "circle-alert",
  "system.config_changed": "settings-2",
  "system.update_available": "bell",
  "hub.client_connected": "plug",
  "hub.client_disconnected": "cable",
  "hub.share_published": "share",
  "hub.share_received": "share-2",
};

// ─── Detail formatters ───────────────────────────────────────────────────

/** Picks the most descriptive id we can find on a payload. */
function payloadId(p: unknown, ...keys: string[]): string {
  if (!p || typeof p !== "object") return "—";
  for (const k of keys) {
    const v = (p as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "—";
}

function payloadNumber(p: unknown, key: string): number | undefined {
  if (!p || typeof p !== "object") return undefined;
  const v = (p as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

function payloadString(p: unknown, key: string): string | undefined {
  if (!p || typeof p !== "object") return undefined;
  const v = (p as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/** Localised category label — used as the noun prefix in detail strings. */
function catLabel(cat: EventCategory): string {
  return t(CATEGORY_META[cat].labelKey as never);
}

/**
 * Builds the localised detail line for a single event. Returning `""`
 * is fine; the dashboard tile collapses an empty detail to just the
 * timestamp.
 */
function describeDetail(evt: CoreEvent): string {
  const p = evt.payload;
  switch (evt.type) {
    case "session.opened":
      return t("overview.live.detail.id", {
        label: catLabel("session"),
        id: payloadId(p, "id", "sessionId"),
      });
    case "session.closed":
      return t("overview.live.detail.idReason", {
        label: catLabel("session"),
        id: payloadId(p, "sessionId", "id"),
        reason: payloadString(p, "reason") ?? "—",
      });
    case "episode.opened":
      return t("overview.live.detail.id", {
        label: t("overview.live.cat.task"),
        id: payloadId(p, "id", "episodeId"),
      });
    case "episode.closed": {
      const id = payloadId(
        (p as { episode?: unknown })?.episode ?? p,
        "id",
        "episodeId",
      );
      return t("overview.live.detail.idReason", {
        label: t("overview.live.cat.task"),
        id,
        reason: payloadString(p, "closedBy") ?? "system",
      });
    }

    case "trace.created":
    case "trace.value_updated":
    case "trace.priority_decayed":
      return t("overview.live.detail.id", {
        label: catLabel("memory"),
        id: payloadId(p, "traceId", "id"),
      });

    case "l2.candidate_added":
    case "l2.candidate_expired":
      return t("overview.live.detail.candidate", {
        sig: payloadString(p, "signature") ?? payloadId(p, "candidateId"),
      });
    case "l2.induced": {
      const evidence =
        (p as { evidenceTraceIds?: unknown[] })?.evidenceTraceIds?.length ??
        payloadNumber(p, "evidenceCount") ??
        0;
      return t("overview.live.detail.induced", {
        sig: payloadString(p, "signature") ?? "—",
        n: evidence,
      });
    }
    case "l2.associated": {
      const sim = payloadNumber(p, "similarity") ?? 0;
      return t("overview.live.detail.similarity", {
        label: catLabel("experience"),
        id: payloadId(p, "policyId"),
        pct: Math.round(sim * 100),
      });
    }
    case "l2.revised":
    case "l2.boundary_shrunk":
      return t("overview.live.detail.id", {
        label: catLabel("experience"),
        id: payloadId(p, "policyId", "id"),
      });

    case "l3.abstracted":
    case "l3.revised":
      return t("overview.live.detail.id", {
        label: catLabel("world"),
        id: payloadId(p, "worldModelId", "id"),
      });

    case "skill.crystallized":
    case "skill.eta_updated":
    case "skill.boundary_updated":
    case "skill.archived":
    case "skill.repaired":
      return t("overview.live.detail.id", {
        label: catLabel("skill"),
        id: payloadId(p, "skillId", "id"),
      });

    case "retrieval.triggered":
    case "retrieval.empty":
      return t("overview.live.detail.id", {
        label: catLabel("session"),
        id: payloadId(p, "sessionId"),
      });
    case "retrieval.tier1.hit":
    case "retrieval.tier2.hit":
    case "retrieval.tier3.hit": {
      // Bridge sends `{ stats: { hits, latencyMs } }` for retrieval.done;
      // we tolerate both flat and nested shapes plus the demo's `count/ms`.
      const stats =
        ((p as { stats?: Record<string, unknown> })?.stats as
          | Record<string, unknown>
          | undefined) ?? (p as Record<string, unknown>);
      const count =
        (typeof stats?.hits === "number" && stats.hits) ||
        payloadNumber(stats, "count") ||
        0;
      const ms =
        (typeof stats?.latencyMs === "number" && stats.latencyMs) ||
        payloadNumber(stats, "ms") ||
        0;
      return t("overview.live.detail.retrievalHit", { count, ms });
    }

    case "feedback.received":
    case "feedback.classified":
      return t("overview.live.detail.feedbackTone", {
        tone: payloadString(p, "tone") ?? "neutral",
      });
    case "reward.computed": {
      const r = payloadNumber(p, "rHuman") ?? payloadNumber(p, "r") ?? 0;
      return t("overview.live.detail.reward", {
        r: r.toFixed(2),
        source: payloadString(p, "source") ?? "—",
      });
    }
    case "decision_repair.generated":
    case "decision_repair.validated":
      return t("overview.live.detail.id", {
        label: catLabel("feedback"),
        id: payloadId(p, "repairId", "contextHash", "id"),
      });

    case "hub.client_connected":
    case "hub.client_disconnected":
      return t("overview.live.detail.id", {
        label: catLabel("hub"),
        id: payloadId(p, "clientId", "id"),
      });
    case "hub.share_published":
    case "hub.share_received":
      return t("overview.live.detail.raw", {
        value: payloadString(p, "signature") ?? payloadId(p, "shareId", "id"),
      });

    case "system.started":
      return t("overview.live.detail.version", {
        version: payloadString(p, "version") ?? "—",
      });
    case "system.shutdown":
      return t("overview.live.detail.raw", {
        value: payloadString(p, "reason") ?? "—",
      });
    case "system.config_changed":
      return t("overview.live.detail.raw", {
        value: payloadString(p, "key") ?? "—",
      });
    case "system.error":
      return t("overview.live.detail.raw", {
        value: payloadString(p, "message") ?? "—",
      });
    case "system.update_available":
      return t("overview.live.detail.version", {
        version: payloadString(p, "version") ?? "—",
      });
  }
}

// ─── Public entry point ──────────────────────────────────────────────────

/**
 * Convert a raw event into the shape the dashboard needs. Pure
 * function: no DOM, no async, safe to call inside render.
 */
export function decorateEvent(evt: CoreEvent): DecoratedEvent {
  const cat = TYPE_TO_CAT[evt.type];
  const icon = TYPE_ICON_OVERRIDE[evt.type] ?? CATEGORY_META[cat].icon;
  const title = t(`overview.live.event.${evt.type}` as never);
  const detail = describeDetail(evt);
  return { cat, icon, title, detail, evt };
}
