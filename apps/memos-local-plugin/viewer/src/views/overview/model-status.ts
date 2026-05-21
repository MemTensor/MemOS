import { t } from "../../stores/i18n";

export interface ModelInfo {
  available?: boolean;
  provider?: unknown;
  model?: unknown;
  dim?: number;
  inherited?: boolean;
  /** Epoch ms of most recent direct primary-provider success. */
  lastOkAt?: unknown;
  /**
   * Epoch ms of most recent rescued-by-host-fallback call. Populates
   * the "yellow" overview state.
   */
  lastFallbackAt?: unknown;
  /** Most recent failure (sticky — see ModelHealth comment). */
  lastError?: { at?: unknown; message?: unknown } | null;
}

export type ModelDotKind = "ok" | "fallback" | "err" | "idle" | "off";

/**
 * Derive the overview card status from a model health payload.
 *
 * The card is painted by picking the most-recent of three timestamps
 * — `lastOkAt`, `lastFallbackAt`, `lastError.at` — and mapping that
 * winner to a colour:
 *
 *   - `ok` (green)        — primary provider answered directly.
 *   - `fallback` (yellow) — primary failed but host LLM bridge
 *                           rescued the call.
 *   - `err` (red)         — primary failed and either there was no
 *                           fallback or the fallback also failed.
 */
export function modelStatusFromInfo(info: ModelInfo | undefined): {
  kind: ModelDotKind;
  label: string;
  tooltip?: string;
} {
  if (!info || info.available === false) {
    return { kind: "off", label: t("overview.metric.model.unconfigured") };
  }

  const okAt = timestampMs(info.lastOkAt);
  const fbAt = timestampMs(info.lastFallbackAt);
  const errAt = timestampMs(info.lastError?.at);
  const max = Math.max(okAt, fbAt, errAt);

  if (max === 0) {
    return { kind: "idle", label: t("overview.metric.model.idle") };
  }

  // Fallback wins ties against errors because the backend stamps
  // `lastFallbackAt` and `lastError.at` at the same instant when the
  // host bridge rescued the call.
  if (fbAt > 0 && fbAt >= errAt && fbAt >= okAt) {
    const raw = statusText(info.lastError?.message).trim();
    const head = t("overview.metric.model.fallback");
    const tail = raw ? `: ${raw.length > 60 ? raw.slice(0, 59) + "…" : raw}` : "";
    return {
      kind: "fallback",
      label: head + tail,
      tooltip: raw
        ? t("overview.metric.model.fallback.tooltip", { msg: raw })
        : head,
    };
  }

  if (errAt > 0 && errAt >= okAt) {
    const raw = statusText(info.lastError?.message).trim();
    const short =
      raw.length > 80 ? raw.slice(0, 79) + "…" : raw || t("overview.metric.model.failed");
    return {
      kind: "err",
      label: short,
      tooltip: raw || t("overview.metric.model.failed"),
    };
  }

  return {
    kind: "ok",
    label: t("overview.metric.model.connected"),
    tooltip: t("overview.metric.model.connectedAt", {
      ts: new Date(okAt).toLocaleTimeString(),
    }),
  };
}

export function modelScalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function formatModelStatusLine(
  statusLabel: string,
  hint?: unknown,
  provider?: unknown,
): string {
  const parts = [statusLabel, modelScalarText(hint).trim()].filter(Boolean);
  return parts.join(" · ") || modelScalarText(provider).trim() || "—";
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function statusText(value: unknown): string {
  if (value instanceof Error) return value.message;
  const scalar = modelScalarText(value);
  if (scalar) return scalar;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}
