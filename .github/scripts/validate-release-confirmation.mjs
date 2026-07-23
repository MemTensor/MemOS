#!/usr/bin/env node

export function expectedReleaseConfirmation(version) {
  const cleanVersion = String(version || "").trim().replace(/^[vV]/, "");
  return `PUBLISH v${cleanVersion}`;
}

export function validateReleaseConfirmation({ version, dryRun, confirmation }) {
  const isDryRun = String(dryRun ?? "true").trim().toLowerCase() === "true";
  const expected = expectedReleaseConfirmation(version);

  if (isDryRun) {
    return {
      ok: true,
      expected,
      reason: "dry_run=true; publish confirmation is not required.",
    };
  }

  if (String(confirmation || "").trim() === expected) {
    return {
      ok: true,
      expected,
      reason: "publish confirmation accepted.",
    };
  }

  return {
    ok: false,
    expected,
    reason:
      "dry_run=false would publish externally and create release metadata; " +
      `publish_confirmation must exactly equal '${expected}'.`,
  };
}

export function main(env = process.env) {
  const result = validateReleaseConfirmation({
    version: env.RELEASE_VERSION,
    dryRun: env.DRY_RUN,
    confirmation: env.PUBLISH_CONFIRMATION,
  });

  if (!result.ok) {
    throw new Error(result.reason);
  }

  console.log(result.reason);
  if (result.expected) {
    console.log(`Expected confirmation: ${result.expected}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}
