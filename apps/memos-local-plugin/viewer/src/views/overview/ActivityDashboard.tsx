/**
 * Activity dashboard — the 3 × 2 grid that replaces the old JSON
 * `.stream` block on the Overview page.
 *
 * Six tiles, one per surfaced category (memory / experience /
 * environment knowledge / skill / retrieval / feedback). Each tile
 * shows:
 *   - icon + localised category name
 *   - 5-minute event count (big number)
 *   - 30-bucket sparkline (10 s each)
 *   - the most recent event in this category, in plain language
 *
 * The component is a pure renderer of an event window — the parent
 * (`OverviewView`) is responsible for keeping a rolling buffer fed
 * by SSE. We re-bin every render based on `Date.now()` so the
 * sparklines slide left as time passes even when no new events
 * arrive (this matches what users expect from a "last 5 minutes"
 * label).
 */
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";

import type { CoreEvent } from "../../api/types";
import { Icon } from "../../components/Icon";
import { t } from "../../stores/i18n";

import {
  CATEGORY_META,
  TILE_CATEGORIES,
  decorateEvent,
  type DecoratedEvent,
  type EventCategory,
} from "./event-meta";
import { Sparkline } from "./Sparkline";

// ─── Tunables ────────────────────────────────────────────────────────────
//
// 30 × 10 s = 300 s = 5 min. The choice of bucket size trades smoothness
// (smaller bucket → finer sparkline) against rendering cost; 10 s strikes
// a comfortable balance for a tile that's ~28 px tall.
const BUCKET_COUNT = 30;
const BUCKET_MS = 10_000;
const WINDOW_MS = BUCKET_COUNT * BUCKET_MS;

// We re-bin once per BUCKET_MS so the sparkline's leftmost column drops off
// the strip exactly when its underlying events fall out of the window.
const REBIN_MS = BUCKET_MS;

interface ActivityDashboardProps {
  /**
   * Rolling buffer of events newest-first (the shape `OverviewView`
   * already maintains). Older events past the 5-minute window are
   * filtered out at render time, so the parent doesn't have to be
   * fastidious about pruning.
   */
  events: readonly CoreEvent[];
}

interface TileData {
  buckets: number[];
  count: number;
  /** Most recent event in this category within the window, or null. */
  last: DecoratedEvent | null;
}

/**
 * Bucketise the events and pluck the latest one, in a single pass.
 * `now` is parameterised so callers can re-render on a fixed clock
 * tick instead of `Date.now()` drift mid-render.
 */
function buildTileData(
  events: readonly CoreEvent[],
  cat: EventCategory,
  now: number,
): TileData {
  const buckets: number[] = new Array(BUCKET_COUNT).fill(0);
  let count = 0;
  let lastTs = -Infinity;
  let lastEvt: CoreEvent | null = null;
  for (const evt of events) {
    if (evt.ts < now - WINDOW_MS) continue;
    const decorated = decorateEvent(evt);
    if (decorated.cat !== cat) continue;
    const idx = BUCKET_COUNT - 1 - Math.floor((now - evt.ts) / BUCKET_MS);
    if (idx < 0 || idx >= BUCKET_COUNT) continue;
    buckets[idx]++;
    count++;
    if (evt.ts > lastTs) {
      lastTs = evt.ts;
      lastEvt = evt;
    }
  }
  return {
    buckets,
    count,
    last: lastEvt ? decorateEvent(lastEvt) : null,
  };
}

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, Math.round((now - ts) / 1000));
  if (diff < 5) return t("common.justNow");
  if (diff < 60) return t("common.secondsAgo", { n: diff });
  const m = Math.round(diff / 60);
  if (m < 60) return t("common.minutesAgo", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("common.hoursAgo", { n: h });
  const d = Math.round(h / 24);
  return t("common.daysAgo", { n: d });
}

export function ActivityDashboard({
  events,
}: ActivityDashboardProps): JSX.Element {
  // `now` ticks every BUCKET_MS so sparklines visibly slide left even
  // when the SSE stream is quiet for a moment.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), REBIN_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div class="dash-grid" role="list">
      {TILE_CATEGORIES.map((cat) => (
        <Tile key={cat} cat={cat} data={buildTileData(events, cat, now)} now={now} />
      ))}
    </div>
  );
}

interface TileProps {
  cat: EventCategory;
  data: TileData;
  now: number;
}

function Tile({ cat, data, now }: TileProps): JSX.Element {
  const meta = CATEGORY_META[cat];
  return (
    <div class={`dash-tile cat--${cat}`} role="listitem">
      <div class="dash-tile__head">
        <span class="dash-tile__icon" aria-hidden="true">
          <Icon name={meta.icon} size={16} />
        </span>
        <span class="dash-tile__name">{t(meta.labelKey as never)}</span>
      </div>
      <div class="dash-tile__count">
        <span class="dash-tile__count-n">{data.count}</span>
        <span class="dash-tile__count-unit">{t("overview.live.tile.count")}</span>
      </div>
      <div class="dash-tile__spark">
        <Sparkline
          buckets={data.buckets}
          ariaLabel={`${t(meta.labelKey as never)} · ${data.count}`}
        />
      </div>
      <div class="dash-tile__last">
        {data.last ? (
          <>
            <strong>{data.last.title}</strong>
            <span class="dash-tile__last-line">
              {data.last.detail
                ? `${data.last.detail} · ${formatRelative(data.last.evt.ts, now)}`
                : formatRelative(data.last.evt.ts, now)}
            </span>
          </>
        ) : (
          <span class="dash-tile__last-empty">{t("overview.live.tile.empty")}</span>
        )}
      </div>
    </div>
  );
}
