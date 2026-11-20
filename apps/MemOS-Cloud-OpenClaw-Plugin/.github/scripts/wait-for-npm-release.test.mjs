import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectNpmReleaseVisibility,
  npmPackumentUrl,
  waitForNpmReleaseVisibility,
} from "./wait-for-npm-release.mjs";

const sha = "a317661691bda94054d3d35f8c226e8bfe0018f7";

function response(packument, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return packument;
    },
  };
}

function packument({ version = "0.1.20", gitHead = sha, latest = "0.1.20" } = {}) {
  return {
    "dist-tags": { latest },
    versions: { [version]: { gitHead } },
  };
}

test("builds a cache-busted scoped-package registry URL", () => {
  assert.equal(
    npmPackumentUrl("https://registry.npmjs.org/", "@memtensor/plugin", 123),
    "https://registry.npmjs.org/@memtensor%2Fplugin?cache-bust=123",
  );
});

test("requests the full packument because install-v1 omits gitHead", async () => {
  let requestHeaders;
  const report = await waitForNpmReleaseVisibility(
    {
      packageName: "@memtensor/plugin",
      version: "0.1.20",
      distTag: "latest",
      expectedGitHead: sha,
      timeoutMs: 10_000,
      intervalMs: 1_000,
      requestTimeoutMs: 1_000,
    },
    {
      fetchImpl: async (_url, options) => {
        requestHeaders = options.headers;
        return response(packument());
      },
      log: () => {},
    },
  );
  assert.equal(report.ok, true);
  assert.equal(requestHeaders.accept, "application/json");
});

test("requires version, gitHead, and dist-tag to become visible together", () => {
  assert.match(
    inspectNpmReleaseVisibility({
      packument: { versions: {}, "dist-tags": {} },
      version: "0.1.20",
      distTag: "latest",
      expectedGitHead: sha,
    }).reason,
    /not visible/,
  );
  assert.match(
    inspectNpmReleaseVisibility({
      packument: packument({ gitHead: "" }),
      version: "0.1.20",
      distTag: "latest",
      expectedGitHead: sha,
    }).reason,
    /gitHead is not/,
  );
  assert.match(
    inspectNpmReleaseVisibility({
      packument: packument({ latest: "0.1.19" }),
      version: "0.1.20",
      distTag: "latest",
      expectedGitHead: sha,
    }).reason,
    /latest points to 0\.1\.19/,
  );
  assert.equal(
    inspectNpmReleaseVisibility({
      packument: packument(),
      version: "0.1.20",
      distTag: "latest",
      expectedGitHead: sha,
    }).ok,
    true,
  );
});

test("fails immediately when npm exposes a different immutable gitHead", async () => {
  let sleeps = 0;
  await assert.rejects(
    waitForNpmReleaseVisibility(
      {
        packageName: "@memtensor/plugin",
        version: "0.1.20",
        distTag: "latest",
        expectedGitHead: sha,
        timeoutMs: 150_000,
        intervalMs: 10_000,
        requestTimeoutMs: 1_000,
      },
      {
        fetchImpl: async () => response(packument({ gitHead: "b".repeat(40) })),
        sleep: async () => {
          sleeps += 1;
        },
        log: () => {},
      },
    ),
    /records gitHead .* expected/,
  );
  assert.equal(sleeps, 0);
});

test("waits through delayed version, gitHead, and dist-tag propagation", async () => {
  let clock = 0;
  let attempt = 0;
  const replies = [
    response({}, 404),
    response(packument({ gitHead: "" })),
    response(packument({ latest: "0.1.19" })),
    response(packument()),
  ];
  const report = await waitForNpmReleaseVisibility(
    {
      packageName: "@memtensor/plugin",
      version: "0.1.20",
      distTag: "latest",
      expectedGitHead: sha,
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

test("uses a hard deadline instead of an unbounded retry loop", async () => {
  let clock = 0;
  let attempts = 0;
  await assert.rejects(
    waitForNpmReleaseVisibility(
      {
        packageName: "@memtensor/plugin",
        version: "0.1.20",
        distTag: "latest",
        expectedGitHead: sha,
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
