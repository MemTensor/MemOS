import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

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


function getPackageVersion() {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkgData = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgData);
    return pkg.version;
  } catch (err) {
    return null;
  }
}

function getLatestVersion(log) {
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

function compareVersions(v1, v2) {
  // Split pre-release tags (e.g. 0.1.8-beta.1 -> "0.1.8" and "beta.1")
  const split1 = v1.split("-");
  const split2 = v2.split("-");
  const parts1 = split1[0].split(".").map(Number);
  const parts2 = split2[0].split(".").map(Number);

  // Compare major.minor.patch
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }

  // If base versions are equal, compare pre-release tags.
  // A version WITH a pre-release tag is LOWER than a version WITHOUT one.
  // e.g. 0.1.8-beta is less than 0.1.8. 0.1.8 is the final release.
  const hasPre1 = split1.length > 1;
  const hasPre2 = split2.length > 1;

  if (hasPre1 && !hasPre2) return -1; // v1 is a beta, v2 is a full release
  if (!hasPre1 && hasPre2) return 1;  // v1 is a full release, v2 is a beta
  if (!hasPre1 && !hasPre2) return 0; // both are full releases and equal

  // If both are pre-releases, do a basic string compare on the tag
  // "alpha" < "beta" < "rc"
  if (split1[1] > split2[1]) return 1;
  if (split1[1] < split2[1]) return -1;

  return 0;
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

    const currentVersion = getPackageVersion();
    if (!currentVersion) {
      log.warn?.(`${ANSI.RED}[memos-cloud] Could not read current version from package.json${ANSI.RESET}`);
      return;
    }

    try {
      const latestVersion = await getLatestVersion(log);

      // Normal version check
      if (compareVersions(latestVersion, currentVersion) <= 0) {
        return;
      }

      const cliName = (() => {
        // Check the full path of the entry script (e.g., .../moltbot/bin/index.js) or the executable
        const scriptPath = process.argv[1] ? process.argv[1].toLowerCase() : "";
        const execPath = process.execPath ? process.execPath.toLowerCase() : "";

        if (scriptPath.includes("moltbot") || execPath.includes("moltbot")) return "moltbot";
        if (scriptPath.includes("clawdbot") || execPath.includes("clawdbot")) return "clawdbot";
        return "openclaw";
      })();

      const border = "=".repeat(64);
      log.info?.("");
      log.info?.(`${ANSI.GREEN}${border}${ANSI.RESET}`);
      log.info?.(`${ANSI.YELLOW}🚀 [memos-cloud] NEW VERSION AVAILABLE!${ANSI.RESET}`);
      log.info?.(`${ANSI.CYAN}📦 Current version : ${currentVersion}${ANSI.RESET}`);
      log.info?.(`${ANSI.GREEN}✨ Latest version  : ${latestVersion}${ANSI.RESET}`);
      log.info?.(`${ANSI.CYAN}────────────────────────────────────────────────────────────────${ANSI.RESET}`);
      log.info?.(`${ANSI.GREEN}Please run the following command to update manually:${ANSI.RESET}`);
      log.info?.(`${ANSI.YELLOW}${cliName} plugins update memos-cloud-openclaw-plugin${ANSI.RESET}`);
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
