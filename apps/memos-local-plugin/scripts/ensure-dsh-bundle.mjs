#!/usr/bin/env node
/** Run through `dsh plugin --profile <name> exec node ...` to hold DSH's manifest lock. */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const PACKAGE = "@memtensor/memos-local-plugin";
const PATCH = "./adapters/deepseek-harness/cordis.patch.yml";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object; the profile was not changed.`);
  }
  return value;
}

/** Explicit installation/repair only. Never invoked during adapter startup.
 * @param {string} profileDir The selected DSH profile directory.
 * @returns {{changed:boolean, package:string}}
 */
export function ensureDshBundle(profileDir) {
  const dir = resolve(profileDir);
  const file = join(dir, "package.json");
  if (!lstatSync(file).isFile()) throw new Error("The profile manifest must be a regular file.");
  const raw = readFileSync(file, "utf8");
  const manifest = object(JSON.parse(raw), "Profile manifest");
  const dependencies = object(manifest.dependencies, "Profile dependencies");
  if (!Object.hasOwn(dependencies, PACKAGE) || typeof dependencies[PACKAGE] !== "string") {
    throw new Error(`Install ${PACKAGE} into this profile before registering its bundle.`);
  }

  const pluginDir = join(dir, "node_modules", PACKAGE);
  const installed = object(JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")), "Installed plugin manifest");
  if (installed.name !== PACKAGE || installed.dsh?.bundle?.patch !== PATCH) {
    throw new Error("The installed package is not the MemOS DSH bundle; the profile was not changed.");
  }
  for (const relative of [PATCH, "dist/adapters/deepseek-harness/index.js"]) {
    if (!statSync(join(pluginDir, relative)).isFile()) {
      throw new Error("The installed MemOS bundle is incomplete; the profile was not changed.");
    }
  }

  const dsh = manifest.dsh === undefined ? {} : object(manifest.dsh, "Profile dsh metadata");
  const profile = dsh.profile === undefined ? {} : object(dsh.profile, "Profile bundle metadata");
  const bundles = profile.bundles === undefined ? [] : profile.bundles;
  if (!Array.isArray(bundles) || bundles.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("dsh.profile.bundles must be an array of package names; the profile was not changed.");
  }
  if (bundles.includes(PACKAGE)) return { changed: false, package: PACKAGE };

  manifest.dsh = { ...dsh, profile: { ...profile, bundles: [...bundles, PACKAGE] } };
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const next = JSON.stringify(manifest, null, 2).replace(/\n/g, eol) + eol;
  const temporary = join(dir, `.memos-bundle-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", statSync(file).mode & 0o777);
    try {
      writeFileSync(fd, next, "utf8");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    // The DSH command holds its package.json lock. Also reject a writer that
    // ignored that lock rather than knowingly replacing its changes.
    if (readFileSync(file, "utf8") !== raw) throw new Error("The profile changed during registration; retry through dsh plugin exec.");
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { changed: true, package: PACKAGE };
}

function isMain() {
  if (!process.argv[1]) return false;
  const entry = resolve(process.argv[1]);
  try {
    // pnpm links node_modules packages to its store. argv retains that link,
    // while Node normally resolves import.meta.url to the real script path.
    return import.meta.url === pathToFileURL(entry).href ||
      import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch { return false; }
}

if (isMain()) {
  try {
    const { values } = parseArgs({ options: { "profile-dir": { type: "string" } } });
    console.log(JSON.stringify(ensureDshBundle(values["profile-dir"] ?? process.cwd())));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
