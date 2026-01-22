/**
 * Injectable snapshot script for browser context.
 *
 * This module provides the getSnapshotScript function that returns a
 * self-contained JavaScript string for injection into browser contexts.
 *
 * The script is injected via page.evaluate() and exposes:
 * - window.__devBrowser_getAISnapshot(): Returns ARIA snapshot YAML
 * - window.__devBrowser_selectSnapshotRef(ref): Returns element for given ref
 * - window.__devBrowserRefs: Map of ref -> Element (persists across connections)
 */

export { getSnapshotScript, clearSnapshotScriptCache } from "./browser-script";
