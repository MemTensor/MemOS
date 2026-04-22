#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { validateNativeBinding } = require("./native-binding.cjs");

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
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function normalizePathForMatch(p) {
  return path.resolve(p).replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
}

const nodeVersion = process.version;
const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);

console.log(`
${CYAN}${BOLD}┌──────────────────────────────────────────────────┐
│  MemOS Local Memory — postinstall setup          │
└──────────────────────────────────────────────────┘${RESET}
`);

log(`Plugin dir: ${DIM}${pluginDir}${RESET}`);
log(`Node: ${GREEN}${nodeVersion}${RESET}  Platform: ${process.platform}-${process.arch}`);

if (nodeMajor >= 25) {
  warn(`Node.js ${nodeVersion} detected. This version may have compatibility issues with native modules.`);
  log(`Recommended: Use Node.js LTS (v20 or v22) for best compatibility.`);
  log(`You can use nvm to switch versions: ${CYAN}nvm use 22${RESET}`);
}

/* ═══════════════════════════════════════════════════════════
 *  Pre-phase: Clean stale build artifacts on upgrade
 *  When openclaw re-installs a new version over an existing
 *  extensions dir, old dist/node_modules can conflict.
 *  We nuke them so npm install gets a clean slate, but
 *  preserve user data (.env, data/).
 * ═══════════════════════════════════════════════════════════ */

