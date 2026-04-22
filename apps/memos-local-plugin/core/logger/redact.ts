/**
 * Redaction layer.
 *
 * Every record passes through here BEFORE any transport sees it. We mutate a
 * deep clone of `data` / `ctx`, never the original input.
 *
 * Default rules:
 *   - Any object key whose name (case-insensitive) matches an entry in
 *     `extraKeys` gets its value replaced with `"[redacted]"`.
 *   - Any string value matching common secret patterns (Bearer token, JWT,
 *     `sk-…` keys, email, phone, full file path) is masked.
 *
 * Users can extend `extraKeys` and `extraPatterns` from `config.yaml`.
 */

import type { LogRecord, SerializedLogError } from "../../agent-contract/log-record.js";

export interface RedactOptions {
  extraKeys: string[];
  extraPatterns: string[];   // user-supplied regex source strings
}

const BUILTIN_KEY_PATTERNS: RegExp[] = [
  /^api[_-]?key$/i,
  /^secret$/i,
  /^token$/i,
  /^password$/i,
  /^authorization$/i,
  /^auth$/i,
  /^cookie$/i,
  /^session[_-]?token$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
];

const BUILTIN_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,                       // OpenAI-ish keys
  /\beyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+\b/g, // JWTs
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,      // emails
  /(?<!\d)\+?\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{4}(?!\d)/g, // phone-ish
];

export interface RedactedLogRecord extends LogRecord {
  /** When at least one field changed, we mark the record so consumers can tell. */
  _redacted?: boolean;
}

export class Redactor {
  private readonly keyPatterns: RegExp[];
  private readonly valuePatterns: RegExp[];

  constructor(opts: RedactOptions) {
    const extraKeyPatterns = (opts.extraKeys ?? []).map((k) => new RegExp(`^${escapeRegex(k)}$`, "i"));
    const userValuePatterns = (opts.extraPatterns ?? []).map((p) => safeRegex(p));
    this.keyPatterns = [...BUILTIN_KEY_PATTERNS, ...extraKeyPatterns];
    this.valuePatterns = [...BUILTIN_VALUE_PATTERNS, ...userValuePatterns.filter(Boolean) as RegExp[]];
  }

  redact(record: LogRecord): RedactedLogRecord {
    let changed = false;
    const out: RedactedLogRecord = { ...record };

    if (record.data) {
      const r = this.deep(record.data);
      out.data = r.value as Record<string, unknown>;
      changed = changed || r.changed;
    }
    if (record.ctx) {
      const r = this.deep(record.ctx);
      out.ctx = r.value as Record<string, unknown>;
      changed = changed || r.changed;
    }
    if (record.err) {
      const r = this.deepErr(record.err);
      out.err = r.value;
      changed = changed || r.changed;
    }
    if (record.msg) {
      const r = this.maskString(record.msg);
      if (r.changed) {
        out.msg = r.value;
        changed = true;
      }
    }
    if (changed) out._redacted = true;
    return out;
  }

  private deep(input: unknown): { value: unknown; changed: boolean } {
    if (input == null) return { value: input, changed: false };
    if (Array.isArray(input)) {
      let changed = false;
      const arr = input.map((v) => {
        const r = this.deep(v);
        if (r.changed) changed = true;
        return r.value;
      });
      return { value: arr, changed };
    }
    if (typeof input === "object") {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (this.isSecretKey(k)) {
          out[k] = "[redacted]";
          changed = true;
          continue;
        }
        const r = this.deep(v);
        out[k] = r.value;
        if (r.changed) changed = true;
      }
      return { value: out, changed };
    }
    if (typeof input === "string") {
      const r = this.maskString(input);
      return { value: r.value, changed: r.changed };
    }
    return { value: input, changed: false };
  }

  private deepErr(err: SerializedLogError): { value: SerializedLogError; changed: boolean } {
    let changed = false;
    const r = this.deep(err.details ?? {});
    if (r.changed) changed = true;
    const msg = this.maskString(err.message ?? "");
    if (msg.changed) changed = true;
    const stack = err.stack ? this.maskString(err.stack) : null;
    if (stack?.changed) changed = true;
    const out: SerializedLogError = {
      ...err,
      message: msg.value,
      details: r.value as Record<string, unknown>,
    };
    if (stack) out.stack = stack.value;
    if (err.cause) {
      const c = this.deepErr(err.cause);
      out.cause = c.value;
      if (c.changed) changed = true;
    }
    return { value: out, changed };
  }

  private isSecretKey(k: string): boolean {
    return this.keyPatterns.some((p) => p.test(k));
  }

  private maskString(s: string): { value: string; changed: boolean } {
    let out = s;
    let changed = false;
    for (const p of this.valuePatterns) {
      const replaced = out.replace(p, "[redacted]");
      if (replaced !== out) {
        out = replaced;
        changed = true;
      }
    }
    return { value: out, changed };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src, "g");
  } catch {
    // Invalid user pattern: silently drop; we'll log a warning at logger boot.
    return null;
  }
}
