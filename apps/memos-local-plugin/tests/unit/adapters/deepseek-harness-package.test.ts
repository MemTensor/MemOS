import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const { satisfies } = createRequire(import.meta.url)("semver") as {
  satisfies(version: string, range: string): boolean;
};
const hostServices = ["agent", "llm", "session", "system-prompt", "timeout", "tools"];

describe("DeepSeek Harness bundle package", () => {
  it.each(["0.1.0-rc.6", "0.1.7-rc.2", "0.2.0-rc.2", "0.2.1-rc.2", "0.2.1-rc.3"])(
    "admits the supported host %s without a version exemption",
    async (version) => {
      const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
      for (const service of hostServices) {
        const name = `@deepseek-ai/dsh-${service}`;
        expect(satisfies(version, pkg.peerDependencies[name]), name).toBe(true);
        expect(pkg.peerDependenciesMeta[name]?.optional, name).toBe(true);
      }
    },
  );

  it.each(["0.1.0-rc.5", "0.2.2-rc.1", "0.2.2", "0.3.0-rc.1", "0.3.0"])(
    "does not admit the unvalidated host %s",
    async (version) => {
      const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
      for (const service of hostServices) {
        expect(satisfies(version, pkg.peerDependencies[`@deepseek-ai/dsh-${service}`])).toBe(false);
      }
    },
  );

  it("keeps both lockfile importers aligned with the manifest", async () => {
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const npm = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
    const pnpm = parse(await readFile(resolve(root, "pnpm-lock.yaml"), "utf8"));
    for (const group of ["dependencies", "devDependencies", "peerDependencies"]) {
      expect(npm.packages[""][group]).toEqual(pkg[group]);
    }
    for (const group of ["dependencies", "devDependencies"]) {
      for (const [name, version] of Object.entries(pkg[group])) {
        expect(pnpm.importers["."][group][name].specifier, name).toBe(version);
      }
    }
  });

  it("declares a DSH bundle patch and mounts the compiled adapter", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as {
      dsh?: { bundle?: { patch?: string } };
      files?: string[];
    };

    expect(packageJson.dsh?.bundle?.patch).toBe(
      "./adapters/deepseek-harness/cordis.patch.yml",
    );
    expect(packageJson.files).toContain(
      "adapters/deepseek-harness/cordis.patch.yml",
    );

    const patchPath = resolve(root, packageJson.dsh!.bundle!.patch!);
    const rows = parse(await readFile(patchPath, "utf8")) as Array<{
      insert?: Array<{ id?: string; name?: string; config?: Record<string, unknown> }>;
    }>;
    expect(rows).toEqual([
      {
        insert: [
          expect.objectContaining({
            id: "memos-local-memory",
            name: "@memtensor/memos-local-plugin/dist/adapters/deepseek-harness/index.js",
            config: expect.objectContaining({
              enabled: true,
              recallEnabled: true,
              captureEnabled: true,
              toolsEnabled: true,
              hostLlmEnabled: true,
              viewerEnabled: true,
              viewerPort: 18_801,
              recallTimeoutMs: 3_000,
            }),
          }),
        ],
      },
    ]);
  });
});
