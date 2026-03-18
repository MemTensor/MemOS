#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function log(msg) { console.log(`  ${CYAN}[memos-local]${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠ [memos-local]${RESET} ${msg}`); }
function ok(msg) { console.log(`  ${GREEN}✔ [memos-local]${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}✖ [memos-local]${RESET} ${msg}`); }

function phase(n, title) {
  console.log(`\n${CYAN}${BOLD}  ─── Phase ${n}: ${title} ───${RESET}\n`);
}

const pluginDir = path.resolve(__dirname, "..");

console.log(`
${CYAN}${BOLD}┌──────────────────────────────────────────────────┐
│  MemOS Local Memory — postinstall setup          │
└──────────────────────────────────────────────────┘${RESET}
`);

log(`Plugin dir: ${DIM}${pluginDir}${RESET}`);
log(`Node: ${process.version}  Platform: ${process.platform}-${process.arch}`);

/* ═══════════════════════════════════════════════════════════
 *  Pre-phase: Clean stale build artifacts on upgrade
 *  When openclaw re-installs a new version over an existing
 *  extensions dir, old dist/node_modules can conflict.
 *  We nuke them so npm install gets a clean slate, but
 *  preserve user data (.env, data/).
 * ═══════════════════════════════════════════════════════════ */

function cleanStaleArtifacts() {
  const isExtensionsDir = pluginDir.includes(path.join(".openclaw", "extensions"));
  if (!isExtensionsDir) return;

  const pkgPath = path.join(pluginDir, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  let installedVer = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    installedVer = pkg.version || "unknown";
  } catch { /* ignore */ }

  const markerPath = path.join(pluginDir, ".installed-version");
  let prevVer = "";
  try { prevVer = fs.readFileSync(markerPath, "utf-8").trim(); } catch { /* first install */ }

  if (prevVer === installedVer) {
    log(`Version unchanged (${installedVer}), skipping artifact cleanup.`);
    return;
  }

  if (prevVer) {
    log(`Upgrade detected: ${DIM}${prevVer}${RESET} → ${GREEN}${installedVer}${RESET}`);
  } else {
    log(`Fresh install: ${GREEN}${installedVer}${RESET}`);
  }

  const dirsToClean = ["dist", "node_modules"];
  let cleaned = 0;
  for (const dir of dirsToClean) {
    const full = path.join(pluginDir, dir);
    if (fs.existsSync(full)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        ok(`Cleaned stale ${dir}/`);
        cleaned++;
      } catch (e) {
        warn(`Could not remove ${dir}/: ${e.message}`);
      }
    }
  }

  const filesToClean = ["package-lock.json"];
  for (const f of filesToClean) {
    const full = path.join(pluginDir, f);
    if (fs.existsSync(full)) {
      try { fs.unlinkSync(full); ok(`Removed stale ${f}`); cleaned++; } catch { /* ignore */ }
    }
  }

  try { fs.writeFileSync(markerPath, installedVer + "\n", "utf-8"); } catch { /* ignore */ }

  if (cleaned > 0) {
    ok(`Cleaned ${cleaned} stale artifact(s). Fresh install will follow.`);
  }
}

try {
  cleanStaleArtifacts();
} catch (e) {
  warn(`Artifact cleanup error: ${e.message}`);
}

/* ═══════════════════════════════════════════════════════════
 *  Phase 0: Ensure all dependencies are installed
 * ═══════════════════════════════════════════════════════════ */

