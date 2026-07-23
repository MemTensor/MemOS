import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedReleaseConfirmation,
  validateReleaseConfirmation,
} from "./validate-release-confirmation.mjs";

test("builds the exact publish confirmation phrase from a version", () => {
  assert.equal(expectedReleaseConfirmation("2.0.11"), "PUBLISH v2.0.11");
  assert.equal(expectedReleaseConfirmation("v2.0.11-beta.1"), "PUBLISH v2.0.11-beta.1");
});

test("does not require publish confirmation for dry runs", () => {
  assert.equal(
    validateReleaseConfirmation({
      version: "2.0.11",
      dryRun: "true",
      confirmation: "",
    }).ok,
    true,
  );
});

test("requires exact publish confirmation before a real release", () => {
  assert.equal(
    validateReleaseConfirmation({
      version: "2.0.11",
      dryRun: "false",
      confirmation: "",
    }).ok,
    false,
  );
  assert.equal(
    validateReleaseConfirmation({
      version: "2.0.11",
      dryRun: "false",
      confirmation: "PUBLISH 2.0.11",
    }).ok,
    false,
  );
  assert.equal(
    validateReleaseConfirmation({
      version: "2.0.11",
      dryRun: "false",
      confirmation: "PUBLISH v2.0.11",
    }).ok,
    true,
  );
});
