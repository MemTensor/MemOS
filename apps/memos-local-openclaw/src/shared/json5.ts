/**
 * Minimal JSON5-tolerant parser used to read `openclaw.json`.
 *
 * Background: OpenClaw stores its native config (`~/.openclaw/openclaw.json`)
 * in JSON5 — it allows `//` line comments, `/* ... *​/` block comments,
 * single-quoted strings, unquoted identifier keys, and trailing commas.
 * Strict `JSON.parse` chokes on any of these (issue #1543).
 *
 * Bringing in the full `json5` npm package would be the obvious fix, but the
 * plugin must avoid new runtime dependencies (it ships its `dependencies`
 * one-by-one to keep install size small, and the install path runs in user
 * machines where adding npm deps is sensitive). Instead, we normalize the raw
 * text into strict JSON and hand it to the built-in `JSON.parse`.
 *
 * What is supported:
 *   • `//` line comments and `/* … *​/` block comments
 *   • single-quoted strings (`'foo'`)
 *   • unquoted identifier-style object keys (`tools: { ... }`)
 *   • trailing commas before `}` or `]`
 *   • UTF-8 BOM
 *
 * What is NOT supported (rare in practice for openclaw.json):
 *   • Hex numbers (`0xFF`), `+Infinity`, `NaN`, etc. — falls back to error.
 *   • Multi-line string continuation.
 *
 * The implementation walks the text character-by-character with a small state
 * machine so that comment / quote rewriting never touches characters inside
 * string literals (which is the classic regex-based-stripper bug).
 */

export class Json5ParseError extends Error {
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = "Json5ParseError";
  }
}

/**
 * Strip comments, normalize quotes/keys/trailing commas, then `JSON.parse`.
 *
 * Throws Json5ParseError if the normalized text still isn't valid JSON —
 * callers should treat this the same as a malformed `JSON.parse`.
 */
export function parseJson5(text: string): unknown {
  if (typeof text !== "string") {
    throw new Json5ParseError(`parseJson5 expects a string, got ${typeof text}`);
  }

  const normalized = normalizeJson5(text);
  try {
    return JSON.parse(normalized);
  } catch (err) {
    throw new Json5ParseError(
      `Failed to parse JSON5 content as JSON after normalization: ${(err as Error).message}`,
      err,
    );
  }
}

/**
 * Lenient variant: try strict `JSON.parse` first (fast path for files that
 * happen to be plain JSON), fall back to the JSON5-tolerant path on failure.
 *
 * This is the recommended entry point for code that reads `openclaw.json`,
 * because the user's config might or might not contain comments.
 */
export function parseJsonOrJson5(text: string): unknown {
  // Fast path: strict JSON. Use it when possible so we don't pay normalization
  // cost on every read.
  try {
    return JSON.parse(text);
  } catch {
    return parseJson5(text);
  }
}

/**
 * Normalize a JSON5 text into strict JSON-compatible text.
 * Exposed for testing; production callers should use parseJson5 / parseJsonOrJson5.
 */
export function normalizeJson5(input: string): string {
  // Strip UTF-8 BOM
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const out: string[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];
    const next = i + 1 < n ? text[i + 1] : "";

    // Line comment
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      if (i < n) i += 2; // skip closing */
      continue;
    }

    // Double-quoted string — passthrough verbatim, including escapes.
    if (c === '"') {
      out.push(c);
      i++;
      while (i < n) {
        const ch = text[i];
        out.push(ch);
        if (ch === "\\" && i + 1 < n) {
          out.push(text[i + 1]);
          i += 2;
          continue;
        }
        if (ch === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Single-quoted string — rewrite to double-quoted, escaping any embedded `"`.
    if (c === "'") {
      out.push('"');
      i++;
      while (i < n) {
        const ch = text[i];
        if (ch === "\\" && i + 1 < n) {
          // Preserve escape sequence verbatim, except `\'` becomes a plain `'`
          // (because the surrounding quotes are now double quotes).
          const nx = text[i + 1];
          if (nx === "'") {
            out.push("'");
          } else {
            out.push("\\");
            out.push(nx);
          }
          i += 2;
          continue;
        }
        if (ch === "'") {
          out.push('"');
          i++;
          break;
        }
        if (ch === '"') {
          // Escape a bare `"` so the resulting double-quoted string stays valid.
          out.push("\\\"");
          i++;
          continue;
        }
        out.push(ch);
        i++;
      }
      continue;
    }

    out.push(c);
    i++;
  }

  let stripped = out.join("");

  // Unquoted identifier keys: `  foo: 1` → `  "foo": 1`.
  // Matches an identifier that starts with a letter / `_` / `$` and is
  // immediately followed by optional whitespace and `:`. The leading
  // boundary ensures we don't match parts of other tokens.
  stripped = stripped.replace(
    /([\{,\s])([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g,
    (_, lead: string, key: string, tail: string) => `${lead}"${key}"${tail}`,
  );

  // Trailing commas before `}` or `]`.
  stripped = stripped.replace(/,(\s*[}\]])/g, "$1");

  return stripped;
}
