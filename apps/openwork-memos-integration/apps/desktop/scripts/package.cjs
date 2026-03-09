#!/usr/bin/env node

/**
 * Custom packaging script for Electron app with pnpm workspaces.
 * Temporarily removes workspace symlinks that cause electron-builder issues.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
const accomplishPath = path.join(nodeModulesPath, '@accomplish');

// Save symlink target for restoration
let symlinkTarget = null;
const sharedPath = path.join(accomplishPath, 'shared');

try {
  // Check if @accomplish/shared symlink exists
  if (fs.existsSync(sharedPath)) {
    const stats = fs.lstatSync(sharedPath);
    if (stats.isSymbolicLink()) {
      symlinkTarget = fs.readlinkSync(sharedPath);
      console.log('Temporarily removing workspace symlink:', sharedPath);
      fs.unlinkSync(sharedPath);

      // Remove empty @accomplish directory if it exists
      try {
        fs.rmdirSync(accomplishPath);
      } catch {
        // Directory not empty or doesn't exist, ignore
      }
    }
  }

  // Get command line args (everything after 'node scripts/package.js')
  const args = process.argv.slice(2).join(' ');
  // Use npx to run electron-builder to ensure it's found in node_modules
  const command = `npx electron-builder ${args}`;

  console.log('Running:', command);
  execSync(command, { stdio: 'inherit', cwd: path.join(__dirname, '..') });

} finally {
  // Restore the symlink
  if (symlinkTarget) {
    console.log('Restoring workspace symlink');

    // Recreate @accomplish directory if needed
    if (!fs.existsSync(accomplishPath)) {
      fs.mkdirSync(accomplishPath, { recursive: true });
    }

    fs.symlinkSync(symlinkTarget, sharedPath);
  }
}
