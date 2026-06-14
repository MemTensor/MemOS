/**
 * Lightweight JSON5-tolerant parser.
 *
 * `openclaw.json` is JSON5: line/block comments and trailing commas are legal.
 * The standard `JSON.parse` chokes on those, so anywhere we *read* `openclaw.json`
 * we go through this helper first.
 *
 * This is a deliberately small shim, not a full JSON5 implementation:
 *   - strips `// …` line comments (string-literal aware)
 *   - strips `/* … *\/` block comments (string-literal aware, preserves newline count)
 *   - strips trailing commas before `]` and `}` (string-literal aware)
 *   - delegates to `JSON.parse`
 *
 * It does NOT support unquoted keys, single-quoted strings, hex literals, etc.
 * Comments are by far the dominant JSON5 affordance users hit (issue #1543);
 * the rest can be added if a real case shows up.
 *
 * NOTE: this helper is read-only. It cannot round-trip — any writeback path
 * must operate on the original raw text (e.g. targeted regex replace) to
 * preserve the user's comments and formatting.
 */
export function parseJsonWithComments<T = unknown>(text: string): T {
  return JSON.parse(stripJsonComments(text)) as T;
}

/**
 * Strip `//` line comments, `/* *\/` block comments, and trailing commas from
 * a JSON-ish string. String literals (including escaped quotes) are left alone.
 *
 * Implemented as a single string-literal-aware character scan so that comma
 * stripping can't accidentally rewrite content inside strings (e.g. a value
 * like `",]"` must round-trip untouched), and so block comments preserve the
 * newline count for accurate `JSON.parse` error line numbers.
 *
 * Exported for tests; prefer `parseJsonWithComments` for normal use.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";

    // ─── String literal ─────────────────────────────────────────────────
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const sch = text[i];
        if (sch === "\\" && i + 1 < n) {
          // Preserve escape sequences verbatim (e.g. \", \\, \n).
          out += sch + text[i + 1];
          i += 2;
          continue;
        }
        out += sch;
        i += 1;
        if (sch === quote) break;
      }
      continue;
    }

    // ─── Line comment: `// …` to end-of-line ────────────────────────────
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i += 1;
      // Leave the newline so line numbers stay aligned in error messages.
      continue;
    }

    // ─── Block comment: `/* … */` ───────────────────────────────────────
    // Preserve the newline count so JSON.parse error line numbers continue
    // to align with the original source.
    if (ch === "/" && next === "*") {
      i += 2;
      let newlines = 0;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") newlines += 1;
        i += 1;
      }
      i += 2; // skip closing `*/`
      if (newlines > 0) out += "\n".repeat(newlines);
      continue;
    }

    // ─── Trailing comma: `,` followed by ws then `]` or `}` ─────────────
    if (ch === ",") {
      let j = i + 1;
      while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) {
        j += 1;
      }
      if (j < n && (text[j] === "]" || text[j] === "}")) {
        // Drop the comma but keep the whitespace untouched so line numbers
        // and indentation are preserved.
        i += 1;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Find the index of the closing brace/bracket that matches the opening one at
 * `openIdx`. Respects string literals (including `\"` escapes) and skips
 * line/block comments so it works on JSON5-ish text. Returns -1 if no match.
 *
 * `text[openIdx]` must equal `open`.
 */
export function findMatchingDelimiter(
  text: string,
  openIdx: number,
  open: "{" | "[",
  close: "}" | "]",
): number {
  if (text[openIdx] !== open) return -1;
  const n = text.length;
  let depth = 0;
  let i = openIdx;
  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";

    // String literal — skip past it without counting delimiters inside.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < n) {
        const sch = text[i];
        if (sch === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        i += 1;
        if (sch === quote) break;
      }
      continue;
    }

    // Line comment.
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }

    // Block comment.
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    if (ch === open) {
      depth += 1;
    }
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Escape regex metacharacters in `s` so it can be safely embedded in a `new RegExp(...)`. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Add `newEntry` to the `tools.allow` array in a JSON5 openclaw config string,
 * inserting it after the existing last entry. The patch is anchored to the
 * `tools.allow` array span (located via brace/bracket matching that respects
 * string literals and comments) so it cannot stray into other arrays
 * elsewhere in the file — the root cause of #1377.
 *
 * `lastEntry` is regex-escaped before being interpolated, so tool names that
 * contain regex metacharacters (`.`, `+`, `?`, `(`, `\\`, ...) match correctly.
 *
 * Returns the patched text, or the original unchanged if the structure can't
 * be located or the last entry can't be matched.
 */
export function patchToolsAllow(raw: string, lastEntry: string, newEntry: string): string {
  // 1. Locate `"tools"\s*:\s*{`
  const toolsMatch = raw.match(/"tools"\s*:\s*\{/);
  if (!toolsMatch || toolsMatch.index === undefined) return raw;
  const toolsBraceIdx = toolsMatch.index + toolsMatch[0].length - 1; // index of `{`
  // 2. Find balanced `}` for the tools object.
  const toolsEnd = findMatchingDelimiter(raw, toolsBraceIdx, "{", "}");
  if (toolsEnd < 0) return raw;

  // 3. Locate `"allow"\s*:\s*[` *within* the tools block.
  const toolsBlock = raw.slice(toolsBraceIdx, toolsEnd);
  const allowMatch = toolsBlock.match(/"allow"\s*:\s*\[/);
  if (!allowMatch || allowMatch.index === undefined) return raw;
  const allowBracketIdx = toolsBraceIdx + allowMatch.index + allowMatch[0].length - 1; // index of `[`
  // 4. Find balanced `]` for the allow array.
  const allowEnd = findMatchingDelimiter(raw, allowBracketIdx, "[", "]");
  if (allowEnd < 0) return raw;

  // 5. Operate only on the array's contents (between the brackets).
  const allowContentStart = allowBracketIdx + 1;
  const arrayContent = raw.slice(allowContentStart, allowEnd);

  const escapedLast = escapeRegExp(JSON.stringify(lastEntry));
  // Match the last entry, then optional trailing comma + whitespace, anchored
  // at the end of the array contents (just before the closing `]`).
  const re = new RegExp(`(${escapedLast})\\s*,?(\\s*)$`);
  if (!re.test(arrayContent)) return raw;

  const patched = arrayContent.replace(re, `$1,\n      ${JSON.stringify(newEntry)}$2`);
  return raw.slice(0, allowContentStart) + patched + raw.slice(allowEnd);
}
