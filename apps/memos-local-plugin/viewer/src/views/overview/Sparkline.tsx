/**
 * A tiny dependency-free SVG sparkline used by the activity
 * dashboard. Takes a fixed-size array of bucket counts and renders
 * them as a stroked polyline plus a translucent area fill.
 *
 * Implementation notes:
 *   - The SVG uses a 100 × 28 internal viewBox and stretches via
 *     `preserveAspectRatio="none"` so multiple sparklines line up
 *     pixel-perfectly across tiles regardless of column width.
 *   - Stroke / fill colour is inherited via the CSS variable `--cat`
 *     set on the parent tile, which keeps the per-category palette
 *     in one place (`shared.css`) instead of being passed prop-wise.
 *   - When the series is flat-zero we still render a one-pixel
 *     baseline so the tile doesn't visually "snap" the moment a
 *     first event arrives.
 */
import type { JSX } from "preact";

interface SparklineProps {
  /**
   * Bucket counts, oldest → newest. The dashboard uses 30 buckets of
   * 10 seconds each (= last 5 minutes), but the component itself is
   * agnostic to bucket size.
   */
  buckets: readonly number[];
  /** Optional accessible label, e.g. "Memory activity over 5 minutes". */
  ariaLabel?: string;
}

export function Sparkline({ buckets, ariaLabel }: SparklineProps): JSX.Element {
  const w = 100;
  const h = 28;
  // 4 px top inset, 2 px bottom inset — gives the stroke headroom so the
  // tallest bar isn't clipped by the SVG edge.
  const TOP = 4;
  const BOTTOM = 2;
  const max = Math.max(1, ...buckets);
  const stepX = buckets.length > 1 ? w / (buckets.length - 1) : 0;
  const points = buckets.map((v, i) => {
    const x = (i * stepX).toFixed(2);
    const y = (h - (v / max) * (h - TOP - BOTTOM) - BOTTOM).toFixed(2);
    return `${x},${y}`;
  });
  const linePath = points.length > 0 ? "M" + points.join(" L") : "";
  const areaPath =
    points.length > 0 ? `${linePath} L${w},${h} L0,${h} Z` : "";

  return (
    <svg
      class="sparkline"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {areaPath && (
        <path d={areaPath} fill="var(--cat)" fill-opacity="0.14" />
      )}
      {linePath && (
        <path
          d={linePath}
          fill="none"
          stroke="var(--cat)"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      )}
    </svg>
  );
}
