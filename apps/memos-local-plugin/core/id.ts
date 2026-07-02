/**
 * Tiny id helpers used throughout the core.
 *
 * We use uuid v7 (time-ordered) for anything that benefits from index locality
 * (traces, episodes, events, logs). For human-readable short ids (skill names,
 * span ids, correlation ids) we use a base32-Crockford 12-char shortid.
 */

import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

export function newUuid(): string {
  return uuidv7();
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"; // 32 chars, no I/L/O/U

/**
 * Generate a Crockford base32 short id (default 12 chars ≈ 60 bits of entropy).
 * Time-prefixing not applied here — caller decides.
 */
export function shortId(len = 12): string {
  if (len <= 0) throw new Error("shortId length must be positive");
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CROCKFORD[bytes[i]! & 0x1f];
  }
  return out;
}

/** Convenience wrappers so call sites read like prose. */
export const ids = {
  trace:   () => "tr_" + shortId(12),
  episode: () => "ep_" + shortId(12),
  session: () => "se_" + shortId(12),
  policy:  () => "po_" + shortId(12),
  world:   () => "wm_" + shortId(12),
  skill:   () => "sk_" + shortId(12),
  feedback:() => "fb_" + shortId(12),
  decisionRepair: () => "dr_" + shortId(12),
  span:    () => "sp_" + shortId(8),
  trace_corr: () => "co_" + shortId(8),
  uuid:    newUuid,
} as const;
