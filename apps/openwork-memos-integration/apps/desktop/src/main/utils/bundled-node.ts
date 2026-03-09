/**
 * Utility module for accessing bundled Node.js binaries.
 *
 * The app bundles standalone Node.js v20.18.1 binaries to ensure
 * MCP servers and CLI tools work regardless of the user's system configuration.
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';

const NODE_VERSION = '20.18.1';

export interface BundledNodePaths {
  /** Path to the node executable */
  nodePath: string;
  /** Path to the npm executable */
  npmPath: string;
  /** Path to the npx executable */
  npxPath: string;
  /** Directory containing the node binary */
  binDir: string;
  /** Root directory of the Node.js installation */
  nodeDir: string;
}

/**
 * Get paths to the bundled Node.js binaries.
 *
 * In packaged apps, returns paths to the bundled Node.js installation.
 * In development mode, returns null (use system Node.js).
 *
 * @returns Paths to bundled Node.js binaries, or null if not available
 */
export function getBundledNodePaths(): BundledNodePaths | null {
  if (!app.isPackaged) {
    // In development, use system Node
    return null;
  }

  const platform = process.platform; // 'darwin', 'win32', 'linux'
  const arch = process.arch; // 'x64', 'arm64'

  const isWindows = platform === 'win32';
  const ext = isWindows ? '.exe' : '';
  const scriptExt = isWindows ? '.cmd' : '';

  // Node.js directory is architecture-specific
  const nodeDir = path.join(
    process.resourcesPath,
    'nodejs',
    arch // 'x64' or 'arm64' subdirectory
  );

  const binDir = isWindows ? nodeDir : path.join(nodeDir, 'bin');

  return {
    nodePath: path.join(binDir, `node${ext}`),
    npmPath: path.join(binDir, `npm${scriptExt}`),
    npxPath: path.join(binDir, `npx${scriptExt}`),
    binDir,
    nodeDir,
  };
}

/**
 * Check if bundled Node.js is available and accessible.
 *
 * @returns true if bundled Node.js exists and is accessible
 */
export function isBundledNodeAvailable(): boolean {
  const paths = getBundledNodePaths();
  if (!paths) {
    return false;
  }
  return fs.existsSync(paths.nodePath);
}

/**
 * Get the node binary path (bundled or system fallback).
 *
 * In packaged apps, returns the bundled node path.
 * In development or if bundled node is unavailable, returns 'node' to use system PATH.
 *
 * @returns Absolute path to node binary or 'node' for system fallback
 */
export function getNodePath(): string {
  const bundled = getBundledNodePaths();
  if (bundled && fs.existsSync(bundled.nodePath)) {
    return bundled.nodePath;
  }
  // Warn if falling back to system node in packaged app (unexpected)
  if (app.isPackaged) {
    console.warn('[Bundled Node] WARNING: Bundled Node.js not found, falling back to system node');
  }
  return 'node'; // Fallback to system node
}

/**
 * Get the npm binary path (bundled or system fallback).
 *
 * @returns Absolute path to npm binary or 'npm' for system fallback
 */
export function getNpmPath(): string {
  const bundled = getBundledNodePaths();
  if (bundled && fs.existsSync(bundled.npmPath)) {
    return bundled.npmPath;
  }
  if (app.isPackaged) {
    console.warn('[Bundled Node] WARNING: Bundled npm not found, falling back to system npm');
  }
  return 'npm'; // Fallback to system npm
}

/**
 * Get the npx binary path (bundled or system fallback).
 *
 * @returns Absolute path to npx binary or 'npx' for system fallback
 */
export function getNpxPath(): string {
  const bundled = getBundledNodePaths();
  if (bundled && fs.existsSync(bundled.npxPath)) {
    return bundled.npxPath;
  }
  if (app.isPackaged) {
    console.warn('[Bundled Node] WARNING: Bundled npx not found, falling back to system npx');
  }
  return 'npx'; // Fallback to system npx
}

/**
 * Log information about the bundled Node.js for debugging.
 */
export function logBundledNodeInfo(): void {
  const paths = getBundledNodePaths();

  if (!paths) {
    console.log('[Bundled Node] Development mode - using system Node.js');
    return;
  }

  console.log('[Bundled Node] Configuration:');
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Architecture: ${process.arch}`);
  console.log(`  Node directory: ${paths.nodeDir}`);
  console.log(`  Node path: ${paths.nodePath}`);
  console.log(`  Available: ${fs.existsSync(paths.nodePath)}`);
}
