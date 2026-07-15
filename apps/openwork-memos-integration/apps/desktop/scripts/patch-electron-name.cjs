/**
 * Patches the Electron.app Info.plist to show "Openwork" instead of "Electron"
 * in macOS Cmd+Tab and Dock during development.
 */
const fs = require('fs');
const path = require('path');

const APP_NAME = 'Openwork';

// Only run on macOS
if (process.platform !== 'darwin') {
  console.log('[patch-electron-name] Skipping on non-macOS platform');
  process.exit(0);
}

const electronPath = path.join(
  __dirname,
  '../node_modules/electron/dist/Electron.app/Contents/Info.plist'
);

if (!fs.existsSync(electronPath)) {
  console.error('[patch-electron-name] Electron Info.plist not found:', electronPath);
  process.exit(1);
}

let plist = fs.readFileSync(electronPath, 'utf8');

// Check if already patched
if (plist.includes(`<string>${APP_NAME}</string>`)) {
  console.log(`[patch-electron-name] Already patched to "${APP_NAME}"`);
  process.exit(0);
}

// Replace CFBundleDisplayName and CFBundleName
plist = plist.replace(
  /<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/,
  `<key>CFBundleDisplayName</key>\n\t<string>${APP_NAME}</string>`
);

plist = plist.replace(
  /<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/,
  `<key>CFBundleName</key>\n\t<string>${APP_NAME}</string>`
);

fs.writeFileSync(electronPath, plist);
console.log(`[patch-electron-name] Patched Electron.app to show "${APP_NAME}"`);
