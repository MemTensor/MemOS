/**
 * Electron-builder afterPack hook to copy architecture-specific Node.js binaries.
 *
 * This hook runs after packing but before creating distributable formats.
 * It copies the correct Node.js binary based on the target platform and architecture.
 *
 * @see https://www.electron.build/configuration/configuration#afterpack
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NODE_VERSION = '20.18.1';

/**
 * Map electron-builder arch number to string
 * @see https://github.com/electron-userland/electron-builder/blob/master/packages/builder-util/src/arch.ts
 */
const ARCH_MAP = {
  0: 'ia32',   // Arch.ia32
  1: 'x64',    // Arch.x64
  2: 'armv7l', // Arch.armv7l
  3: 'arm64',  // Arch.arm64
  4: 'universal', // Arch.universal (macOS only)
};

/**
 * Map electron-builder platform name to Node.js platform name
 */
const PLATFORM_MAP = {
  mac: 'darwin',
  windows: 'win32',
  linux: 'linux',
};

/**
 * Get the Node.js directory name based on platform
 */
function getNodeDirName(platform, arch) {
  if (platform === 'win32') {
    return `node-v${NODE_VERSION}-win-${arch}`;
  }
  return `node-v${NODE_VERSION}-${platform}-${arch}`;
}

/**
 * After-pack hook to copy architecture-specific Node.js binaries
 *
 * For universal macOS builds, we need to include BOTH x64 and arm64 Node.js
 * binaries in EACH architecture's build. This is because electron-builder's
 * universal app merger requires identical file structures in both builds.
 * At runtime, the app uses process.arch to select the correct binary.
 *
 * @param {Object} context - electron-builder context
 * @param {Object} context.packager - Packager instance
 * @param {Object} context.packager.platform - Platform info
 * @param {string} context.packager.platform.name - 'mac', 'linux', 'windows'
 * @param {number} context.arch - Architecture number (0=ia32, 1=x64, 3=arm64, 4=universal)
 * @param {string} context.appOutDir - Output directory for the app
 */
exports.default = async function afterPack(context) {
  const { packager, arch, appOutDir } = context;
  const platformName = packager.platform.name;

  const archName = ARCH_MAP[arch] || 'x64';
  const nodePlatform = PLATFORM_MAP[platformName] || platformName;

  console.log(`\n[after-pack] Platform: ${platformName}, Arch: ${archName}`);

  // Detect universal build by checking if output dir contains 'universal'
  // For universal builds, appOutDir is like 'release/mac-universal-x64-temp' or 'release/mac-universal-arm64-temp'
  const isUniversalBuild = appOutDir.includes('universal');

  // For macOS universal builds, we need BOTH architectures in EACH build
  // so that electron-builder can merge them (it requires identical file structures)
  if (platformName === 'mac' && isUniversalBuild) {
    console.log('[after-pack] macOS universal build - copying both x64 and arm64 Node.js binaries');
    await copyNodeBinary(context, nodePlatform, 'x64');
    await copyNodeBinary(context, nodePlatform, 'arm64');
    await resignMacApp(context);
    return;
  }

  // For single-arch builds, just copy the target architecture
  await copyNodeBinary(context, nodePlatform, archName);

  // Re-sign macOS apps after modifying the bundle
  if (platformName === 'mac') {
    await resignMacApp(context);
  }
};

/**
 * Copy Node.js binary for a specific platform/arch combination
 */
