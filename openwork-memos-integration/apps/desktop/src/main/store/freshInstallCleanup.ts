import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { clearAppSettings } from './appSettings';
import { clearTaskHistoryStore } from './taskHistory';
import { clearSecureStorage } from './secureStorage';

/**
 * Fresh Install Cleanup
 *
 * Detects when the app has been reinstalled (e.g., from a new DMG) and clears
 * old user data to ensure a clean first-run experience.
 *
 * Detection strategy:
 * - Store the app bundle's modification timestamp
 * - On startup, compare current bundle mtime with stored value
 * - If different (or no stored value exists for a packaged app with existing data),
 *   it indicates a reinstall → clear old data
 */

interface InstallMarker {
  /** App bundle modification time (ISO string) */
  bundleMtime: string;
  /** App version at install time */
  version: string;
  /** Timestamp when marker was created */
  markerCreated: string;
}

function getKnownUserDataDirs(): string[] {
  const appDataPath = app.getPath('appData');
  const candidates = [
    app.getPath('userData'),
    path.join(appDataPath, 'Accomplish'),
    path.join(appDataPath, '@accomplish', 'desktop'),
    path.join(appDataPath, 'ai.accomplish.desktop'),
    path.join(appDataPath, 'com.accomplish.desktop'),
  ];

  return [...new Set(candidates)];
}

/**
 * Get the path to the install marker file
 */
function getMarkerPath(): string {
  return path.join(app.getPath('userData'), '.install-marker.json');
}

/**
 * Get the app bundle's modification time
 * For packaged apps, this is the .app bundle directory
 * For dev mode, returns null (skip cleanup logic)
 */
function getAppBundleMtime(): Date | null {
  if (!app.isPackaged) {
    return null;
  }

  // For macOS .app bundles, the executable is at:
  // /Applications/Accomplish.app/Contents/MacOS/Accomplish
  // We want the .app bundle directory
  const execPath = app.getPath('exe');

  // Find the .app bundle path
  const appBundleMatch = execPath.match(/^(.+\.app)/);
  if (!appBundleMatch) {
    console.log('[FreshInstall] Could not determine app bundle path from:', execPath);
    return null;
  }

  const appBundlePath = appBundleMatch[1];

  try {
    const stats = fs.statSync(appBundlePath);
    return stats.mtime;
  } catch (err) {
    console.error('[FreshInstall] Could not stat app bundle:', err);
    return null;
  }
}

/**
 * Read the stored install marker
 */
function readInstallMarker(): InstallMarker | null {
  const markerPath = getMarkerPath();

  try {
    if (fs.existsSync(markerPath)) {
      const content = fs.readFileSync(markerPath, 'utf-8');
      return JSON.parse(content) as InstallMarker;
    }
  } catch (err) {
    console.error('[FreshInstall] Could not read install marker:', err);
  }

  return null;
}

/**
 * Write the install marker
 */
function writeInstallMarker(marker: InstallMarker): void {
  const markerPath = getMarkerPath();

  try {
    // Ensure userData directory exists
    const userDataPath = app.getPath('userData');
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }

    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    console.log('[FreshInstall] Install marker saved');
  } catch (err) {
    console.error('[FreshInstall] Could not write install marker:', err);
  }
}

/**
 * Check if there's existing user data that would indicate a previous installation
 */
function hasExistingUserData(): boolean {
  const dataDirs = getKnownUserDataDirs();
  const storeFiles = ['app-settings.json', 'task-history.json'];

  return dataDirs.some((dir) =>
    storeFiles.some((file) => fs.existsSync(path.join(dir, file)))
  );
}

/**
 * Clear all user data from previous installation
 */
function clearPreviousInstallData(): void {
  console.log('[FreshInstall] Clearing data from previous installation...');

  // Clear electron-store data using the store APIs
  // This is important because stores are already initialized in memory
  try {
    clearAppSettings();
    console.log('[FreshInstall]   - Cleared app settings store');
  } catch (err) {
    console.error('[FreshInstall]   - Failed to clear app settings:', err);
  }

  try {
    clearTaskHistoryStore();
    console.log('[FreshInstall]   - Cleared task history store');
  } catch (err) {
    console.error('[FreshInstall]   - Failed to clear task history:', err);
  }

  // Also delete any other config files that might exist
  const userDataPath = app.getPath('userData');
  const filesToRemove = ['config.json', '.install-marker.json'];

  for (const file of filesToRemove) {
    const filePath = path.join(userDataPath, file);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[FreshInstall]   - Removed: ${file}`);
      }
    } catch (err) {
      console.error(`[FreshInstall]   - Failed to remove ${file}:`, err);
    }
  }

  // Remove legacy data files from known previous locations
  const legacyDirs = getKnownUserDataDirs().filter((dir) => dir !== userDataPath);
  const legacyFiles = ['app-settings.json', 'task-history.json', 'config.json', '.install-marker.json'];
  for (const dir of legacyDirs) {
    for (const file of legacyFiles) {
      const filePath = path.join(dir, file);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`[FreshInstall]   - Removed legacy ${file} from ${dir}`);
        }
      } catch (err) {
        console.error(`[FreshInstall]   - Failed to remove legacy ${file} from ${dir}:`, err);
      }
    }
  }

  // Clear secure storage (API keys stored via electron-store + safeStorage)
  try {
    clearSecureStorage();
    console.log('[FreshInstall]   - Cleared secure storage');
  } catch (err) {
    console.error('[FreshInstall]   - Failed to clear secure storage:', err);
  }

  console.log('[FreshInstall] Previous installation data cleared');
}

/**
 * Check if this is a fresh install after a previous installation and perform cleanup
 *
 * Call this early in the app startup, before any stores are initialized.
 * Returns true if cleanup was performed.
 */
export async function checkAndCleanupFreshInstall(): Promise<boolean> {
  // Skip in development mode
  if (!app.isPackaged) {
    console.log('[FreshInstall] Skipping fresh install check in dev mode');
    return false;
  }

  const bundleMtime = getAppBundleMtime();
  if (!bundleMtime) {
    console.log('[FreshInstall] Could not determine bundle mtime, skipping check');
    return false;
  }

  const currentMtimeStr = bundleMtime.toISOString();
  const currentVersion = app.getVersion();
  const existingMarker = readInstallMarker();

  // Case 1: No marker exists
  if (!existingMarker) {
    // Check if there's existing user data (from a previous install)
    const hadExistingData = hasExistingUserData();
    if (hadExistingData) {
      console.log('[FreshInstall] Found existing data but no install marker - this is a reinstall');
      clearPreviousInstallData();
    } else {
      console.log('[FreshInstall] First time install (no previous data)');
    }

    // Create the install marker
    writeInstallMarker({
      bundleMtime: currentMtimeStr,
      version: currentVersion,
      markerCreated: new Date().toISOString(),
    });

    return hadExistingData;
  }

  // Case 2: Marker exists, check if bundle has changed
  if (existingMarker.bundleMtime !== currentMtimeStr) {
    console.log('[FreshInstall] App bundle has changed since last run');
    console.log(`[FreshInstall]   Previous: ${existingMarker.bundleMtime}`);
    console.log(`[FreshInstall]   Current:  ${currentMtimeStr}`);

    // Clear old data
    clearPreviousInstallData();

    // Update the marker
    writeInstallMarker({
      bundleMtime: currentMtimeStr,
      version: currentVersion,
      markerCreated: new Date().toISOString(),
    });

    return true;
  }

  // Case 3: Same installation, no cleanup needed
  console.log('[FreshInstall] Same installation detected, no cleanup needed');
  return false;
}
