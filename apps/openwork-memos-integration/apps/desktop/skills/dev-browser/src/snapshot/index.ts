/**
 * ARIA Snapshot module for dev-browser.
 *
 * Provides Playwright-compatible ARIA snapshots with cross-connection ref persistence.
 * Refs are stored on window.__devBrowserRefs and survive across Playwright reconnections.
 *
 * Usage:
 *   import { getSnapshotScript } from './snapshot';
 *   const script = getSnapshotScript();
 *   await page.evaluate(script);
 *   // Now window.__devBrowser_getAISnapshot() and window.__devBrowser_selectSnapshotRef(ref) are available
 */

export { getSnapshotScript, clearSnapshotScriptCache } from "./browser-script";
