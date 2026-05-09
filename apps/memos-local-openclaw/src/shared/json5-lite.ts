/**
 * Lightweight JSON5-tolerant parser.
 *
 * `openclaw.json` is JSON5: line/block comments and trailing commas are legal.
 * The standard `JSON.parse` chokes on those, so anywhere we *read* `openclaw.json`
 * we go through this helper first.
 *
 * This is a deliberately small shim, not a full JSON5 implementation:
 *   - strips `// …` line comments (string-literal aware)
 *   - strips `/* … *\/` block comments (string-literal aware)
 *   - strips trailing commas before `]` and `}`
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
 * Exported for tests; prefer `parseJsonWithComments` for normal use.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let inString = false;
  let stringQuote = "";

  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : "";

    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        // Preserve escape sequences verbatim (e.g. \", \\, \n).
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
      }
      i += 1;
      continue;
    }

    // Enter a string literal.
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }

    // Line comment: `// …` to end-of-line.
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i += 1;
      // Leave the newline so line numbers stay aligned in error messages.
      continue;
    }

    // Block comment: `/* … */`
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2; // skip closing `*/`
      continue;
    }

    out += ch;
    i += 1;
  }

  // Strip trailing commas: `,` followed by optional whitespace and `]` or `}`.
  // Run outside the per-char loop so it doesn't have to be string-aware itself
  // (the prior pass already preserved string content).
  return out.replace(/,(\s*[\]}])/g, "$1");
}
