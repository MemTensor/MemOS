import { serve } from "@/index.js";
import { execSync } from "child_process";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use a user-writable location for tmp and profiles (app bundle is read-only when installed)
// On macOS: ~/Library/Application Support/Accomplish/dev-browser/
// Fallback: system temp directory
function getDataDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (process.platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Accomplish", "dev-browser");
  } else if (process.platform === "win32") {
    return join(process.env.APPDATA || homeDir, "Accomplish", "dev-browser");
  } else {
    // Linux or fallback
    return join(homeDir, ".accomplish", "dev-browser");
  }
}

const dataDir = getDataDir();
const tmpDir = join(dataDir, "tmp");
const profileDir = join(dataDir, "profiles");

// Create data directories if they don't exist
console.log(`Creating data directory: ${dataDir}`);
mkdirSync(tmpDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });

// Accomplish uses ports 9224/9225 to avoid conflicts with Claude Code's dev-browser (9222/9223)
const ACCOMPLISH_HTTP_PORT = 9224;
const ACCOMPLISH_CDP_PORT = 9225;

// Check if server is already running
console.log("Checking for existing servers...");
try {
  const res = await fetch(`http://localhost:${ACCOMPLISH_HTTP_PORT}`, {
    signal: AbortSignal.timeout(1000),
  });
  if (res.ok) {
    console.log(`Server already running on port ${ACCOMPLISH_HTTP_PORT}`);
    process.exit(0);
  }
} catch {
  // Server not running, continue to start
}

// Clean up stale CDP port if HTTP server isn't running (crash recovery)
// This handles the case where Node crashed but Chrome is still running
try {
  const pid = execSync(`lsof -ti:${ACCOMPLISH_CDP_PORT}`, { encoding: "utf-8" }).trim();
  if (pid) {
    console.log(`Cleaning up stale Chrome process on CDP port ${ACCOMPLISH_CDP_PORT} (PID: ${pid})`);
    execSync(`kill -9 ${pid}`);
  }
} catch {
  // No process on CDP port, which is expected
}

// Clean up stale Chrome profile lock files (crash recovery)
// When Chrome crashes or is force-killed, it leaves behind SingletonLock files
// that prevent new instances from starting. Clean them up before launching.
// We have separate profile directories for system Chrome and Playwright Chromium.
const profileDirs = [
  join(profileDir, "chrome-profile"),
  join(profileDir, "playwright-profile"),
];
const staleLockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
for (const dir of profileDirs) {
  for (const lockFile of staleLockFiles) {
    const lockPath = join(dir, lockFile);
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
        console.log(`Cleaned up stale lock file: ${lockFile} in ${dir}`);
      } catch (err) {
        console.warn(`Failed to remove ${lockFile}:`, err);
      }
    }
  }
}

// Helper to install Playwright Chromium
function installPlaywrightChromium(): void {
  console.log("\n========================================");
  console.log("Downloading browser (one-time setup)...");
  console.log("This may take 1-2 minutes.");
  console.log("========================================\n");

  const managers = [
    { name: "bun", command: "bunx playwright install chromium" },
    { name: "pnpm", command: "pnpm exec playwright install chromium" },
    { name: "npm", command: "npx playwright install chromium" },
  ];

  let pm: { name: string; command: string } | null = null;
  for (const manager of managers) {
    try {
      execSync(`which ${manager.name}`, { stdio: "ignore" });
      pm = manager;
      break;
    } catch {
      // Package manager not found, try next
    }
  }

  if (!pm) {
    throw new Error("No package manager found (tried bun, pnpm, npm)");
  }

  console.log(`Using ${pm.name} to install Playwright Chromium...`);
  execSync(pm.command, { stdio: "inherit" }); // inherit shows download progress
  console.log("\nBrowser installed successfully!\n");
}

// Start the server - tries system Chrome first, falls back to Playwright Chromium
console.log("Starting dev browser server...");
const headless = process.env.HEADLESS === "true";

async function startServer(retry = false): Promise<void> {
  try {
    const server = await serve({
      port: ACCOMPLISH_HTTP_PORT,
      cdpPort: ACCOMPLISH_CDP_PORT,
      headless,
      profileDir,
      useSystemChrome: true, // Try system Chrome first for faster startup
    });

    console.log(`Dev browser server started`);
    console.log(`  WebSocket: ${server.wsEndpoint}`);
    console.log(`  Tmp directory: ${tmpDir}`);
    console.log(`  Profile directory: ${profileDir}`);
    console.log(`\nReady`);
    console.log(`\nPress Ctrl+C to stop`);

    // Keep the process running
    await new Promise(() => {});
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if error is about missing Playwright browsers
    const isBrowserMissing =
      errorMessage.includes("Executable doesn't exist") ||
      errorMessage.includes("browserType.launchPersistentContext") ||
      errorMessage.includes("npx playwright install") ||
      errorMessage.includes("run the install command");

    if (isBrowserMissing && !retry) {
      console.log("\nSystem Chrome not available, downloading Playwright Chromium...");
      try {
        installPlaywrightChromium();
        // Retry with Playwright Chromium (useSystemChrome will fail again, but fallback will work)
        await startServer(true);
        return;
      } catch (installError) {
        console.error("Failed to install Playwright browsers:", installError);
        console.log("You may need to run manually: npx playwright install chromium");
        process.exit(1);
      }
    }

    // If we've already retried or it's a different error, give up
    console.error("Failed to start dev browser server:", error);
    process.exit(1);
  }
}

await startServer();
