import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateFormalSyncResponse } from "./send-product-release-sync.mjs";

test("accepts handled successful local plugin sync", () => {
  const result = validateFormalSyncResponse({ handled: true, ok: true, source_id: "openclaw-local-plugin" });
  assert.equal(result.ok, true);
});

test("rejects wrong routes and failed syncs", () => {
  assert.throws(() => validateFormalSyncResponse({ handled: false, ok: true }), /did not handle/);
  assert.throws(
    () => validateFormalSyncResponse({ handled: true, ok: false, source_id: "openclaw-local-plugin", skip_reason: "quality" }),
    /quality/,
  );
  assert.throws(
    () => validateFormalSyncResponse({ handled: true, ok: true, source_id: "memos-cloud-cli" }),
    /unexpected source_id/,
  );
});

test("formal sync network request has a bounded timeout", () => {
  const script = readFileSync(new URL("./send-product-release-sync.mjs", import.meta.url), "utf8");
  assert.match(script, /signal: AbortSignal\.timeout\(30_000\)/);
});
