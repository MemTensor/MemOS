/**
 * File transport with size + date rotation and optional gzip on rotation.
 *
 * Writes are append-only. Rotation triggers when EITHER:
 *   - the current file's size exceeds `maxSizeMb`, or
 *   - the calendar day (UTC) has changed since the file was opened.
 *
 * On rotation:
 *   - Active file is closed.
 *   - Renamed to `<base>.YYYY-MM-DD[.N].log` (or `.jsonl`).
 *   - Optionally gzipped.
 *   - When `maxFiles` is positive, oldest archives beyond that count are
 *     deleted. (Does NOT apply when `mode` is "audit"; audit is permanent.)
 *
 * The transport is intentionally synchronous (`appendFileSync`) — logging
 * latency dominates LLM call time anyway, and we want crash-safety without
 * complexity.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { basename, dirname, join } from "node:path";

import type { LogRecord, Transport } from "../types.js";
import { formatJson } from "../format/json.js";
import { formatCompact } from "../format/compact.js";

export interface FileRotatingOptions {
  /** Absolute path of the active file (e.g. `…/logs/memos.log`). */
  filePath: string;
  /** "json" emits one JSON object per line. "compact" emits k=v pairs. */
  format: "json" | "compact";
  /** Rotate when the file exceeds this size. Set to 0 to disable size rotation. */
  maxSizeMb: number;
  /** Maximum archived files to keep ("forever" if 0). */
  maxFiles: number;
  /** gzip archived files. */
  gzip: boolean;
  /**
   * When "audit", never delete archives regardless of `maxFiles`. We still
   * rotate (monthly), still gzip, but archives stay forever.
   */
  mode?: "default" | "audit";
}

export class FileRotatingTransport implements Transport {
  readonly name: string;
  private fd: number | null = null;
  private openedAt = new Date(0);
  private openedSizeBytes = 0;
  private writtenSinceCheck = 0;
  private readonly maxSizeBytes: number;

  constructor(private readonly opts: FileRotatingOptions) {
    this.name = `file:${basename(opts.filePath)}`;
    this.maxSizeBytes = Math.max(0, opts.maxSizeMb) * 1024 * 1024;
    this.openIfNeeded();
  }

  accepts(_record: LogRecord): boolean {
    return true;
  }

  write(record: LogRecord): void {
    try {
      const text = this.opts.format === "compact" ? formatCompact(record) : formatJson(record);
      this.writeText(text);
    } catch {
      // never throw
    }
  }

  flush(): void {/* sync writes; no-op */}

  close(): void {
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private writeText(text: string): void {
    if (this.shouldRotateBeforeWrite(text.length)) this.rotate();
    this.openIfNeeded();
    if (this.fd === null) {
      // Couldn't open the file (permission?) — drop silently rather than crash.
      return;
    }
    try {
      appendFileSync(this.fd, text, "utf8");
      this.writtenSinceCheck += text.length;
    } catch {
      // Re-open on next write.
      this.close();
    }
  }

  private openIfNeeded(): void {
    if (this.fd !== null) return;
    try {
      mkdirSync(dirname(this.opts.filePath), { recursive: true, mode: 0o700 });
      this.fd = openSync(this.opts.filePath, "a");
      try {
        const st = fstatSync(this.fd);
        this.openedSizeBytes = st.size;
      } catch {
        this.openedSizeBytes = 0;
      }
      this.writtenSinceCheck = 0;
      this.openedAt = new Date();
    } catch {
      this.fd = null;
    }
  }

  private shouldRotateBeforeWrite(nextChunkBytes: number): boolean {
    if (this.fd === null) return false;
    if (this.maxSizeBytes > 0
        && this.openedSizeBytes + this.writtenSinceCheck + nextChunkBytes > this.maxSizeBytes) {
      return true;
    }
    const today = new Date();
    if (today.getUTCFullYear() !== this.openedAt.getUTCFullYear()
        || today.getUTCMonth() !== this.openedAt.getUTCMonth()
        || today.getUTCDate() !== this.openedAt.getUTCDate()) {
      return true;
    }
    return false;
  }

  private rotate(): void {
    this.close();
    if (!existsSync(this.opts.filePath)) return;

    const stamp = isoDay(new Date());
    const dir = dirname(this.opts.filePath);
    const base = basename(this.opts.filePath);

    // Find next free index for today.
    let n = 0;
    let target = join(dir, `${base}.${stamp}.log`);
    while (existsSync(target) || existsSync(target + ".gz")) {
      n += 1;
      target = join(dir, `${base}.${stamp}.${n}.log`);
    }
    try {
      renameSync(this.opts.filePath, target);
    } catch {
      return;
    }

    if (this.opts.gzip) {
      try {
        const buf = require("node:fs").readFileSync(target);
        require("node:fs").writeFileSync(target + ".gz", gzipSync(buf));
        unlinkSync(target);
      } catch {
        // leave the uncompressed archive in place; better than nothing
      }
    }

    if (this.opts.mode !== "audit" && this.opts.maxFiles > 0) {
      this.pruneOldArchives();
    }
  }

  private pruneOldArchives(): void {
    try {
      const dir = dirname(this.opts.filePath);
      const base = basename(this.opts.filePath);
      const entries = readdirSync(dir)
        .filter((n) => n.startsWith(base + "."))
        .map((name) => ({ name, full: join(dir, name), mtime: safeMtime(join(dir, name)) }))
        .sort((a, b) => b.mtime - a.mtime);
      const keep = this.opts.maxFiles;
      for (const e of entries.slice(keep)) {
        try { unlinkSync(e.full); } catch { /* ignore */ }
      }
    } catch {
      // ignore prune failures
    }
  }
}

function isoDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeMtime(p: string): number {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}
