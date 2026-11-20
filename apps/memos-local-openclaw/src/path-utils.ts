/**
 * Path comparison helpers shared by the plugin runtime.
 *
 * Why a dedicated module:
 *   - The plugin's `register()` closure used to inline these helpers, which
 *     made them invisible to unit tests and let a Windows-specific path
 *     bug (`/C:/Users/...` URL-pathname form, `\\?\UNC\…` long-path prefix,
 *     mixed slash directions) trip the better-sqlite3 sandbox guard and
 *     refuse to load a perfectly valid native binding.
 *   - Extracting them here lets `tests/path-utils.test.ts` exercise every
 *     known Windows path shape from a Linux CI box by stubbing
 *     `process.platform` between cases.
 *
 * Cross-reference: `scripts/postinstall.cjs` keeps its own
 * `normalizePathForMatch` helper because it runs as CommonJS before the
 * plugin loads. Keep the two in sync if either side changes semantics.
 */

import * as path from "path";

const isWin = process.platform === "win32";
const platformPath = isWin ? path.win32 : path.posix;

/**
 * Canonicalise an absolute filesystem path so two callers can compare
 * paths without tripping on platform-specific quirks.
 *
 * On Windows the function:
 *   1. strips a leading slash that precedes a drive letter
 *      (`/C:/Users/...` → `C:/Users/...`), which is the shape
 *      `new URL(import.meta.url).pathname` returns on Node ≤ 22;
 *   2. unwraps the `\\?\UNC\server\share` extended UNC prefix into
 *      `\\server\share`;
 *   3. strips the plain `\\?\` long-path prefix;
 *   4. resolves to an absolute path with native separators;
 *   5. converts all `\` to `/`;
 *   6. lower-cases the result (Windows paths are case-insensitive).
 *
 * On POSIX the function resolves the path, swaps backslashes to forward
 * slashes (a no-op for legal POSIX paths), and returns it unchanged.
 * The case is preserved so callers do not silently mismatch on
 * case-sensitive filesystems.
 */
export function normalizeFsPath(p: string): string {
  let s = p;

  // 1. URL pathname form: `/C:/Users/...` → `C:/Users/...`.
  //    Only fires when the next two chars are a drive letter + `:`
  //    followed by a separator. POSIX absolute paths like
  //    `/home/user/...` are untouched.
  s = s.replace(/^\/(?=[A-Za-z]:[\\/])/, "");

  // 2. Extended UNC: `\\?\UNC\server\share` → `\\server\share`.
  //    The leading `\\` is preserved so step 4 still sees a UNC path.
  s = s.replace(/^\\\\\?\\UNC\\/i, "\\\\");

  // 3. Plain extended-length prefix: `\\?\C:\Users\...` → `C:\Users\...`.
  s = s.replace(/^\\\\\?\\/, "");

  // 4. Resolve to absolute form using the platform-appropriate flavour.
  //    Using the platform-specific module (rather than the default `path`)
  //    keeps the tests deterministic on Linux CI when we stub
  //    `process.platform`.
  s = platformPath.resolve(s);

  // 5. Unify separators.
  s = s.replace(/\\/g, "/");

  // 6. Lower-case only on Windows.
  if (isWin) s = s.toLowerCase();

  return s;
}

/**
 * Return `true` iff `targetPath` is the same directory as `baseDir`
 * or one of its descendants. Both inputs are normalised through
 * `normalizeFsPath` first; the relative computation is then done in
 * POSIX form so the answer does not depend on platform separators.
 *
 * Behaviour for edge cases:
 *   - same directory                                → `true`
 *   - descendant (`base/sub/file`)                  → `true`
 *   - sibling (`base/../other/file`)                → `false`
 *   - parent (`base/..`)                            → `false`
 *   - different drive on Windows (`D:\…` vs `C:\…`) → `false`
 */
export function isPathInside(baseDir: string, targetPath: string): boolean {
  const base = normalizeFsPath(baseDir);
  const target = normalizeFsPath(targetPath);
  const rel = path.posix.relative(base, target);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith("../")) return false;
  if (path.posix.isAbsolute(rel)) return false;
  return true;
}
