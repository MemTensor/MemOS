import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { compareSemver } from "./semver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHECK_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours check interval
const PLUGIN_NAME = "@memtensor/memos-cloud-openclaw-plugin";
const CHECK_FILE = path.join(os.tmpdir(), "memos_openclaw_update_check.json");

const ANSI = {
  RESET: "\x1b[0m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  CYAN: "\x1b[36m",
  RED: "\x1b[31m"
};


export function getPackageVersion() {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkgData = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgData);
    return pkg.version;
  } catch (err) {
    return null;
  }
}

export function getLatestVersion() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://registry.npmjs.org/${PLUGIN_NAME}/latest`,
      { timeout: 5000 },
      (res) => {
        if (res.statusCode !== 200) {
          req.destroy();
          return reject(new Error(`Failed to fetch version, status: ${res.statusCode}`));
        }

        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });

        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve(data.version);
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout getting latest version"));
    });
  });
}

export function compareVersions(v1, v2) {
  return compareSemver(v1, v2);
}

function detectCliName() {
  // Check the full path of the entry script (e.g., .../moltbot/bin/index.js) or the executable
  const scriptPath = process.argv[1] ? process.argv[1].toLowerCase() : "";
  const execPath = process.execPath ? process.execPath.toLowerCase() : "";

  if (scriptPath.includes("moltbot") || execPath.includes("moltbot")) return "moltbot";
  if (scriptPath.includes("clawdbot") || execPath.includes("clawdbot")) return "clawdbot";
  return "openclaw";
}

export async function checkForPluginUpdate() {
  const currentVersion = getPackageVersion();
  if (!currentVersion) {
    throw new Error("Could not read current version from package.json");
  }

  const latestVersion = await getLatestVersion();
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
  const cliName = detectCliName();

  return {
    pluginName: PLUGIN_NAME,
    currentVersion,
    latestVersion,
    updateAvailable,
    cliName,
    updateCommand: `${cliName} plugins update memos-cloud-openclaw-plugin`,
    checkedAt: new Date().toISOString(),
  };
}

export function startUpdateChecker(log) {
  // Only start the interval if we are in the gateway
  const isGateway = process.argv.includes("gateway");
  if (!isGateway) {
    return;
  }

  const runCheck = async () => {
    // TRULY PREVENT LOOPS: The instant we start a check, record the time BEFORE any network or processing happens.
    // This absolutely guarantees that even if the network hangs, NPM crashes, or openclaw update causes an immediate hot reload,
    // the system has already advanced the 12-hour/1-min clock and will NOT re-enter this function on boot.
    try {
      fs.writeFileSync(CHECK_FILE, JSON.stringify({ time: Date.now() }));
    } catch (e) {
      log.warn?.(`${ANSI.RED}[memos-cloud] Failed to write timestamp file: ${e.message}${ANSI.RESET}`);
    }

    try {
      const updateStatus = await checkForPluginUpdate();

      // Normal version check
      if (!updateStatus.updateAvailable) {
        return;
      }

      const border = "=".repeat(64);
      log.info?.("");
      log.info?.(`${ANSI.GREEN}${border}${ANSI.RESET}`);
      log.info?.(`${ANSI.YELLOW}🚀 [memos-cloud] NEW VERSION AVAILABLE!${ANSI.RESET}`);
      log.info?.(`${ANSI.CYAN}📦 Current version : ${updateStatus.currentVersion}${ANSI.RESET}`);
      log.info?.(`${ANSI.GREEN}✨ Latest version  : ${updateStatus.latestVersion}${ANSI.RESET}`);
      log.info?.(`${ANSI.CYAN}────────────────────────────────────────────────────────────────${ANSI.RESET}`);
      log.info?.(`${ANSI.GREEN}Please run the following command to update manually:${ANSI.RESET}`);
      log.info?.(`${ANSI.YELLOW}${updateStatus.updateCommand}${ANSI.RESET}`);
      log.info?.(`${ANSI.GREEN}${border}${ANSI.RESET}`);
      log.info?.("");

    } catch (error) {
      log.warn?.(`${ANSI.RED}[memos-cloud] Update check failed entirely: ${error.message}${ANSI.RESET}`);
    }
  };

  // Check when we last ran
  let lastCheckTime = 0;
  try {
    if (fs.existsSync(CHECK_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHECK_FILE, "utf-8"));
      lastCheckTime = data.time || 0;
    }
  } catch (e) {}

  const now = Date.now();
  const timeSinceLastCheck = now - lastCheckTime;

  // If the interval has passed, run it IMMEDIATELY without delay.
  // The immediate file-write at the top of runCheck() will prevent loop scenarios.
  if (timeSinceLastCheck >= CHECK_INTERVAL) {
    runCheck();
    setInterval(runCheck, CHECK_INTERVAL);
  } else {
    // If it hasn't been the full interval yet, wait the remaining time, then trigger interval
    const timeUntilNextCheck = CHECK_INTERVAL - timeSinceLastCheck;
    setTimeout(() => {
      runCheck();
      setInterval(runCheck, CHECK_INTERVAL);
    }, timeUntilNextCheck);
  }
}
