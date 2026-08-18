import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions } from "../lib/check-update.js";

test("update checks compare prerelease versions with SemVer precedence", () => {
  assert.equal(compareVersions("1.0.0-beta.10", "1.0.0-beta.9") > 0, true);
  assert.equal(compareVersions("1.0.0-beta.20", "1.0.0-beta.19") > 0, true);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0-beta.alpha") < 0, true);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1") > 0, true);
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
});
