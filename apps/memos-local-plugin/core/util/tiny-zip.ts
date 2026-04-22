/**
 * Single-file ZIP archive builder.
 *
 * Skill download endpoints want to hand out a `<skill>.zip` containing
 * a single `SKILL.md` file. Pulling in `adm-zip` / `archiver` for that
 * is overkill, so we hand-roll the minimal PKZIP layout: one local
 * file header, one central directory record, one end-of-central-
 * directory record. CRC32 + DEFLATE-compressed payload.
 *
 * Reference: PKZIP APPNOTE.TXT §4 / 4.3 / 4.4.
 *
 * Limitations (intentional):
 *   - Only one entry per archive.
 *   - No ZIP64 — file size capped at 2 GiB.
 *   - No timestamp metadata — we always record 1980-01-01 00:00 UTC,
 *     which most extractors render as a placeholder. This keeps the
 *     output deterministic for tests.
 */

import { deflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_END_OF_CENTRAL_DIR = 0x06054b50;

const VERSION_NEEDED = 20; // 2.0 — DEFLATE.
const COMPRESSION_DEFLATE = 8;
const FLAGS = 0;

const DOS_DATE = 0x21; // 1980-01-01
const DOS_TIME = 0x00; // 00:00:00

export function buildSingleFileZip(
  filename: string,
  contents: string | Uint8Array,
): Buffer {
  const nameBuf = Buffer.from(filename, "utf8");
  const raw = typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
  const compressed = deflateRawSync(raw);
  const crc32 = computeCrc32(raw);
  const uncompressedSize = raw.length;
  const compressedSize = compressed.length;

  // ── Local file header (30 bytes + name + extra) + payload ─────────
  const local = Buffer.alloc(30);
  local.writeUInt32LE(SIG_LOCAL_FILE, 0);
  local.writeUInt16LE(VERSION_NEEDED, 4);
  local.writeUInt16LE(FLAGS, 6);
  local.writeUInt16LE(COMPRESSION_DEFLATE, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc32, 14);
  local.writeUInt32LE(compressedSize, 18);
  local.writeUInt32LE(uncompressedSize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra length

  const localFileSection = Buffer.concat([local, nameBuf, compressed]);

  // ── Central directory header (46 bytes + name) ────────────────────
  const central = Buffer.alloc(46);
  central.writeUInt32LE(SIG_CENTRAL_DIR, 0);
  central.writeUInt16LE(VERSION_NEEDED, 4); // version made by
  central.writeUInt16LE(VERSION_NEEDED, 6); // version needed
  central.writeUInt16LE(FLAGS, 8);
  central.writeUInt16LE(COMPRESSION_DEFLATE, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc32, 16);
  central.writeUInt32LE(compressedSize, 20);
  central.writeUInt32LE(uncompressedSize, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra length
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34); // disk #
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
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
