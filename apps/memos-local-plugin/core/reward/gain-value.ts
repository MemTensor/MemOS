/**
 * `gain-value.ts` — contribution-adjusted gain scores.
 *
 * The normalized backprop value V distributes the episode reward across
 * contributors, so a long episode mechanically dilutes each V by 1/N. For
 * L2 gain / induction we want the *contribution-adjusted* score: scale each
 * V by the number of nonzero contributors and clamp to [-1, 1].
 *
 * Zero-weight padding (α = 0 ⇒ V = 0) must not change the multiplier, so
 * only nonzero values count toward N.
 *
 * This helper is pure: it never queries the database and never mutates its
 * input. Live scoring calls it with the exact reward-pass set
 * (`backprop(...).updates` values, i.e. `episode.traceIds`); historical
 * conversion calls it only for `inferred_normalized` groups (legacy_unscaled
 * copies V directly).
 */

export function contributionGainValues(values: readonly number[]): number[] {
  if (values.some((value) => !Number.isFinite(value) || Math.abs(value) > 1)) {
    throw new RangeError("gain value input must be finite normalized credit");
  }
  const contributors = values.filter((value) => value !== 0).length;
  return values.map((value) => Math.max(-1, Math.min(1, value * contributors)));
}
