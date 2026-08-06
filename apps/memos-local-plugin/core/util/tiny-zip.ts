/**
 * Single-file ZIP archive builder.
 *
 * Skill download endpoints want to hand out a `<skill>.zip` containing
 * a single `SKILL.md` file. Pulling in `adm-zip` / `archiver` for that
 * is overkill, so we hand-roll the minimal PKZIP layout: one local
 * file header, one central directory record, one end-of-central-
 * directory record. CRC32 + STORE (no compression) payload.
 *
 * Reference: PKZIP APPNOTE.TXT §4 / 4.3 / 4.4.
 *
 * Limitations (intentional):
 *   - Only one entry per archive.
 *   - No ZIP64 — file size capped at 2 GiB.
 */

import { Buffer } from "node:buffer";

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_END_OF_CENTRAL_DIR = 0x06054b50;

const VERSION_NEEDED = 10; // 1.0 — STORE.
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED; // Unix host, PKZIP 1.0.
const COMPRESSION_STORE = 0;
const FLAGS = 0x0800; // UTF-8 filenames/comments.
const UNIX_REGULAR_FILE_0644 = (0o100644 << 16) >>> 0;

export function buildSingleFileZip(
  filename: string,
  contents: string | Uint8Array,
): Buffer {
  const nameBuf = Buffer.from(filename, "utf8");
  const raw = typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
  const crc32 = computeCrc32(raw);
  const uncompressedSize = raw.length;
  const compressedSize = raw.length;
  const { date, time } = dosTimestamp(new Date());

  // ── Local file header (30 bytes + name + extra) + payload ─────────
  const local = Buffer.alloc(30);
  local.writeUInt32LE(SIG_LOCAL_FILE, 0);
  local.writeUInt16LE(VERSION_NEEDED, 4);
  local.writeUInt16LE(FLAGS, 6);
  local.writeUInt16LE(COMPRESSION_STORE, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc32, 14);
  local.writeUInt32LE(compressedSize, 18);
  local.writeUInt32LE(uncompressedSize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  const localFileSection = Buffer.concat([local, nameBuf, raw]);

  // ── Central directory header (46 bytes + name) ────────────────────
  const central = Buffer.alloc(46);
  central.writeUInt32LE(SIG_CENTRAL_DIR, 0);
  central.writeUInt16LE(VERSION_MADE_BY, 4); // version made by
  central.writeUInt16LE(VERSION_NEEDED, 6); // version needed
  central.writeUInt16LE(FLAGS, 8);
  central.writeUInt16LE(COMPRESSION_STORE, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc32, 16);
  central.writeUInt32LE(compressedSize, 20);
  central.writeUInt32LE(uncompressedSize, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra length
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34); // disk #
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(UNIX_REGULAR_FILE_0644, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset

  const centralSection = Buffer.concat([central, nameBuf]);

  // ── End-of-central-directory record (22 bytes) ────────────────────
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_END_OF_CENTRAL_DIR, 0);
  eocd.writeUInt16LE(0, 4); // disk #
  eocd.writeUInt16LE(0, 6); // disk where central dir starts
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localFileSection.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localFileSection, centralSection, eocd]);
}

function dosTimestamp(d: Date): { date: number; time: number } {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

// ─── CRC32 (IEEE 802.3 polynomial, 0xEDB88320) ───────────────────────────

let cachedTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (cachedTable) return cachedTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  cachedTable = table;
  return table;
}

export function computeCrc32(buf: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
