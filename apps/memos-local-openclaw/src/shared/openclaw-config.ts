import * as fs from "fs";
import { parseJsonOrJson5 } from "./json5";

/**
 * Ensure `"group:plugins"` is present in `tools.allow` inside `openclaw.json`.
 *
 * Strategy:
 *   1. Read the file as JSON5 (the user may have // comments etc. — see issue #1543).
 *   2. If `tools.allow` is missing, wildcarded (`"*"`), or already contains
 *      `"group:plugins"`, do nothing.
 *   3. Otherwise patch the raw text by appending `"group:plugins"` after the
 *      last existing allow entry. We do textual insertion (rather than
 *      `JSON.stringify(cfg)`) so we preserve the user's comments and
 *      formatting in the file.
 *
 * Returns:
 *   - `{ changed: false }` when no edit was needed or the patch could not be
 *     anchored safely.
 *   - `{ changed: true, patched }` when the caller should `writeFileSync` the
 *     `patched` text back.
 */
export interface EnsureGroupPluginsAllowedResult {
  changed: boolean;
  patched?: string;
  reason?: string;
}

const PATCH_VALUE = "group:plugins";

export function ensureGroupPluginsAllowed(
  raw: string,
): EnsureGroupPluginsAllowedResult {
  let cfg: any;
  try {
    cfg = parseJsonOrJson5(raw);
  } catch (err) {
    return { changed: false, reason: `parse failed: ${(err as Error).message}` };
  }

  const allow: unknown = cfg?.tools?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return { changed: false, reason: "tools.allow is missing or empty" };
  }
  if (allow.includes("*") || allow.includes(PATCH_VALUE)) {
    return { changed: false, reason: "tools.allow already permissive enough" };
  }

  const lastEntry = allow[allow.length - 1];
  if (typeof lastEntry !== "string") {
    return { changed: false, reason: "tools.allow last entry is not a string" };
  }

  // Try anchoring on the last entry as either a double-quoted or single-quoted
  // string — openclaw.json is JSON5 and the user may have used either. We also
  // tolerate an optional trailing comma between the last entry and `]`.
  const escaped = lastEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates: Array<{ anchor: RegExp; insert: string }> = [
    {
      anchor: new RegExp(`("${escaped}")(\\s*,?\\s*\\])`),
      insert: `$1,\n      "${PATCH_VALUE}"$2`,
    },
    {
      anchor: new RegExp(`('${escaped}')(\\s*,?\\s*\\])`),
      insert: `$1,\n      '${PATCH_VALUE}'$2`,
    },
  ];

  for (const { anchor, insert } of candidates) {
    if (anchor.test(raw)) {
      const patched = raw.replace(anchor, insert);
      if (patched !== raw && patched.includes(PATCH_VALUE)) {
        return { changed: true, patched };
      }
    }
  }

  return { changed: false, reason: "could not anchor last allow entry" };
}

/**
 * File-level convenience wrapper. Reads `openclawJsonPath`, applies
 * `ensureGroupPluginsAllowed`, writes it back if needed.
 *
 * Caller is expected to pre-check `fs.existsSync(openclawJsonPath)`.
 * Returns the in-memory result so the caller can log.
 */
export function patchOpenclawAllowFile(
  openclawJsonPath: string,
): EnsureGroupPluginsAllowedResult {
  const raw = fs.readFileSync(openclawJsonPath, "utf-8");
  const result = ensureGroupPluginsAllowed(raw);
  if (result.changed && result.patched) {
    fs.writeFileSync(openclawJsonPath, result.patched, "utf-8");
  }
  return result;
}
