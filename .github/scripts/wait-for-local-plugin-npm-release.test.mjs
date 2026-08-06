import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectNpmReleaseVisibility,
  npmPackumentUrl,
  tarballIntegrity,
  waitForNpmReleaseVisibility,
} from "./wait-for-local-plugin-npm-release.mjs";

const integrity = `sha512-${createHash("sha512").update("local-plugin-release").digest("base64")}`;

function packument({
  version = "2.0.14",
  releaseIntegrity = integrity,
  distTagVersion = version,
} = {}) {
  return {
    name: "@memtensor/memos-local-plugin",
    versions: {
      [version]: {
        version,
        dist: { integrity: releaseIntegrity },
      },
    },
    "dist-tags": { latest: distTagVersion },
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("builds a cache-busted scoped-package URL", () => {
  assert.equal(
    npmPackumentUrl("https://registry.npmjs.org/", "@memtensor/memos-local-plugin", 42),
    "https://registry.npmjs.org/@memtensor%2Fmemos-local-plugin?cache-bust=42",
  );
});

test("calculates sha512 integrity from the exact tarball bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-plugin-integrity-"));
  const tarball = join(directory, "package.tgz");
  try {
    writeFileSync(tarball, "local-plugin-release");
    assert.equal(tarballIntegrity(tarball), integrity);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires version, integrity, and dist-tag to match together", () => {
  assert.deepEqual(
    inspectNpmReleaseVisibility({
      packument: packument(),
      version: "2.0.14",
      distTag: "latest",
      expectedIntegrity: integrity,
    }),
    {
      ok: true,
      fatal: false,
      reason: "visible",
      version: "2.0.14",
      integrity,
      dist_tag: "latest",
      dist_tag_version: "2.0.14",
    },
  );
});

test("treats delayed version, integrity, and dist-tag metadata as pending", () => {
  const absent = inspectNpmReleaseVisibility({
    packument: {},
    version: "2.0.14",
    distTag: "latest",
    expectedIntegrity: integrity,
  });
  assert.equal(absent.fatal, false);
  assert.match(absent.reason, /not visible/);

  const noIntegrity = inspectNpmReleaseVisibility({
    packument: packument({ releaseIntegrity: "" }),
    version: "2.0.14",
    distTag: "latest",
    expectedIntegrity: integrity,
  });
  assert.equal(noIntegrity.fatal, false);
  assert.match(noIntegrity.reason, /integrity is not/);

  const staleTag = inspectNpmReleaseVisibility({
    packument: packument({ distTagVersion: "2.0.13" }),
    version: "2.0.14",
    distTag: "latest",
    expectedIntegrity: integrity,
  });
  assert.equal(staleTag.fatal, false);
  assert.match(staleTag.reason, /points to 2\.0\.13/);
});

test("fails immediately when immutable integrity belongs to different content", async () => {
  let sleeps = 0;
  await assert.rejects(
    waitForNpmReleaseVisibility(
      {
        packageName: "@memtensor/memos-local-plugin",
        version: "2.0.14",
        distTag: "latest",
        expectedIntegrity: integrity,
        timeoutMs: 150_000,
        intervalMs: 10_000,
        requestTimeoutMs: 1_000,
      },
      {
        fetchImpl: async () => response(packument({ releaseIntegrity: "sha512-ZGlmZmVyZW50" })),
        sleep: async () => {
          sleeps += 1;
        },
        log: () => {},
      },
    ),
    /records integrity .* expected/,
  );
  assert.equal(sleeps, 0);
});

test("fails immediately when the public registry rejects metadata access", async () => {
  let sleeps = 0;
  await assert.rejects(
    waitForNpmReleaseVisibility(
      {
        packageName: "@memtensor/memos-local-plugin",
        version: "2.0.14",
        distTag: "latest",
        expectedIntegrity: integrity,
        timeoutMs: 150_000,
        intervalMs: 10_000,
        requestTimeoutMs: 1_000,
      },
      {
        fetchImpl: async () => response({}, 403),
        sleep: async () => {
          sleeps += 1;
        },
        log: () => {},
      },
    ),
    /registry returned HTTP 403/,
  );
  assert.equal(sleeps, 0);
});

test("waits through registry and dist-tag propagation without republishing", async () => {
  let clock = 0;
  let attempt = 0;
  const replies = [
    response({}, 404),
    response(packument({ releaseIntegrity: "" })),
    response(packument({ distTagVersion: "2.0.13" })),
    response(packument()),
  ];
  const report = await waitForNpmReleaseVisibility(
    {
      packageName: "@memtensor/memos-local-plugin",
      version: "2.0.14",
      distTag: "latest",
      expectedIntegrity: integrity,
      timeoutMs: 150_000,
      intervalMs: 10_000,
      requestTimeoutMs: 1_000,
    },
    {
      fetchImpl: async () => replies[attempt++],
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      now: () => clock,
      log: () => {},
    },
  );
  assert.equal(report.ok, true);
  assert.equal(report.attempts, 4);
  assert.equal(clock, 30_000);
});

test("uses a hard deadline for an unavailable registry version", async () => {
  let clock = 0;
  let attempts = 0;
  await assert.rejects(
    waitForNpmReleaseVisibility(
      {
        packageName: "@memtensor/memos-local-plugin",
        version: "2.0.14",
        distTag: "latest",
        expectedIntegrity: integrity,
        timeoutMs: 30_000,
        intervalMs: 10_000,
        requestTimeoutMs: 1_000,
      },
      {
        fetchImpl: async () => {
          attempts += 1;
          return response({}, 404);
        },
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        now: () => clock,
        log: () => {},
      },
    ),
    /not fully visible within 30s/,
  );
  assert.equal(clock, 30_000);
  assert.equal(attempts, 3);
});
