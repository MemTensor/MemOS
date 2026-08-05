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
  const sanitized = sanitizePatch(patch);
  applyPatch(doc, sanitized);
  removeUnsupportedUserConfig(doc);

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

function removeUnsupportedUserConfig(doc: ReturnType<typeof parseDoc>): void {
  // Embedding dimensionality is inferred from the provider/model at runtime.
  // Keep stale manual values out of config.yaml so they cannot be mistaken
  // for supported settings on the next edit.
  try {
    doc.deleteIn(["embedding", "dimensions"]);
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Adapter-owned config keys the client is NEVER allowed to patch via
 * `PATCH /api/v1/config`. See #2212: the Hermes adapter hardcodes the
 * viewer port to :18800 via `bridge.mts::AGENT_DEFAULT_PORTS`, but the
 * shared UI defaults surface :18799 (the OpenClaw port) in the resolved
 * config the viewer reads back. If the client mirrors that value into a
 * subsequent PATCH — either because the settings form rehydrated a
 * "dirty" viewer block or because a third-party tool round-tripped GET
 * into PATCH — we used to write 18799 to disk verbatim, silently
 * breaking the bridge until the user hand-edited config.yaml.
 *
 * Sanitising once here means every PATCH path (routes, direct calls,
 * hub-triggered rewrites) inherits the guard.
 */
const ADAPTER_OWNED_PATCH_PATHS: readonly string[] = Object.freeze([
  "viewer.port",
  "viewer.bindHost",
]);

/**
 * Empty-string patches on these fields are silently dropped (like the
 * secret-field treatment in `stripEmptySecrets` on the API layer). This
 * covers UI rehydration paths where an untouched form field would
 * otherwise send `""` and overwrite a previously-configured value — the
 * companion symptom from #2212 where `embedding.endpoint` was clobbered
 * with a stray value after save. Secret fields are handled upstream.
 */
const NON_EMPTY_PATCH_PATHS: readonly string[] = Object.freeze([
  "embedding.endpoint",
  "llm.endpoint",
  "l3Llm.endpoint",
  "skillEvolver.endpoint",
]);

/**
 * Strip adapter-owned keys and empty-string endpoints from an incoming
 * patch before it reaches the YAML writer. Never mutates the caller's
 * object. Prunes now-empty parent maps so we don't leave dangling
 * `viewer: {}` in the patch (which would still be a no-op but is
 * noisier in debug logs).
 */
function sanitizePatch(patch: Record<string, unknown>): Record<string, unknown> {
  // Use `structuredClone` (Node 17+) rather than a JSON round-trip because
  // the latter silently drops `undefined` values — a caller may legitimately
  // pass `{ llm: { endpoint: undefined } }` and expect `applyPatch` to see
  // that leaf (`doc.setIn` handles the write). JSON.stringify would delete
  // the key before it ever reached the writer, silently suppressing the
  // intended patch. `structuredClone` preserves the full object graph.
  const cloned = structuredClone(patch) as Record<string, unknown>;
  for (const dotted of ADAPTER_OWNED_PATCH_PATHS) {
    deleteDottedPath(cloned, dotted);
  }
  for (const dotted of NON_EMPTY_PATCH_PATHS) {
    const value = readDottedPath(cloned, dotted);
    // Trim before comparing so whitespace-only strings (e.g. `"   "` from
    // a UI form) are treated the same as `""` — otherwise they'd slip past
    // this guard and get written to disk as broken endpoint values. The
    // typeof guard also keeps this safe if a non-string value shows up at
    // one of these paths.
    if (typeof value === "string" && value.trim() === "") {
      deleteDottedPath(cloned, dotted);
    }
  }
  return cloned;
}

function readDottedPath(obj: Record<string, unknown>, dotted: string): unknown {
  const keys = dotted.split(".");
  let cursor: unknown = obj;
  for (const key of keys) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function deleteDottedPath(obj: Record<string, unknown>, dotted: string): void {
  const keys = dotted.split(".");
  const stack: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const next = cursor[key];
    if (!isPlainObject(next)) return;
    stack.push({ parent: cursor, key });
    cursor = next;
  }
  const leaf = keys[keys.length - 1]!;
  if (!(leaf in cursor)) return;
  delete cursor[leaf];
  // Prune now-empty parent maps back up the stack.
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i]!;
    const target = frame.parent[frame.key] as Record<string, unknown>;
    if (Object.keys(target).length === 0) {
      delete frame.parent[frame.key];
    } else {
      break;
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
