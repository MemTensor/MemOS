import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function clean(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function npmPackumentUrl(registryUrl, packageName, cacheBust = Date.now()) {
  const registry = clean(registryUrl || "https://registry.npmjs.org").replace(/\/+$/, "");
  const name = clean(packageName);
  if (!name) {
    throw new Error("NPM_PACKAGE_NAME is required.");
  }
  const encodedName = encodeURIComponent(name).replace(/^%40/i, "@");
  return `${registry}/${encodedName}?cache-bust=${encodeURIComponent(cacheBust)}`;
}

export function inspectNpmReleaseVisibility({
  packument,
  version,
  distTag,
  expectedGitHead,
} = {}) {
  const targetVersion = clean(version);
  const targetDistTag = clean(distTag);
  const expected = clean(expectedGitHead).toLowerCase();
  if (!targetVersion) {
    throw new Error("NPM_RELEASE_VERSION is required.");
  }
  if (!targetDistTag) {
    throw new Error("NPM_DIST_TAG is required.");
  }
  if (!SHA_PATTERN.test(expected)) {
    throw new Error("NPM_EXPECTED_GIT_HEAD must be an exact 40-character commit SHA.");
  }

  const release = packument?.versions?.[targetVersion];
  if (!release) {
    return {
      ok: false,
      fatal: false,
      reason: `version ${targetVersion} is not visible`,
    };
  }

  const actualGitHead = clean(release.gitHead).toLowerCase();
  if (!SHA_PATTERN.test(actualGitHead)) {
    return {
      ok: false,
      fatal: false,
      reason: `version ${targetVersion} is visible but its 40-character gitHead is not`,
    };
  }
  if (actualGitHead !== expected) {
    return {
      ok: false,
      fatal: true,
      reason: `version ${targetVersion} records gitHead ${actualGitHead}, expected ${expected}`,
    };
  }

  const actualDistTagVersion = clean(packument?.["dist-tags"]?.[targetDistTag]);
  if (actualDistTagVersion !== targetVersion) {
    return {
      ok: false,
      fatal: false,
      reason:
        `dist-tag ${targetDistTag} points to ${actualDistTagVersion || "nothing"}, ` +
        `expected ${targetVersion}`,
    };
  }

  return {
    ok: true,
    fatal: false,
    reason: "visible",
    version: targetVersion,
    git_head: actualGitHead,
    dist_tag: targetDistTag,
    dist_tag_version: actualDistTagVersion,
  };
}

function pending(reason) {
  return { ok: false, fatal: false, reason };
}

export async function waitForNpmReleaseVisibility(
  {
    packageName,
    version,
    distTag,
    expectedGitHead,
    registryUrl = "https://registry.npmjs.org",
    timeoutMs = 150_000,
    intervalMs = 10_000,
    requestTimeoutMs = 8_000,
  } = {},
  {
    fetchImpl = globalThis.fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => Date.now(),
    log = (message) => console.log(message),
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }
  const totalTimeoutMs = positiveInteger(timeoutMs, undefined, "timeoutMs");
  const pollIntervalMs = positiveInteger(intervalMs, undefined, "intervalMs");
  const singleRequestTimeoutMs = positiveInteger(
    requestTimeoutMs,
    undefined,
    "requestTimeoutMs",
  );
  // Validate immutable inputs before starting the bounded wait.
  inspectNpmReleaseVisibility({
    packument: {},
    version,
    distTag,
    expectedGitHead,
  });

  const startedAt = now();
  const deadline = startedAt + totalTimeoutMs;
  let attempt = 0;
  let lastReport = pending("registry has not been queried");

  while (now() < deadline) {
    attempt += 1;
    const remainingBeforeRequest = Math.max(1, deadline - now());
    const controller = new AbortController();
    const requestTimer = setTimeout(
      () => controller.abort(),
      Math.min(singleRequestTimeoutMs, remainingBeforeRequest),
    );
    try {
      const response = await fetchImpl(npmPackumentUrl(registryUrl, packageName, now()), {
        headers: {
          // The install-v1 packument intentionally omits gitHead. The release
          // gate needs the full metadata document to verify immutable source.
          accept: "application/json",
          "cache-control": "no-cache, no-store, max-age=0",
          pragma: "no-cache",
        },
        signal: controller.signal,
      });
      if (response.status === 404) {
        lastReport = pending(`registry returned 404 for ${packageName}`);
      } else if (response.status === 401 || response.status === 403) {
        lastReport = {
          ok: false,
          fatal: true,
          reason: `registry returned HTTP ${response.status}`,
        };
      } else if (!response.ok) {
        lastReport = pending(`registry returned HTTP ${response.status}`);
      } else {
        lastReport = inspectNpmReleaseVisibility({
          packument: await response.json(),
          version,
          distTag,
          expectedGitHead,
        });
      }
    } catch (error) {
      const reason = error?.name === "AbortError" ? "registry request timed out" : clean(error?.message || error);
      lastReport = pending(reason || "registry request failed");
    } finally {
      clearTimeout(requestTimer);
    }

    if (lastReport.ok) {
      log(
        `npm release verified after ${attempt} attempt(s): ` +
          `${packageName}@${version}, gitHead=${lastReport.git_head}, ` +
          `${distTag}=${lastReport.dist_tag_version}.`,
      );
      return { ...lastReport, attempts: attempt, elapsed_ms: now() - startedAt };
    }
    if (lastReport.fatal) {
      const error = new Error(`npm release verification failed: ${lastReport.reason}.`);
      error.code = "NPM_METADATA_MISMATCH";
      throw error;
    }

    const remaining = deadline - now();
    log(
      `npm visibility attempt ${attempt} pending: ${lastReport.reason}; ` +
        `${Math.max(0, Math.ceil(remaining / 1000))}s remain.`,
    );
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  throw new Error(
    `npm release was not fully visible within ${Math.ceil(totalTimeoutMs / 1000)}s: ` +
      `${lastReport.reason}.`,
  );
}

export async function run(env = process.env) {
  try {
    const report = await waitForNpmReleaseVisibility({
      packageName: env.NPM_PACKAGE_NAME,
      version: env.NPM_RELEASE_VERSION,
      distTag: env.NPM_DIST_TAG,
      expectedGitHead: env.NPM_EXPECTED_GIT_HEAD,
      registryUrl: env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org",
      timeoutMs: positiveInteger(env.NPM_VISIBILITY_TIMEOUT_SECONDS, 150, "timeout") * 1000,
      intervalMs: positiveInteger(env.NPM_VISIBILITY_INTERVAL_SECONDS, 10, "interval") * 1000,
      requestTimeoutMs:
        positiveInteger(env.NPM_VISIBILITY_REQUEST_TIMEOUT_SECONDS, 8, "request timeout") * 1000,
    });
    console.log(JSON.stringify(report));
    return report;
  } catch (error) {
    console.error(`::error::${clean(error?.message || error)}`);
    process.exitCode = error?.code === "NPM_METADATA_MISMATCH" ? 2 : 1;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
