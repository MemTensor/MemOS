/**
 * Safe writer for `config.yaml`.
 *
 * Goals:
 *   - Preserve user's comments and field ordering (we use the YAML CST).
 *   - Validate after merge — never write an invalid file.
 *   - Atomic write (tmp file + rename) so a crash never leaves a half-written
 *     config.
 *   - Re-apply `chmod 600` on every write.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { isMap, YAMLMap } from "yaml";

import { MemosError } from "../../agent-contract/errors.js";
import type { ResolvedHome } from "./paths.js";
import { resolveConfig, type ResolvedConfig } from "./index.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { parseDoc, stringifyYaml } from "./yaml.js";

export interface PatchConfigResult {
  config: ResolvedConfig;
  /** Bytes written. */
  bytes: number;
  /** Path written to. */
  source: string;
  /** True when we created a brand-new file (no prior YAML). */
  created: boolean;
}

/**
 * Apply a partial patch to the on-disk YAML and rewrite. The patch can be
 * arbitrarily nested; missing keys are left alone (deep merge). Returns the
 * fully-resolved config for callers who want to re-broadcast.
 */
export async function patchConfig(
  home: ResolvedHome,
  patch: Record<string, unknown>,
): Promise<PatchConfigResult> {
  let existingText = "";
  let created = false;
  try {
    existingText = await fs.readFile(home.configFile, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      throw new MemosError("config_invalid", `cannot read ${home.configFile}: ${e.message}`, {
        source: home.configFile,
      });
    }
    created = true;
  }

  // Parse (or seed) the YAML document.
  const doc = existingText ? parseDoc(existingText, home.configFile) : parseDoc(stringifyYaml(DEFAULT_CONFIG), "<defaults>");
  applyPatch(doc, patch);

  // Validate against schema using the merged JS view.
  const merged = doc.toJS({ maxAliasCount: -1 }) as Record<string, unknown>;
  const config = resolveConfig(merged);

  // Atomic write.
  await fs.mkdir(dirname(home.configFile), { recursive: true });
  const tmp = join(dirname(home.configFile), `.config.${process.pid}.${Date.now()}.tmp`);
  const text = doc.toString({ lineWidth: 0 });
  await fs.writeFile(tmp, text, { mode: 0o600 });
  try {
    await fs.rename(tmp, home.configFile);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw new MemosError("config_write_failed", `could not move ${tmp} -> ${home.configFile}`, {
      source: home.configFile,
      cause: (err as Error).message,
    });
  }
  // Re-apply 600 in case rename inherited the wrong mode on some FSes.
  await fs.chmod(home.configFile, 0o600).catch(() => undefined);

  const bytes = Buffer.byteLength(text, "utf8");
  return { config, bytes, source: home.configFile, created };
}

/**
 * Walk the patch object and apply each leaf to the YAML Document. Deep keys
 * are created as needed; arrays are replaced wholesale. Comments on existing
 * keys are preserved.
 *
 * Important: `doc.setIn(path, {})` does **not** replace a Scalar node with a
 * YAMLMap — the `yaml` lib stores `{}` as a scalar-like value, and the next
 * nested `setIn(path.concat('subkey'), …)` call then throws
 * `Expected YAML collection at <key>. Remaining path: <sub>`. We've hit this
 * in the wild when users' `config.yaml` has `skillEvolver:` (bare null) or
 * `skillEvolver: ""` — either from a half-written manual edit or a very
 * old install that never got re-seeded from `DEFAULT_CONFIG`. The fix is to
 * call `doc.getIn(path, true)` (keepScalar: true) so we see the AST node,
 * and replace it with an explicit `new YAMLMap()` whenever it isn't already
 * a Map. That covers null, empty string, any scalar, and undefined.
 */
function applyPatch(doc: ReturnType<typeof parseDoc>, patch: Record<string, unknown>, prefix: string[] = []): void {
  for (const [k, v] of Object.entries(patch)) {
    const path = [...prefix, k];
    if (isPlainObject(v)) {
      const existingNode = doc.getIn(path, true);
      if (!isMap(existingNode)) {
        doc.setIn(path, new YAMLMap());
      }
      applyPatch(doc, v as Record<string, unknown>, path);
    } else {
      doc.setIn(path, v);
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
