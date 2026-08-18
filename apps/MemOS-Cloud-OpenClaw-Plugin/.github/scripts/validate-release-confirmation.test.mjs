import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  expectedReleaseConfirmation,
  main,
  validateReleaseChannel,
  validateReleaseConfirmation,
} from "./validate-release-confirmation.mjs";

test("builds the exact publish confirmation phrase from a version", () => {
  assert.equal(expectedReleaseConfirmation("0.1.20"), "PUBLISH v0.1.20");
  assert.equal(expectedReleaseConfirmation("v0.1.20-beta.1"), "PUBLISH v0.1.20-beta.1");
});

test("does not require publish confirmation for dry runs", () => {
  assert.equal(
    validateReleaseConfirmation({
      version: "0.1.20",
      dryRun: "true",
      confirmation: "",
    }).ok,
    true,
  );
});

test("requires stable versions to use latest and prereleases to use a preview channel", () => {
  const stable = validateReleaseChannel({ version: "0.1.20", npmDistTag: "latest" });
  assert.equal(stable.ok, true);
  assert.equal(stable.release_channel, "stable");
  assert.equal(stable.github_release_prerelease, false);
  assert.equal(stable.docs_sync_expected, true);

  const beta = validateReleaseChannel({ version: "0.1.20-beta.1", npmDistTag: "beta" });
  assert.equal(beta.ok, true);
  assert.equal(beta.release_channel, "prerelease");
  assert.equal(beta.prerelease_identifier, "beta");
  assert.equal(beta.expected_npm_dist_tag, "beta");
  assert.equal(beta.github_release_prerelease, true);
  assert.equal(beta.docs_sync_expected, false);

  const releaseCandidate = validateReleaseChannel({
    version: "0.1.20-rc.1",
    npmDistTag: "next",
  });
  assert.equal(releaseCandidate.ok, true);
  assert.equal(releaseCandidate.expected_npm_dist_tag, "next");

  const prereleaseOnLatest = validateReleaseChannel({
    version: "0.1.20-beta.1",
    npmDistTag: "latest",
  });
  assert.equal(prereleaseOnLatest.ok, false);
  assert.match(prereleaseOnLatest.reason, /must use npm dist-tag 'beta'/);

  const betaOnAlpha = validateReleaseChannel({
    version: "0.1.20-beta.1",
    npmDistTag: "alpha",
  });
  assert.equal(betaOnAlpha.ok, false);
  assert.match(betaOnAlpha.reason, /must use npm dist-tag 'beta'/);

  const stableOnBeta = validateReleaseChannel({ version: "0.1.20", npmDistTag: "beta" });
  assert.equal(stableOnBeta.ok, false);
  assert.match(stableOnBeta.reason, /must use npm dist-tag 'latest'/);
});

test("requires exact publish confirmation before a real release", () => {
  assert.equal(
    validateReleaseConfirmation({
      version: "0.1.20",
      dryRun: "false",
      confirmation: "",
    }).ok,
    false,
  );
  assert.equal(
    validateReleaseConfirmation({
      version: "0.1.20",
      dryRun: "false",
      confirmation: "PUBLISH 0.1.20",
    }).ok,
    false,
  );
  assert.equal(
    validateReleaseConfirmation({
      version: "0.1.20",
      dryRun: "false",
      confirmation: "PUBLISH v0.1.20",
    }).ok,
    true,
  );
});

test("uses a reviewed merged version PR as the confirmation for an automatic Draft release", () => {
  const result = validateReleaseConfirmation({
    version: "0.1.21",
    dryRun: "false",
    confirmation: "",
    automaticRelease: "true",
  });
  assert.equal(result.ok, true);
  assert.match(result.reason, /four-file version increase/);
});

test("exports deterministic beta and Docs routing metadata for workflows", () => {
  const output = join(mkdtempSync(join(tmpdir(), "openclaw-release-policy-")), "output");
  main({
    RELEASE_VERSION: "0.1.20-beta.1",
    NPM_DIST_TAG: "beta",
    DRY_RUN: "true",
    PUBLISH_CONFIRMATION: "",
    GITHUB_OUTPUT: output,
  });
  const values = readFileSync(output, "utf8");
  assert.match(values, /^release_channel=prerelease$/m);
  assert.match(values, /^prerelease_identifier=beta$/m);
  assert.match(values, /^npm_dist_tag=beta$/m);
  assert.match(values, /^github_release_prerelease=true$/m);
  assert.match(values, /^docs_sync_expected=false$/m);
});
