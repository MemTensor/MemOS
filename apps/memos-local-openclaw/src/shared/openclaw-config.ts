import * as fs from "fs";
import JSON5 from "json5";

/**
 * Parse an openclaw.json file, accepting JSON5 syntax (line/block comments,
 * single-quoted strings, trailing commas, unquoted identifier keys).
 *
 * Strict JSON is a subset of JSON5, so any file that used to parse with
 * `JSON.parse` continues to parse here.
 *
 * We centralize this in one helper so every openclaw.json read site behaves
 * identically — users routinely add `// ...` comments to their config and we
 * must not crash on them (see issue #1543).
 */
export function parseOpenClawConfig(raw: string): unknown {
  return JSON5.parse(raw);
}

/** Read + parse an openclaw.json file with JSON5 tolerance. */
export function readOpenClawConfig(configPath: string): unknown {
  return parseOpenClawConfig(fs.readFileSync(configPath, "utf-8"));
}
