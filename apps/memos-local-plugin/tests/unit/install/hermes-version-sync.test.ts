import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");
const syncScript = path.join(repoRoot, "scripts", "sync-hermes-version.cjs");
const temporaryRoots: string[] = [];

function createFixture(packageVersion: string, manifestVersion: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "memos-hermes-version-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, "adapters", "hermes"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@memtensor/memos-local-plugin", version: packageVersion }),
    "utf8",
  );
  writeFileSync(
    path.join(root, "adapters", "hermes", "plugin.yaml"),
    `name: memtensor\nversion: ${manifestVersion}\ndescription: test fixture\n`,
    "utf8",
  );
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Hermes version synchronization", () => {
  it("keeps the repository manifest aligned with package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { version: string };
    const manifest = readFileSync(
      path.join(repoRoot, "adapters", "hermes", "plugin.yaml"),
      "utf8",
    );
    const manifestVersion = manifest.match(/^version:\s*(\S+)\s*$/m)?.[1];

    expect(manifestVersion).toBe(packageJson.version);
  });

  it("writes package.json version into the Hermes manifest", () => {
    const root = createFixture("9.8.7-beta.2", "2.0.0-beta.1");

    execFileSync(process.execPath, [syncScript, root]);

    const manifest = readFileSync(
      path.join(root, "adapters", "hermes", "plugin.yaml"),
      "utf8",
    );
    expect(manifest).toContain("version: 9.8.7-beta.2");
    expect(manifest).not.toContain("version: 2.0.0-beta.1");
  });

  it("fails check mode for stale metadata and passes after synchronization", () => {
    const root = createFixture("3.4.5", "3.4.4");

    const staleCheck = spawnSync(process.execPath, [syncScript, "--check", root]);
    expect(staleCheck.status).not.toBe(0);

    execFileSync(process.execPath, [syncScript, root]);

    const synchronizedCheck = spawnSync(process.execPath, [
      syncScript,
      "--check",
      root,
    ]);
    expect(synchronizedCheck.status).toBe(0);
  });

  it("packages the synchronization helper and keeps prepack read-only", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { files: string[]; scripts: Record<string, string> };

    expect(packageJson.files).toContain("scripts/sync-hermes-version.cjs");
    expect(packageJson.scripts["sync:hermes-version"]).toBe(
      "node scripts/sync-hermes-version.cjs",
    );
    expect(packageJson.scripts.prepack).toBe(
      "npm run check:hermes-version && npm run build:package",
    );
  });

  it("synchronizes before release validation and publishes the validated tarball", () => {
    const workflow = readFileSync(
      path.resolve(repoRoot, "../../.github/workflows/memos-local-plugin-publish.yml"),
      "utf8",
    );
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const publishHelper = readFileSync(
      path.resolve(repoRoot, "../../.github/scripts/publish-local-plugin.sh"),
      "utf8",
    );

    const bumpPosition = workflow.indexOf('npm version "${RELEASE_VERSION}"');
    const syncPosition = workflow.indexOf("npm run sync:hermes-version");
    const validationPosition = workflow.indexOf('"npm run release:validate"');

    expect(bumpPosition).toBeGreaterThan(-1);
    expect(syncPosition).toBeGreaterThan(bumpPosition);
    expect(validationPosition).toBeGreaterThan(syncPosition);
    expect(packageJson.scripts["release:validate"]).toBe(
      "npm run check:hermes-version && npm run lint && npm test",
    );
    expect(workflow).toContain("npm pack --json --silent --pack-destination");
    expect(workflow).toContain("raw.match(/^\\[/m)");
    expect(workflow).toContain(
      "fs.writeFileSync(process.argv[1], `${JSON.stringify(report, null, 2)}\\n`)",
    );
    expect(workflow).not.toContain("npm pack --dry-run");
    expect(workflow).toContain(
      "run: bash ../../.github/scripts/publish-local-plugin.sh",
    );
    expect(workflow).toContain(
      "tar -xOf \"${release_tarball}\" package/adapters/hermes/plugin.yaml",
    );
    expect(publishHelper).toContain('npm publish "${RELEASE_TARBALL}"');
    expect(publishHelper).toContain("verify_published_package");
    expect(publishHelper).toContain(
      "tar -xOf \"${verify_tarball}\" package/adapters/hermes/plugin.yaml",
    );
    expect(workflow).toMatch(
      /git add \\\n\s+apps\/memos-local-plugin\/package\.json \\\n\s+apps\/memos-local-plugin\/package-lock\.json \\\n\s+apps\/memos-local-plugin\/adapters\/hermes\/plugin\.yaml/,
    );
  });

  it("keeps the legacy post-merge dry run manual-only", () => {
    const workflow = readFileSync(
      path.resolve(
        repoRoot,
        "../../.github/workflows/memos-local-plugin-post-merge-dry-run.yml",
      ),
      "utf8",
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("push:");
    expect(workflow).not.toContain("memos-local-plugin-publish.yml");
    expect(workflow).toContain("This workflow no longer runs on push to main.");
    expect(workflow).toContain("Use MemOS Release — Post-Merge Dry Run");
  });

  it("runs synchronization in every Hermes installer", () => {
    const unixInstaller = readFileSync(path.join(repoRoot, "install.sh"), "utf8");
    const adapterInstaller = readFileSync(
      path.join(repoRoot, "adapters", "hermes", "install.hermes.sh"),
      "utf8",
    );
    const windowsInstaller = readFileSync(
      path.join(repoRoot, "install.ps1"),
      "utf8",
    );

    expect(unixInstaller).toContain(
      'version_sync="${prefix}/scripts/sync-hermes-version.cjs"',
    );
    expect(unixInstaller).toContain('node "${version_sync}" "${prefix}"');
    expect(adapterInstaller).toContain(
      'VERSION_SYNC_SCRIPT="$PREFIX/scripts/sync-hermes-version.cjs"',
    );
    expect(adapterInstaller).toContain('node "$VERSION_SYNC_SCRIPT" "$PREFIX"');
    expect(windowsInstaller).toContain(
      '$VersionSyncScript = Join-Path $Prefix "scripts\\sync-hermes-version.cjs"',
    );
    expect(windowsInstaller).toContain("& node $VersionSyncScript $Prefix");
  });
});