function cleanStaleArtifacts() {
  const pluginDirNorm = normalizePathForMatch(pluginDir);
  const isExtensionsDir = pluginDirNorm.includes("/.openclaw/extensions/");
  if (!isExtensionsDir) return;

  const pkgPath = path.join(pluginDir, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  let installedVer = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    installedVer = pkg.version || "unknown";
  } catch { /* ignore */ }

  const nodeMajor = process.versions.node.split(".")[0];
  const currentFingerprint = `${installedVer}+node${nodeMajor}`;

  const markerPath = path.join(pluginDir, ".installed-version");
  let prevFingerprint = "";
  try { prevFingerprint = fs.readFileSync(markerPath, "utf-8").trim(); } catch { /* first install */ }

  const writeMarker = () => {
    try { fs.writeFileSync(markerPath, currentFingerprint + "\n", "utf-8"); } catch { /* ignore */ }
  };

  if (prevFingerprint === currentFingerprint) {
    log(`Version unchanged (${currentFingerprint}), skipping artifact cleanup.`);
    return;
  }

  if (!prevFingerprint) {
    log(`Fresh install: ${GREEN}${currentFingerprint}${RESET}`);
    writeMarker();
    return;
  }

  log(`Environment changed: ${DIM}${prevFingerprint}${RESET} → ${GREEN}${currentFingerprint}${RESET}`);

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

  writeMarker();

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
  phase(0, "Check core dependencies / 检测核心依赖");

  const coreDeps = ["@sinclair/typebox", "uuid", "@huggingface/transformers"];
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
  const result = spawnSync(npmCmd, ["install", "--omit=dev"], {
    cwd: pluginDir,
    stdio: "pipe",
    shell: false,
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
  phase(1, "Clean up legacy plugins / 清理旧版本插件");

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
              .replace(/[\\/]memos-local[\\/]/g, `${path.sep}memos-local-openclaw-plugin${path.sep}`)
              .replace(/[\\/]memos-local$/g, `${path.sep}memos-local-openclaw-plugin`);
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
  phase(2, "Install memory skill / 安装记忆技能");

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

phase(3, "Check native module / 检查 better-sqlite3 原生模块");

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
  if (!found) return false;
  log(`Native binding found: ${DIM}${found}${RESET}`);
  const status = validateNativeBinding(found);
  if (status.ok) return true;
  if (status.reason === "node-module-version") {
    warn("Native binding exists but was compiled for a different Node.js version.");
  } else {
    warn("Native binding exists but failed to load.");
  }
  warn(`${DIM}${status.message}${RESET}`);
  return false;
}

if (sqliteBindingsExist()) {
  ok("better-sqlite3 is ready.");
} else {
  warn("better-sqlite3 native bindings are missing or not loadable.");
  log(`Searched in: ${DIM}${sqliteModulePath}/build/${RESET}`);
  log("Running: npm rebuild better-sqlite3 (may take 30-60s)...");

  const startMs = Date.now();
  const result = spawnSync(npmCmd, ["rebuild", "better-sqlite3"], {
    cwd: pluginDir,
    stdio: "pipe",
    shell: false,
    timeout: 180_000,
  });
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const stdout = (result.stdout || "").toString().trim();
  const stderr = (result.stderr || "").toString().trim();
  if (stdout) log(`rebuild output: ${DIM}${stdout.slice(0, 500)}${RESET}`);
  if (stderr) warn(`rebuild stderr: ${DIM}${stderr.slice(0, 500)}${RESET}`);

  if (result.status === 0 && sqliteBindingsExist()) {
    ok(`better-sqlite3 rebuilt successfully (${elapsed}s).`);
  } else {
    if (result.status !== 0) fail(`Rebuild failed with exit code ${result.status} (${elapsed}s).`);
    else { fail(`Rebuild completed but bindings still missing (${elapsed}s).`); fail(`Looked in: ${sqliteModulePath}/build/`); }
    console.log(`
${YELLOW}${BOLD}  ╔══════════════════════════════════════════════════════════════╗
  ║  ✖ better-sqlite3 native module build failed                 ║
  ╠══════════════════════════════════════════════════════════════╣${RESET}
${YELLOW}  ║${RESET}                                                              ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  This plugin requires C/C++ build tools to compile           ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  the SQLite native module on first install.                  ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                              ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${BOLD}Install build tools:${RESET}                                       ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                              ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${CYAN}macOS:${RESET}   xcode-select --install                           ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${CYAN}Ubuntu:${RESET}  sudo apt install build-essential python3         ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${CYAN}Windows:${RESET} npm install -g windows-build-tools               ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                              ${YELLOW}║${RESET}`);

if (nodeMajor >= 25) {
  console.log(`${YELLOW}  ║${RESET}  ${BOLD}${RED}Node.js v25+ compatibility issue detected:${RESET}                ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                              ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  better-sqlite3 may not have prebuilt binaries for Node 25.   ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${BOLD}Recommended solutions:${RESET}                                     ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                              ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  1. Use Node.js LTS (v20 or v22):                             ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}     ${GREEN}nvm install 22 && nvm use 22${RESET}                            ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                              ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  2. Or use MemOS Cloud version instead:                       ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}     ${CYAN}https://github.com/MemTensor/MemOS/tree/main/apps/memos-cloud${RESET}
${YELLOW}  ║${RESET}                                                              ${YELLOW}║${RESET}`);
}

console.log(`${YELLOW}  ║${RESET}                                                              ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${BOLD}Then retry:${RESET}                                                 ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${GREEN}cd ${pluginDir}${RESET}
${YELLOW}  ║${RESET}  ${GREEN}npm rebuild better-sqlite3${RESET}                                 ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}  ${GREEN}openclaw gateway stop && openclaw gateway start${RESET}            ${YELLOW}║${RESET}
${YELLOW}  ║${RESET}                                                              ${YELLOW}║${RESET}
${YELLOW}${BOLD}  ╚══════════════════════════════════════════════════════════════╝${RESET}
`);
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Phase 3: Interactive LAN Sharing Setup
 * ═══════════════════════════════════════════════════════════ */

const rlMod = require("readline");
const os = require("os");
const crypto = require("crypto");

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        results.push({ name, address: net.address });
      }
    }
  }
  return results;
}

function generateTeamToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function createPrompt() {
  const rl = rlMod.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(q) { return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim()))); },
    close() { rl.close(); },
  };
}