async function copyNodeBinary(context, platform, arch) {
  const { packager, appOutDir } = context;
  const platformName = packager.platform.name;

  const nodeDirName = getNodeDirName(platform, arch);

  // Source: resources/nodejs/<platform>-<arch>/node-v20.18.1-<platform>-<arch>/
  const sourceDir = path.join(
    __dirname,
    '..',
    'resources',
    'nodejs',
    `${platform}-${arch}`,
    nodeDirName
  );

  // Check if source exists - fail the build if missing
  if (!fs.existsSync(sourceDir)) {
    const errorMsg = `[after-pack] ERROR: Node.js binary not found at ${sourceDir}\n` +
      `Run "pnpm -F @accomplish/desktop download:nodejs" first to download the binaries.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // Determine destination based on platform
  let destDir;
  if (platformName === 'mac') {
    // For universal builds, we need to include the arch in the path
    // macOS app bundle structure: <AppName>.app/Contents/Resources/
    const appName = packager.appInfo.productFilename;
    destDir = path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources', 'nodejs', arch);
  } else {
    // Windows/Linux: <app>/resources/
    destDir = path.join(appOutDir, 'resources', 'nodejs', arch);
  }

  console.log(`[after-pack] Copying Node.js ${arch}: ${sourceDir} -> ${destDir}`);

  // Create destination directory
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Copy the entire Node.js directory, excluding unnecessary directories
  try {
    copyDirRecursive(sourceDir, destDir, destDir, NODEJS_EXCLUDE_DIRS);
  } catch (err) {
    console.error(`[after-pack] ERROR copying Node.js ${arch}:`, err.message);
    throw err;
  }

  // Make binaries executable on Unix
  if (platformName !== 'windows') {
    const binDir = path.join(destDir, 'bin');
    if (fs.existsSync(binDir)) {
      const binaries = ['node', 'npm', 'npx'];
      for (const binary of binaries) {
        const binPath = path.join(binDir, binary);
        if (fs.existsSync(binPath)) {
          fs.chmodSync(binPath, 0o755);
        }
      }
    }
  }

  console.log(`[after-pack] Successfully copied Node.js ${arch} to ${destDir}`);
}

/**
 * Directories to exclude from Node.js bundle.
 * - 'include': Contains C/C++ header files (~53MB) only needed for native module compilation,
 *              not required at runtime. This significantly reduces DMG size.
 */
const NODEJS_EXCLUDE_DIRS = ['include'];

/**
 * Recursively copy a directory
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 * @param {string} rootDest - Root destination for symlink validation (optional, defaults to dest)
 * @param {string[]} excludeDirs - Directory names to skip (optional)
 */
function copyDirRecursive(src, dest, rootDest = dest, excludeDirs = []) {
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // Skip excluded directories
      if (excludeDirs.includes(entry.name)) {
        console.log(`[after-pack] Skipping excluded directory: ${entry.name} (saves ~53MB)`);
        continue;
      }
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
      copyDirRecursive(srcPath, destPath, rootDest, excludeDirs);
    } else if (entry.isSymbolicLink()) {
      // Preserve symlinks (npm and npx are often symlinks to node)
      const linkTarget = fs.readlinkSync(srcPath);

      // Security: Validate symlink doesn't escape the root destination directory
      // Only allow relative symlinks that stay within the directory tree
      if (path.isAbsolute(linkTarget)) {
        console.warn(`[after-pack] Skipping absolute symlink: ${srcPath} -> ${linkTarget}`);
        continue;
      }

      // Check resolved path doesn't escape the ROOT destination (not current dest)
      // e.g., bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js is valid
      const resolvedPath = path.resolve(path.dirname(destPath), linkTarget);
      if (!resolvedPath.startsWith(rootDest)) {
        console.warn(`[after-pack] Skipping symlink that escapes directory: ${srcPath} -> ${linkTarget}`);
        continue;
      }

      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      fs.symlinkSync(linkTarget, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Re-sign macOS app after modifying the bundle.
 *
 * Adding Node.js binaries invalidates the original signature.
 * We re-sign with ad-hoc signature (-) which allows the app to run
 * on machines with Gatekeeper when downloaded from the internet.
 *
 * For production releases, this should be replaced with proper
 * Developer ID signing via electron-builder's sign option.
 */
async function resignMacApp(context) {
  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[after-pack] Re-signing macOS app: ${appPath}`);

  try {
    // Remove existing signature and re-sign with ad-hoc signature
    // --force: replace existing signature
    // --deep: sign all nested code (frameworks, helpers, etc.)
    // --sign -: ad-hoc signature (no certificate required)
    execSync(`codesign --force --deep --sign - "${appPath}"`, {
      stdio: 'inherit',
    });
    console.log('[after-pack] Successfully re-signed macOS app');
  } catch (err) {
    console.error('[after-pack] Failed to re-sign macOS app:', err.message);
    // Don't fail the build - unsigned apps still work locally
    // and users can remove quarantine manually
  }
}
