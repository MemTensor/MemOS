/**
 * Helpers for safely mutating ~/.openclaw/openclaw.json from the plugin.
 *
 * Previously this lived inline in index.ts and used a hand-written regex
 * on the raw JSON text. That approach corrupted the config when the same
 * literal that ended `tools.allow` also appeared elsewhere in the file
 * (e.g. inside `models.providers.*.models[*].input`). See issue #1377:
 *   memos-local-openclaw-plugin corrupts openclaw.json by inserting
 *   "group:plugins" into models[*].input.
 *
 * The fixed implementation parses the JSON, mutates the parsed object,
 * and re-serialises it. That guarantees the new entry can only land in
 * tools.allow.
 */

/** Detect indent unit (2 / 4 spaces or tab) by sampling the first indented line. */
function detectIndent(raw: string): string | number {
  const match = raw.match(/\n([ \t]+)\S/);
  if (!match) return 2;
  const indent = match[1];
  if (indent.startsWith("\t")) return "\t";
  return indent.length;
}

/**
 * Ensure that `entry` is present in `tools.allow` inside the given raw
 * openclaw.json text. Returns the (possibly updated) JSON text.
 *
 * Behaviour:
 *   - If parsing fails, the input is returned unchanged.
 *   - If `tools.allow` is missing, empty, contains `"*"`, or already
 *     contains `entry`, the input is returned unchanged (referentially
 *     equal to the input string) — callers can detect "no change" by
 *     identity comparison and skip the disk write.
 *   - Otherwise, the entry is appended to `tools.allow` and the result
 *     is re-serialised with the original indentation. The original
 *     trailing newline is preserved.
 */
export function ensureToolsAllowEntry(raw: string, entry: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object") {
    return raw;
  }
  const root = parsed as Record<string, unknown>;
  const tools = root.tools;
  if (!tools || typeof tools !== "object") {
    return raw;
  }
  const allow = (tools as Record<string, unknown>).allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return raw;
  }
  if (allow.includes(entry) || allow.includes("*")) {
    return raw;
  }

  const next = { ...root, tools: { ...(tools as Record<string, unknown>), allow: [...allow, entry] } };
  const indent = detectIndent(raw);
  let serialised = JSON.stringify(next, null, indent as any);
  if (raw.endsWith("\n") && !serialised.endsWith("\n")) {
    serialised += "\n";
  }
  return serialised;
}