function ensureDependencies() {
  phase(0, "检测核心依赖 / Check core dependencies");

  const coreDeps = ["@sinclair/typebox", "uuid", "posthog-node", "@huggingface/transformers"];
  const missing = [];
  for (const dep of coreDeps) {
    try {
      require.resolve(dep, { paths: [pluginDir] });
      log(`  ${dep} ${GREEN}✔${RESET}`);
    } catch {
      missing.push(dep);
      log(`  ${dep} ${RED}✖ missing${RESET}`);
    }
  }

  if (missing.length === 0) {
    ok("All core dependencies present.");
    return;
  }

  warn(`Missing ${missing.length} dependencies: ${BOLD}${missing.join(", ")}${RESET}`);
  log("Running: npm install --omit=dev ...");

  const startMs = Date.now();
  const result = spawnSync("npm", ["install", "--omit=dev"], {
    cwd: pluginDir,
    stdio: "pipe",
    shell: true,
    timeout: 120_000,
  });
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const stderr = (result.stderr || "").toString().trim();

  if (result.status === 0) {
    ok(`Dependencies installed successfully (${elapsed}s).`);
  } else {
    fail(`npm install exited with code ${result.status} (${elapsed}s).`);
    if (stderr) warn(`stderr: ${stderr.slice(0, 300)}`);
    warn("Some features may not work. Try running manually:");
    warn(`  cd ${pluginDir} && npm install --omit=dev`);
  }
}

try {
  ensureDependencies();
} catch (e) {
  warn(`Dependency check error: ${e.message}`);
}

/* ═══════════════════════════════════════════════════════════
 *  Phase 1: Clean up legacy plugin versions
 * ═══════════════════════════════════════════════════════════ */

function cleanupLegacy() {
  phase(1, "清理旧版本插件 / Clean up legacy plugins");

  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) { log("Cannot determine HOME directory, skipping."); return; }
  const ocHome = path.join(home, ".openclaw");
  if (!fs.existsSync(ocHome)) { log("No ~/.openclaw directory found, skipping."); return; }

  const extDir = path.join(ocHome, "extensions");
  if (!fs.existsSync(extDir)) { log("No extensions directory found, skipping."); return; }

  const legacyDirs = [
    path.join(extDir, "memos-local"),
    path.join(extDir, "memos-lite"),
    path.join(extDir, "memos-lite-openclaw-plugin"),
    path.join(extDir, "node_modules", "@memtensor", "memos-lite-openclaw-plugin"),
  ];

  let cleaned = 0;
  for (const dir of legacyDirs) {
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        ok(`Removed legacy dir: ${DIM}${dir}${RESET}`);
        cleaned++;
      } catch (e) {
        warn(`Could not remove ${dir}: ${e.message}`);
      }
    }
  }

  const cfgPath = path.join(ocHome, "openclaw.json");
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = fs.readFileSync(cfgPath, "utf-8");
      const cfg = JSON.parse(raw);
      const entries = cfg?.plugins?.entries;
      if (entries) {
        const oldKeys = ["memos-local", "memos-lite", "memos-lite-openclaw-plugin"];
        let cfgChanged = false;

        for (const oldKey of oldKeys) {
          if (entries[oldKey]) {
            const oldEntry = entries[oldKey];
            if (!entries["memos-local-openclaw-plugin"]) {
              entries["memos-local-openclaw-plugin"] = oldEntry;
              log(`Migrated config: ${DIM}${oldKey}${RESET} → ${GREEN}memos-local-openclaw-plugin${RESET}`);
            }
            delete entries[oldKey];
            cfgChanged = true;
            ok(`Removed legacy config key: ${DIM}${oldKey}${RESET}`);
          }
        }

        const newEntry = entries["memos-local-openclaw-plugin"];
        if (newEntry && typeof newEntry.source === "string") {
          const oldSource = newEntry.source;
          if (oldSource.includes("memos-lite") || (oldSource.includes("memos-local") && !oldSource.includes("memos-local-openclaw-plugin"))) {
            newEntry.source = oldSource
              .replace(/memos-lite-openclaw-plugin/g, "memos-local-openclaw-plugin")
              .replace(/memos-lite/g, "memos-local-openclaw-plugin")
              .replace(/\/memos-local\//g, "/memos-local-openclaw-plugin/")
              .replace(/\/memos-local$/g, "/memos-local-openclaw-plugin");
            if (newEntry.source !== oldSource) {
              log(`Updated source path: ${DIM}${oldSource}${RESET} → ${GREEN}${newEntry.source}${RESET}`);
              cfgChanged = true;
            }
          }
        }

        const slots = cfg?.plugins?.slots;
        if (slots && typeof slots.memory === "string") {
          const oldSlotNames = ["memos-local", "memos-lite", "memos-lite-openclaw-plugin"];
          if (oldSlotNames.includes(slots.memory)) {
            log(`Migrated plugins.slots.memory: ${DIM}${slots.memory}${RESET} → ${GREEN}memos-local-openclaw-plugin${RESET}`);
            slots.memory = "memos-local-openclaw-plugin";
            cfgChanged = true;
          }
        }

        if (cfgChanged) {
          const backup = cfgPath + ".bak-" + Date.now();
          fs.copyFileSync(cfgPath, backup);
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
          ok(`Config updated. Backup: ${DIM}${backup}${RESET}`);
        } else {
          log("No legacy config entries found.");
        }
      }
    } catch (e) {
      warn(`Could not update openclaw.json: ${e.message}`);
    }
  }

  if (cleaned > 0) {
    ok(`Legacy cleanup done: ${cleaned} old dir(s) removed.`);
  } else {
    ok("No legacy plugin directories found. Clean.");
  }
}

