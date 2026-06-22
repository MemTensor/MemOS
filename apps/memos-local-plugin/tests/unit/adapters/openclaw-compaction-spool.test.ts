import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  writeCompactionSegmentSync,
} from "../../../adapters/openclaw/compaction-spool.js";

const tempDirs: string[] = [];

function makeSpoolDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memos-oc-spool-mode-"));
  tempDirs.push(root);
  return path.join(root, "nested", "spool");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenClaw compaction spool", () => {
  it("stores raw compaction snapshots in private files", () => {
    const dir = makeSpoolDir();

    const ref = writeCompactionSegmentSync({
      dir,
      sessionId: "openclaw::main::private-spool",
      seq: 0,
      createdAt: 1_700_000_000_000,
      messages: [{ role: "user", content: "private original transcript" }],
    });

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(ref.path).mode & 0o777).toBe(0o600);
  });
});