async function setupSharingWizard() {
  if (!process.stdin.isTTY) {
    log("Non-interactive environment, skipping sharing setup wizard.");
    return;
  }
  if (process.env.MEMOS_SKIP_SETUP === "1") {
    log("MEMOS_SKIP_SETUP=1, skipping sharing setup.");
    return;
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cfgPath = path.join(home, ".openclaw", "openclaw.json");
  if (!fs.existsSync(cfgPath)) {
    log("~/.openclaw/openclaw.json not found, skipping sharing setup.");
    return;
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch (e) {
    warn(`Cannot parse openclaw.json: ${e.message}`);
    return;
  }

  const pluginEntry = cfg?.plugins?.entries?.["memos-local-openclaw-plugin"];
  const existingSharing = pluginEntry?.config?.sharing;

  if (existingSharing?.enabled) {
    const roleLabel = existingSharing.role === "hub" ? "Hub (Team Center)" : "Client (Team Member)";
    log(`Sharing config detected: role = ${BOLD}${roleLabel}${RESET}`);
    const prompt = createPrompt();
    const ans = await prompt.ask(`  Reconfigure? / 是否重新配置？(y/N) > `);
    prompt.close();
    if (ans.toLowerCase() !== "y") {
      ok("Keeping existing sharing config. / 保留现有共享配置。");
      return;
    }
  }

  phase(3, "LAN Sharing Setup / 局域网共享设置");

  const prompt = createPrompt();

  const enableAns = await prompt.ask(`  Enable LAN sharing? / 是否启用局域网记忆共享？(y/N) > `);
  if (enableAns.toLowerCase() !== "y") {
    prompt.close();
    log("Sharing not enabled. You can configure it later in openclaw.json. / 未启用共享。");
    return;
  }

  console.log(`
  ${BOLD}Choose your role / 请选择你的角色:${RESET}
    ${GREEN}1)${RESET} Create Team (Hub)   — become the team admin, others connect to you / 创建团队
    ${GREEN}2)${RESET} Join Team (Client)  — connect to an existing Hub / 加入团队
`);

  const roleAns = await prompt.ask(`  Enter 1 or 2 / 请输入 1 或 2 > `);

  let sharingConfig;

  if (roleAns === "1") {
    console.log(`\n  ${CYAN}${BOLD}── Hub Setup / Hub 设置 ──${RESET}\n`);

    const teamName = (await prompt.ask(`  Team name / 团队名称 (default: My Team) > `)) || "My Team";
    const portStr = (await prompt.ask(`  Hub port / Hub 端口 (default: 18800) > `)) || "18800";
    const port = parseInt(portStr, 10) || 18800;
    const teamToken = generateTeamToken();

    sharingConfig = {
      enabled: true,
      role: "hub",
      hub: { port, teamName, teamToken },
    };

    const localIPs = getLocalIPs();
    const displayIP = localIPs.length > 0 ? localIPs[0].address : "<your-ip>";

    console.log(`
${GREEN}${BOLD}  ┌────────────────────────────────────────────────────────────┐
  │  ✔ Hub configured! / Hub 配置完成！                       │
  │                                                            │
  │  Share this info with your team:                           │
  │  请将以下信息分享给团队成员:                                │
  │                                                            │
  │  ${CYAN}Address / Hub 地址 : ${displayIP}:${port}${GREEN}
  │  ${CYAN}Team Token         : ${teamToken}${GREEN}
  │                                                            │
  │  Team members should choose "Join Team" during install.    │
  └────────────────────────────────────────────────────────────┘${RESET}
`);

    if (localIPs.length > 1) {
      log("Multiple network interfaces detected / 检测到多个网络接口:");
      for (const ip of localIPs) {
        log(`  ${ip.name}: ${BOLD}${ip.address}:${port}${RESET}`);
      }
    }

  } else if (roleAns === "2") {
    console.log(`\n  ${CYAN}${BOLD}── Join Team / 加入团队 ──${RESET}\n`);

    const hubAddress = await prompt.ask(`  Hub address / Hub 地址 (e.g. 192.168.1.100:18800) > `);
    if (!hubAddress) {
      prompt.close();
      warn("Hub address cannot be empty, skipping. / Hub 地址不能为空。");
      return;
    }

    const teamToken = await prompt.ask(`  Team Token (from Hub creator / 由 Hub 创建者提供) > `);
    if (!teamToken) {
      prompt.close();
      warn("Team Token cannot be empty, skipping. / Team Token 不能为空。");
      return;
    }

    const username = (await prompt.ask(`  Your username / 你的用户名 (default: ${os.userInfo().username}) > `)) || os.userInfo().username;

    const hubUrl = /^https?:\/\//i.test(hubAddress.trim()) ? hubAddress.trim() : `http://${hubAddress.trim()}`;
    log(`Joining team at / 正在加入团队: ${BOLD}${hubUrl}${RESET} ...`);

    let userToken = "";
    let joinOk = false;

    try {
      const http = require("http");
      const https = require("https");
      const joinResult = await new Promise((resolve, reject) => {
        const postData = JSON.stringify({ teamToken, username, deviceName: os.hostname() });
        const url = new URL(`${hubUrl}/api/v1/hub/join`);
        const mod = url.protocol === "https:" ? https : http;
        const reqObj = mod.request({
          hostname: url.hostname, port: url.port, path: url.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
          timeout: 8000,
        }, (resp) => {
          let data = "";
          resp.on("data", (c) => { data += c; });
          resp.on("end", () => {
            try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
            catch { resolve({ status: resp.statusCode, body: data }); }
          });
        });
        reqObj.on("error", reject);
        reqObj.on("timeout", () => { reqObj.destroy(); reject(new Error("timeout")); });
        reqObj.write(postData);
        reqObj.end();
      });

      if (joinResult.status === 200 && joinResult.body.userToken) {
        userToken = joinResult.body.userToken;
        joinOk = true;
        ok(`Joined successfully! / 加入成功！User: ${BOLD}${username}${RESET}`);
      } else if (joinResult.status === 403) {
        prompt.close();
        fail("Invalid Team Token / Team Token 无效");
        return;
      } else {
        warn(`Hub responded / Hub 返回: ${joinResult.status} ${JSON.stringify(joinResult.body)}`);
        log("Config will be saved; gateway will auto-retry joining with Team Token on startup. / 配置将被保存，gateway 启动时会自动重试。");
      }
    } catch (e) {
      warn(`Cannot reach Hub / 无法连接 Hub: ${e.message}`);
      log("Config will be saved; gateway will auto-retry joining on startup. / 配置将被保存，gateway 启动时会自动重试。");
    }

    sharingConfig = {
      enabled: true,
      role: "client",
      client: { hubAddress, teamToken },
    };
    if (userToken) sharingConfig.client.userToken = userToken;

    const statusMsg = joinOk
      ? `Joined team, restart gateway to take effect`
      : `Hub unreachable, gateway will auto-join on startup`;
    console.log(`
${GREEN}${BOLD}  ┌────────────────────────────────────────────────────────────┐
  │  ✔ Client configured! / Client 配置完成！                 │
  │  ${CYAN}Hub: ${hubAddress}${GREEN}
  │  ${CYAN}${statusMsg}${GREEN}
  └────────────────────────────────────────────────────────────┘${RESET}
`);

  } else {
    prompt.close();
    warn(`Invalid choice "${roleAns}", skipping. You can configure later in openclaw.json. / 无效选择，跳过配置。`);
    return;
  }

  prompt.close();

  try {
    if (!cfg.plugins) cfg.plugins = {};
    if (!cfg.plugins.entries) cfg.plugins.entries = {};
    if (!cfg.plugins.entries["memos-local-openclaw-plugin"]) {
      cfg.plugins.entries["memos-local-openclaw-plugin"] = { enabled: true };
    }
    const entry = cfg.plugins.entries["memos-local-openclaw-plugin"];
    if (!entry.config) entry.config = {};
    entry.config.sharing = sharingConfig;

    const backup = cfgPath + ".bak-" + Date.now();
    fs.copyFileSync(cfgPath, backup);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    ok(`Config saved / 配置已写入: ${DIM}~/.openclaw/openclaw.json${RESET}`);
    log(`Backup / 备份: ${DIM}${backup}${RESET}`);
  } catch (e) {
    fail(`Config write failed / 写入配置失败: ${e.message}`);
    warn("Please manually edit ~/.openclaw/openclaw.json to add sharing config. / 请手动编辑配置。");
  }
}

(async () => {
  try {
    await setupSharingWizard();
  } catch (e) {
    warn(`Setup wizard error: ${e.message}`);
  }

  console.log(`
${GREEN}${BOLD}  ┌──────────────────────────────────────────────────┐
  │  ✔ Setup complete!                                │
  │                                                    │
  │  Restart gateway:                                  │
  │  ${CYAN}openclaw gateway stop && openclaw gateway start${GREEN}  │
  └──────────────────────────────────────────────────┘${RESET}
`);
  process.exit(0);
})();