try {
  cleanupLegacy();
} catch (e) {
  warn(`Legacy cleanup error: ${e.message}`);
}

/* ═══════════════════════════════════════════════════════════
 *  Phase 2: Install bundled skill (memos-memory-guide)
 * ═══════════════════════════════════════════════════════════ */

function installBundledSkill() {
  phase(2, "安装记忆技能 / Install memory skill");

  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) { warn("Cannot determine HOME directory, skipping skill install."); return; }

  const skillSrc = path.join(pluginDir, "skill", "memos-memory-guide", "SKILL.md");
  if (!fs.existsSync(skillSrc)) {
    warn("Bundled SKILL.md not found, skipping skill install.");
    return;
  }

  let pluginVersion = "0.0.0";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf-8"));
    pluginVersion = pkg.version || pluginVersion;
  } catch { /* ignore */ }

  const skillContent = fs.readFileSync(skillSrc, "utf-8");
  const targets = [
    path.join(home, ".openclaw", "workspace", "skills", "memos-memory-guide"),
    path.join(home, ".openclaw", "skills", "memos-memory-guide"),
  ];

  const meta = JSON.stringify({ ownerId: "memos-local-openclaw-plugin", slug: "memos-memory-guide", version: pluginVersion, publishedAt: Date.now() });
  const origin = JSON.stringify({ version: 1, registry: "memos-local-openclaw-plugin", slug: "memos-memory-guide", installedVersion: pluginVersion, installedAt: Date.now() });

  for (const dest of targets) {
    try {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "SKILL.md"), skillContent, "utf-8");
      fs.writeFileSync(path.join(dest, "_meta.json"), meta, "utf-8");
      const clawHubDir = path.join(dest, ".clawhub");
      fs.mkdirSync(clawHubDir, { recursive: true });
      fs.writeFileSync(path.join(clawHubDir, "origin.json"), origin, "utf-8");
      ok(`Skill installed → ${DIM}${dest}${RESET}`);
    } catch (e) {
      warn(`Could not install skill to ${dest}: ${e.message}`);
    }
  }

  // Register in skills-lock.json so OpenClaw Dashboard can discover it
  const lockPath = path.join(home, ".openclaw", "workspace", "skills-lock.json");
  try {
    let lockData = { version: 1, skills: {} };
    if (fs.existsSync(lockPath)) {
      lockData = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    }
    if (!lockData.skills) lockData.skills = {};
    lockData.skills["memos-memory-guide"] = { source: "memos-local-openclaw-plugin", sourceType: "plugin", computedHash: "" };
    fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2) + "\n", "utf-8");
    ok("Registered in skills-lock.json");
  } catch (e) {
    warn(`Could not update skills-lock.json: ${e.message}`);
  }
}

try {
  installBundledSkill();
} catch (e) {
  warn(`Skill install error: ${e.message}`);
}

/* ═══════════════════════════════════════════════════════════
 *  Phase 3: Verify better-sqlite3 native module
 * ═══════════════════════════════════════════════════════════ */

phase(3, "检查 better-sqlite3 原生模块 / Check native module");

const sqliteModulePath = path.join(pluginDir, "node_modules", "better-sqlite3");

