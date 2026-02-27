import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

/**
 * Get all possible nvm OpenCode CLI paths by scanning the nvm versions directory
 */
function getNvmOpenCodePaths(): string[] {
  const homeDir = process.env.HOME || '';
  const nvmVersionsDir = path.join(homeDir, '.nvm/versions/node');
  const paths: string[] = [];

  try {
    if (fs.existsSync(nvmVersionsDir)) {
      const versions = fs.readdirSync(nvmVersionsDir);
      for (const version of versions) {
        const opencodePath = path.join(nvmVersionsDir, version, 'bin', 'opencode');
        if (fs.existsSync(opencodePath)) {
          paths.push(opencodePath);
        }
      }
    }
  } catch {
    // Ignore errors scanning nvm directory
  }

  return paths;
}

/**
 * Get the path to the bundled OpenCode CLI.
 *
 * In development: uses node_modules/.bin/opencode
 * In packaged app: uses the bundled CLI from unpacked asar
 */
export function getOpenCodeCliPath(): { command: string; args: string[] } {
  if (app.isPackaged) {
    // In packaged app, OpenCode is in unpacked asar
    // process.resourcesPath points to Resources folder in macOS app bundle
    const cliPath = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'opencode-ai',
      'bin',
      'opencode'
    );

    // Verify the file exists
    if (!fs.existsSync(cliPath)) {
      throw new Error(`OpenCode CLI not found at: ${cliPath}`);
    }

    // OpenCode binary can be run directly
    return {
      command: cliPath,
      args: [],
    };
  } else {
    // In development, use global opencode if available

    // Check nvm installations (dynamically scan all versions)
    const nvmPaths = getNvmOpenCodePaths();
    for (const opencodePath of nvmPaths) {
      console.log('[CLI Path] Using nvm OpenCode CLI:', opencodePath);
      return { command: opencodePath, args: [] };
    }

    // Check other global installations
    const globalOpenCodePaths = [
      // Global npm
      '/usr/local/bin/opencode',
      // Homebrew
      '/opt/homebrew/bin/opencode',
    ];

    for (const opencodePath of globalOpenCodePaths) {
      if (fs.existsSync(opencodePath)) {
        console.log('[CLI Path] Using global OpenCode CLI:', opencodePath);
        return { command: opencodePath, args: [] };
      }
    }

    // Try bundled CLI in node_modules
    // Use app.getAppPath() instead of process.cwd() as cwd is unpredictable in Electron IPC handlers
    const binName = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
    const devCliPath = path.join(app.getAppPath(), 'node_modules', '.bin', binName);
    if (fs.existsSync(devCliPath)) {
      console.log('[CLI Path] Using bundled CLI:', devCliPath);
      return { command: devCliPath, args: [] };
    }

    // Final fallback: try 'opencode' on PATH
    // This handles cases where opencode is installed globally but in a non-standard location
    console.log('[CLI Path] Falling back to opencode command on PATH');
    return { command: 'opencode', args: [] };
  }
}

/**
 * Check if opencode is available on the system PATH
 */
function isOpenCodeOnPath(): boolean {
  try {
    const command = process.platform === 'win32' ? 'where opencode' : 'which opencode';
    execSync(command, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the bundled OpenCode CLI is available
 */
export function isOpenCodeBundled(): boolean {
  try {
    if (app.isPackaged) {
      // In packaged mode, check if opencode exists
      const cliPath = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'opencode-ai',
        'bin',
        'opencode'
      );
      return fs.existsSync(cliPath);
    } else {
      // In dev mode, actually verify the CLI exists

      // Check nvm installations (dynamically scan all versions)
      const nvmPaths = getNvmOpenCodePaths();
      if (nvmPaths.length > 0) {
        return true;
      }

      // Check other global installations
      const globalOpenCodePaths = [
        // Global npm
        '/usr/local/bin/opencode',
        // Homebrew
        '/opt/homebrew/bin/opencode',
      ];

      for (const opencodePath of globalOpenCodePaths) {
        if (fs.existsSync(opencodePath)) {
          return true;
        }
      }

      // Check bundled CLI in node_modules
      // Use app.getAppPath() instead of process.cwd() as cwd is unpredictable in Electron IPC handlers
      const binName = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
      const devCliPath = path.join(app.getAppPath(), 'node_modules', '.bin', binName);
      if (fs.existsSync(devCliPath)) {
        return true;
      }

      // Final fallback: check if opencode is available on PATH
      // This handles installations in non-standard locations
      if (isOpenCodeOnPath()) {
        return true;
      }

      // No CLI found
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Get the version of the bundled OpenCode CLI
 */
export function getBundledOpenCodeVersion(): string | null {
  try {
    if (app.isPackaged) {
      // In packaged mode, read from package.json
      const packageJsonPath = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'opencode-ai',
        'package.json'
      );

      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        return pkg.version;
      }
      return null;
    } else {
      // In dev mode, run the CLI to get version
      const { command, args } = getOpenCodeCliPath();
      const fullCommand = args.length > 0
        ? `"${command}" ${args.map(a => `"${a}"`).join(' ')} --version`
        : `"${command}" --version`;

      const output = execSync(fullCommand, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      // Parse version from output (e.g., "opencode 1.0.0" or just "1.0.0")
      const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
      return versionMatch ? versionMatch[1] : output;
    }
  } catch {
    return null;
  }
}
