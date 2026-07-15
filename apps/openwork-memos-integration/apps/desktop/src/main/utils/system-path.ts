/**
 * System PATH utilities for macOS packaged apps
 *
 * macOS GUI apps launched from /Applications don't inherit the user's terminal PATH.
 * This module provides utilities to build a proper PATH without loading shell profiles,
 * which avoids triggering macOS folder access permissions (TCC).
 *
 * We use two approaches:
 * 1. /usr/libexec/path_helper - macOS official utility that reads /etc/paths and /etc/paths.d
 * 2. Common Node.js installation paths - covers NVM, Volta, asdf, Homebrew, etc.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Get NVM Node.js version paths.
 * NVM stores versions in ~/.nvm/versions/node/vX.X.X/bin/
 * Returns paths sorted by version (newest first).
 */
function getNvmNodePaths(): string[] {
  const home = process.env.HOME || '';
  const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');

  if (!fs.existsSync(nvmVersionsDir)) {
    return [];
  }

  try {
    const versions = fs.readdirSync(nvmVersionsDir)
      .filter(name => name.startsWith('v'))
      .sort((a, b) => {
        // Sort by version number (descending - newest first)
        const parseVersion = (v: string) => {
          const parts = v.replace('v', '').split('.').map(Number);
          return parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
        };
        return parseVersion(b) - parseVersion(a);
      });

    return versions.map(v => path.join(nvmVersionsDir, v, 'bin'));
  } catch {
    return [];
  }
}

/**
 * Get fnm Node.js version paths.
 * fnm stores versions in ~/.fnm/node-versions/vX.X.X/installation/bin/
 */
function getFnmNodePaths(): string[] {
  const home = process.env.HOME || '';
  const fnmVersionsDir = path.join(home, '.fnm', 'node-versions');

  if (!fs.existsSync(fnmVersionsDir)) {
    return [];
  }

  try {
    const versions = fs.readdirSync(fnmVersionsDir)
      .filter(name => name.startsWith('v'))
      .sort((a, b) => {
        const parseVersion = (v: string) => {
          const parts = v.replace('v', '').split('.').map(Number);
          return parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
        };
        return parseVersion(b) - parseVersion(a);
      });

    return versions.map(v => path.join(fnmVersionsDir, v, 'installation', 'bin'));
  } catch {
    return [];
  }
}

/**
 * Common Node.js installation paths on macOS.
 * These are checked in order of preference.
 */
function getCommonNodePaths(): string[] {
  const home = process.env.HOME || '';

  // Get dynamic paths from version managers
  const nvmPaths = getNvmNodePaths();
  const fnmPaths = getFnmNodePaths();

  return [
    // Version managers (dynamic - most specific, checked first)
    ...nvmPaths,
    ...fnmPaths,

    // Homebrew (very common)
    '/opt/homebrew/bin',              // Apple Silicon
    '/usr/local/bin',                 // Intel Mac

    // Version managers (static fallbacks)
    `${home}/.nvm/current/bin`,       // NVM with 'current' symlink (optional)
    `${home}/.volta/bin`,             // Volta
    `${home}/.asdf/shims`,            // asdf
    `${home}/.fnm/current/bin`,       // fnm current symlink (optional)
    `${home}/.nodenv/shims`,          // nodenv

    // Less common but valid paths
    '/usr/local/opt/node/bin',        // Homebrew node formula
    '/opt/local/bin',                 // MacPorts
    `${home}/.local/bin`,             // pip/pipx style installations
  ].filter(p => p && !p.includes('undefined'));
}

/**
 * Get system PATH using macOS path_helper utility.
 * This reads from /etc/paths and /etc/paths.d without loading user shell profiles.
 *
 * @returns The system PATH or null if path_helper fails
 */
function getSystemPathFromPathHelper(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    // path_helper outputs: PATH="..."; export PATH;
    // We need to extract just the path value
    const output = execSync('/usr/libexec/path_helper -s', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    // Parse the output: PATH="/usr/local/bin:/usr/bin:..."; export PATH;
    const match = output.match(/PATH="([^"]+)"/);
    if (match && match[1]) {
      return match[1];
    }
  } catch (err) {
    console.warn('[SystemPath] path_helper failed:', err);
  }

  return null;
}

/**
 * Build an extended PATH for finding Node.js tools (node, npm, npx) in packaged apps.
 *
 * This function:
 * 1. Gets the system PATH from path_helper (includes Homebrew if in /etc/paths.d)
 * 2. Prepends common Node.js installation paths
 * 3. Does NOT load user shell profiles (avoids TCC permission prompts)
 *
 * @param basePath - The base PATH to extend (defaults to process.env.PATH)
 * @returns Extended PATH string
 */
export function getExtendedNodePath(basePath?: string): string {
  const base = basePath || process.env.PATH || '';

  if (process.platform !== 'darwin') {
    // On non-macOS, just return the base PATH
    return base;
  }

  // Start with common Node.js paths
  const nodePaths = getCommonNodePaths();

  // Try to get system PATH from path_helper
  const systemPath = getSystemPathFromPathHelper();

  // Build the final PATH:
  // 1. Common Node.js paths (highest priority - finds user's preferred Node)
  // 2. System PATH from path_helper (includes /etc/paths.d entries)
  // 3. Base PATH (fallback)
  const pathParts: string[] = [];

  // Add common Node.js paths
  for (const p of nodePaths) {
    if (fs.existsSync(p) && !pathParts.includes(p)) {
      pathParts.push(p);
    }
  }

  // Add system PATH from path_helper
  if (systemPath) {
    for (const p of systemPath.split(':')) {
      if (p && !pathParts.includes(p)) {
        pathParts.push(p);
      }
    }
  }

  // Add base PATH entries
  for (const p of base.split(':')) {
    if (p && !pathParts.includes(p)) {
      pathParts.push(p);
    }
  }

  return pathParts.join(':');
}

/**
 * Check if a command exists in the given PATH.
 *
 * @param command - The command to find (e.g., 'npx', 'node')
 * @param searchPath - The PATH to search in
 * @returns The full path to the command if found, null otherwise
 */
export function findCommandInPath(command: string, searchPath: string): string | null {
  for (const dir of searchPath.split(':')) {
    if (!dir) continue;

    const fullPath = `${dir}/${command}`;
    try {
      if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        if (stats.isFile()) {
          // Check if executable
          try {
            fs.accessSync(fullPath, fs.constants.X_OK);
            return fullPath;
          } catch {
            // Not executable, continue searching
          }
        }
      }
    } catch {
      // Directory doesn't exist or other error, continue
    }
  }

  return null;
}
