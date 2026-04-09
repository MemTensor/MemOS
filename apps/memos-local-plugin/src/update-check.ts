/**
 * Channel-aware update check against npm registry dist-tags.
 * - Prerelease users (e.g. 1.0.2-beta.x) compare against beta tag only (semver gt).
 * - Stable users compare against latest tag only (semver gt).
 * - Beta users get optional stableChannel hint to install @latest when stable exists.
 */
import * as semver from "semver";

export interface UpdateCheckResult {
  updateAvailable: boolean;
  current: string;
  /** Version on the channel we compared against (beta tag or latest tag). */
  latest: string;
  packageName: string;
  /** Channel used for the primary comparison. */
  channel: "beta" | "latest";
  /** Full install command (includes @beta when updating on beta channel). */
  installCommand: string;
  /** When current is prerelease and registry has a stable latest — how to switch to stable. */
  stableChannel?: { version: string; installCommand: string };
}

function isPrerelease(v: string): boolean {
  return semver.prerelease(v) != null;
}

/**
 * Fetch registry package doc and compute update state.
 */
export async function computeUpdateCheck(
  packageName: string,
  current: string,
  fetchImpl: typeof fetch,
  timeoutMs = 8_000,
): Promise<UpdateCheckResult | null> {
  if (!semver.valid(current)) return null;

  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
  const resp = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) return null;

  const data = (await resp.json()) as { "dist-tags"?: Record<string, string> };
  const tags = data["dist-tags"] ?? {};
  const latestTag = tags.latest;
  const betaTag = tags.beta;

  const onBeta = isPrerelease(current);
  let updateAvailable = false;
  let channel: "beta" | "latest" = "latest";
  let targetVersion = current;
  let installCommand = `openclaw plugins install ${packageName}`;

  if (onBeta) {
    channel = "beta";
    if (betaTag && semver.valid(betaTag) && semver.gt(betaTag, current)) {
      updateAvailable = true;
      targetVersion = betaTag;
    } else {
      targetVersion = betaTag && semver.valid(betaTag) ? betaTag : current;
    }
    installCommand = `openclaw plugins install ${packageName}@${targetVersion}`;
  } else {
    if (latestTag && semver.valid(latestTag) && semver.gt(latestTag, current)) {
      updateAvailable = true;
      targetVersion = latestTag;
    } else {
      targetVersion = latestTag && semver.valid(latestTag) ? latestTag : current;
    }
    installCommand = `openclaw plugins install ${packageName}@${targetVersion}`;
  }

  // Beta user + stable exists on latest: optional hint to switch to stable (not counted as "update").
  let stableChannel: UpdateCheckResult["stableChannel"];
  if (onBeta && latestTag && semver.valid(latestTag) && !isPrerelease(latestTag)) {
    stableChannel = {
      version: latestTag,
      installCommand: `openclaw plugins install ${packageName}@latest`,
    };
  }

  return {
    updateAvailable,
    current,
    latest: targetVersion,
    packageName,
    channel,
    installCommand,
    stableChannel,
  };
}