function findSqliteBinding() {
  const candidates = [
    path.join(sqliteModulePath, "build", "Release", "better_sqlite3.node"),
    path.join(sqliteModulePath, "build", "better_sqlite3.node"),
    path.join(sqliteModulePath, "build", "Debug", "better_sqlite3.node"),
  ];

  const prebuildDir = path.join(sqliteModulePath, "prebuilds");
  if (fs.existsSync(prebuildDir)) {
    try {
      const platformDir = `${process.platform}-${process.arch}`;
      const pbDir = path.join(prebuildDir, platformDir);
      if (fs.existsSync(pbDir)) {
        const files = fs.readdirSync(pbDir).filter(f => f.endsWith(".node"));
        for (const f of files) candidates.push(path.join(pbDir, f));
      }
    } catch { /* ignore */ }
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function sqliteBindingsExist() {
  const found = findSqliteBinding();
  if (found) {
    log(`Native binding found: ${DIM}${found}${RESET}`);
    return true;
  }
  return false;
}

if (sqliteBindingsExist()) {
  ok("better-sqlite3 is ready.");
  console.log(`
${GREEN}${BOLD}  ┌──────────────────────────────────────────────────┐
  │  ✔ Setup complete!                                │
  │                                                    │
  │  Restart gateway:                                  │
  │  ${CYAN}openclaw gateway stop && openclaw gateway start${GREEN}  │
  └──────────────────────────────────────────────────┘${RESET}
`);
  process.exit(0);
} else {
  warn("better-sqlite3 native bindings not found in plugin dir.");
  log(`Searched in: ${DIM}${sqliteModulePath}/build/${RESET}`);
  log("Running: npm rebuild better-sqlite3 (may take 30-60s)...");
}

const startMs = Date.now();

const result = spawnSync("npm", ["rebuild", "better-sqlite3"], {
  cwd: pluginDir,
  stdio: "pipe",
  shell: true,
  timeout: 180_000,
});

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
const stdout = (result.stdout || "").toString().trim();
const stderr = (result.stderr || "").toString().trim();

if (stdout) log(`rebuild output: ${DIM}${stdout.slice(0, 500)}${RESET}`);
if (stderr) warn(`rebuild stderr: ${DIM}${stderr.slice(0, 500)}${RESET}`);

if (result.status === 0) {
  if (sqliteBindingsExist()) {
    ok(`better-sqlite3 rebuilt successfully (${elapsed}s).`);
    console.log(`
${GREEN}${BOLD}  ┌──────────────────────────────────────────────────┐
  │  ✔ Setup complete!                                │
  │                                                    │
  │  Restart gateway:                                  │
  │  ${CYAN}openclaw gateway stop && openclaw gateway start${GREEN}  │
  └──────────────────────────────────────────────────┘${RESET}
`);
    process.exit(0);
  } else {
    fail(`Rebuild completed but bindings still missing (${elapsed}s).`);
    fail(`Looked in: ${sqliteModulePath}/build/`);
  }
} else {
  fail(`Rebuild failed with exit code ${result.status} (${elapsed}s).`);
}

console.log(`
${YELLOW}${BOLD}  ╔══════════════════════════════════════════════════════════════╗
  ║  ✖ better-sqlite3 native module build failed               ║
  ╠══════════════════════════════════════════════════════════════╣${RESET}
${YELLOW}  ║${RESET}                                                             ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  This plugin requires C/C++ build tools to compile         ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  the SQLite native module on first install.                ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                             ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${BOLD}Install build tools:${RESET}                                      ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                             ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${CYAN}macOS:${RESET}   xcode-select --install                          ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${CYAN}Ubuntu:${RESET}  sudo apt install build-essential python3        ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${CYAN}Windows:${RESET} npm install -g windows-build-tools              ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                             ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${BOLD}Then retry:${RESET}                                                ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${GREEN}cd ${pluginDir}${RESET}
${YELLOW}  ║${RESET}  ${GREEN}npm rebuild better-sqlite3${RESET}                                ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${GREEN}openclaw gateway stop && openclaw gateway start${RESET}           ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                             ${YELLOW}║${RESET}
${YELLOW}${BOLD}  ╚══════════════════════════════════════════════════════════════╝${RESET}
`);

process.exit(0);
