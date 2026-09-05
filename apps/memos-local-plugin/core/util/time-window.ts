/**
 * Daily wall-clock window evaluation for `algorithm.deepProcessing`
 * (issue #2333).
 *
 * Pure functions only: parse a `HH:MM-HH:MM` spec and decide whether a
 * given instant falls inside it, optionally in an IANA timezone. Kept
 * dependency-free so adapters and tests can evaluate the same predicate
 * the pipeline uses.
 */

export interface DailyWindow {
  /** Start minute-of-day (inclusive). */
  startMin: number;
  /** End minute-of-day (exclusive). */
  endMin: number;
}

const WINDOW_SPEC_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

/**
 * Parse a `HH:MM-HH:MM` window spec. Returns `null` when the spec is
 * malformed or out of range — callers should treat that as "no window"
 * and log a config warning.
 *
 * A range whose start is greater than its end wraps past midnight
 * (`23:00-07:00` covers the overnight span). A zero-length window
 * (`start === end`) never matches; use `mode: "always"` for that.
 */
export function parseDailyWindow(spec: string): DailyWindow | null {
  const raw = spec?.trim() ?? "";
  if (!raw) return null;
  const m = WINDOW_SPEC_RE.exec(raw);
  if (!m) return null;
  const startH = Number(m[1]);
  const startM = Number(m[2]);
  const endH = Number(m[3]);
  const endM = Number(m[4]);
  if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return null;
  return { startMin: startH * 60 + startM, endMin: endH * 60 + endM };
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let fmt = zoneFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    });
    zoneFormatters.set(timezone, fmt);
  }
  return fmt;
}

/**
 * True when `timezone` is a valid IANA name (or empty = system local).
 * Config loading uses this to warn-and-fall-back instead of crashing a
 * recurring timer on a typo'd zone.
 */
export function isValidTimezone(timezone: string): boolean {
  const tz = timezone?.trim() ?? "";
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Minute-of-day for `nowMs` in the given IANA timezone. Empty timezone =
 * host system local time. Throws for invalid IANA names (same contract as
 * `Intl.DateTimeFormat`) — validate user config before calling this in a
 * recurring path.
 */
export function minuteOfDay(nowMs: number, timezone?: string): number {
  const tz = timezone?.trim() ?? "";
  if (!tz) {
    const d = new Date(nowMs);
    return d.getHours() * 60 + d.getMinutes();
  }
  const parts = formatterFor(tz).formatToParts(new Date(nowMs));
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "hour") hour = Number(p.value);
    else if (p.type === "minute") minute = Number(p.value);
  }
  // Defensive against exotic ICU output ("24:xx" legacy midnight encoding).
  return ((hour % 24) * 60 + minute) % 1_440;
}

/**
 * True when `nowMs` falls inside the parsed window: inclusive start,
 * exclusive end, overnight wrap supported. A `null` window (invalid spec)
 * never matches so a malformed config cannot silently enable background
 * LLM traffic.
 */
export function isWithinDailyWindow(
  nowMs: number,
  window: DailyWindow | null,
  timezone?: string,
): boolean {
  if (!window) return false;
  const min = minuteOfDay(nowMs, timezone);
  if (window.startMin === window.endMin) return false;
  if (window.startMin < window.endMin) {
    return min >= window.startMin && min < window.endMin;
  }
  // Overnight wrap, e.g. 23:00-07:00.
  return min >= window.startMin || min < window.endMin;
}
