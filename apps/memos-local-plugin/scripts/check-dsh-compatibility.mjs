import { cp, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Install each real host API in isolation; never rewrite the checkout's dependencies
// or use a customer's DSH profile, credentials, or session data.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const versions = process.argv.slice(2);
if (!versions.length) versions.push(
  "0.1.0-rc.6", "0.1.7-rc.2",
  "0.2.0-rc.2", "0.2.1-rc.2", "0.2.1-rc.3",
);
if (versions.some((version) => !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version))) {
  throw new Error("Expected explicit DSH versions, e.g. 0.2.1-rc.3");
}
const matrix = await mkdtemp(join(tmpdir(), "memos-dsh-matrix-"));
console.log(`DSH compatibility fixtures: ${matrix}`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status} in ${cwd}`);
}

for (const version of versions) {
  const fixture = join(matrix, version);
  await mkdir(fixture);
  const devDependencies = Object.fromEntries(
    Object.entries(manifest.devDependencies)
      .filter(([name]) => name.startsWith("@deepseek-ai/"))
      .map(([name, value]) => [name,
        name.startsWith("@deepseek-ai/dsh-") && name !== "@deepseek-ai/dsh-session-format-v3-to-v4"
          ? version : value]),
  );
  // Early DSH previews used caret peers. Letting npm choose their latest
  // prerelease mixes rc.6 and rc.8, so pin the entire host peer closure.
  const inspected = new Set();
  let pending = Object.keys(devDependencies).filter((name) => name.startsWith("@deepseek-ai/dsh-")
    && name !== "@deepseek-ai/dsh-session-format-v3-to-v4");
  while (pending.length) {
    const metadata = await Promise.all(pending.map(async (name) => {
      inspected.add(name);
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
      if (!response.ok) throw new Error(`Cannot resolve ${name}@${version}: ${response.status}`);
      return response.json();
    }));
    const next = new Set();
    for (const pkg of metadata) {
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
        if (!name.startsWith("@deepseek-ai/dsh-") || name === "@deepseek-ai/dsh-session-format-v3-to-v4") continue;
        devDependencies[name] = version;
        if (!inspected.has(name)) next.add(name);
      }
    }
    pending = [...next];
  }
  await writeFile(join(fixture, "package.json"), JSON.stringify({
    name: "memos-dsh-compatibility-fixture", private: true, type: "module", devDependencies,
  }, null, 2));
  const installArgs = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, ...installArgs], fixture);
  } else {
    run("npm", installArgs, fixture);
  }

  // Reuse the installed non-host test/build tools and native bindings. DSH and
  // all its transitive peers above remain local to the fixture.
  for (const entry of await readdir(join(root, "node_modules"), { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
    const source = join(root, "node_modules", entry.name);
    const target = join(fixture, "node_modules", entry.name);
    if (entry.name.startsWith("@")) {
      await mkdir(target, { recursive: true });
      for (const child of await readdir(source)) {
        if (entry.name === "@deepseek-ai" && (child.startsWith("dsh-") || child === "cordis")) continue;
        try { await symlink(join(source, child), join(target, child), "junction"); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
    } else {
      try { await symlink(source, target, "junction"); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  }
  for (const path of [
    "adapters", "agent-contract", "bridge", "core", "server", "tests", "scripts",
    "bridge.cts", "bridge.mts", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts",
  ]) await cp(join(root, path), join(fixture, path), { recursive: true });

  console.log(`\n=== DSH ${version}: compile, build, and adapter contracts ===`);
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"], fixture);
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], fixture);
  const tests = (await readdir(join(fixture, "tests/unit/adapters")))
    .filter((name) => name.startsWith("deepseek-harness-") && name.endsWith(".test.ts") && name !== "deepseek-harness-package.test.ts")
    .map((name) => `tests/unit/adapters/${name}`);
  run(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...tests], fixture);
  console.log(`PASS DSH ${version}`);
}
console.log(`PASS all ${versions.length} DSH versions. Fixtures retained at ${matrix}`);
