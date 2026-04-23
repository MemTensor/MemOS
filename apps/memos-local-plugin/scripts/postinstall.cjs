#!/usr/bin/env node
/*
 * postinstall hook for @memtensor/memos-local-plugin.
 *
 * This file is intentionally tiny and side-effect free. It MUST NOT touch the
 * user's home directory, write any state, or assume which agent the user is
 * installing for. All of that happens in install.sh / install.ps1, which the
 * user runs explicitly with their chosen agent.
 *
 * We only print a friendly hint so users know what to do next.
 */

"use strict";

const path = require("node:path");

// Skip when the package is being linked locally during development.
if (process.env.npm_config_global !== "true" && process.env.MEMOS_FORCE_POSTINSTALL !== "1") {
  // Local dev installs (npm install in a workspace) don't need the hint.
  // Allow override with MEMOS_FORCE_POSTINSTALL=1 for testing.
  process.exit(0);
}

const here = path.dirname(__dirname);
const installSh = path.join(here, "install.sh");
const installPs1 = path.join(here, "install.ps1");

const banner = [
  "",
  "  @memtensor/memos-local-plugin installed.",
  "",
  "  Source code is here, but no agent has been wired up yet. Run the",
  "  installer for your agent to (1) deploy the plugin into the agent's",
  "  plugin directory and (2) generate config.yaml under your agent's",
  "  runtime data directory.",
  "",
  "    macOS / Linux:",
  "      bash " + installSh + " openclaw     # or: hermes",
  "",
  "    Windows (PowerShell):",
  "      powershell -ExecutionPolicy Bypass -File " + installPs1 + " -Agent openclaw",
  "",
  "  Re-running the installer is safe; it only generates config.yaml on first run.",
  "",
].join("\n");

process.stdout.write(banner);
