import { chromium, type Browser, type Page, type ElementHandle } from "playwright";
import type {
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
  ViewportSize,
} from "./types";
import { getSnapshotScript } from "./snapshot/browser-script";

/**
 * Fetch with retry and exponential backoff for handling concurrent connection issues.
 * This is necessary when multiple tasks try to connect to the dev-browser server simultaneously.
 */
async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 3,
  baseDelayMs = 100
): Promise<Response> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Only retry on connection errors (socket closed, etc.)
      const isConnectionError = lastError.message.includes("fetch failed") ||
        lastError.message.includes("ECONNREFUSED") ||
        lastError.message.includes("socket") ||
        lastError.message.includes("UND_ERR");
      if (!isConnectionError || i >= maxRetries - 1) {
        throw lastError;
      }
      // Exponential backoff with jitter
      const delay = baseDelayMs * Math.pow(2, i) + Math.random() * 50;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error("fetchWithRetry failed");
}

/**
 * Options for waiting for page load
 */
export interface WaitForPageLoadOptions {
  /** Maximum time to wait in ms (default: 10000) */
  timeout?: number;
  /** How often to check page state in ms (default: 50) */
  pollInterval?: number;
  /** Minimum time to wait even if page appears ready in ms (default: 100) */
  minimumWait?: number;
  /** Wait for network to be idle (no pending requests) (default: true) */
  waitForNetworkIdle?: boolean;
}

/**
 * Result of waiting for page load
 */
export interface WaitForPageLoadResult {
  /** Whether the page is considered loaded */
  success: boolean;
  /** Document ready state when finished */
  readyState: string;
  /** Number of pending network requests when finished */
  pendingRequests: number;
  /** Time spent waiting in ms */
  waitTimeMs: number;
  /** Whether timeout was reached */
  timedOut: boolean;
}

interface PageLoadState {
  documentReadyState: string;
  documentLoading: boolean;
  pendingRequests: PendingRequest[];
}

interface PendingRequest {
  url: string;
  loadingDurationMs: number;
  resourceType: string;
}

/**
 * Wait for a page to finish loading using document.readyState and performance API.
 *
 * Uses browser-use's approach of:
 * - Checking document.readyState for 'complete'
 * - Monitoring pending network requests via Performance API
 * - Filtering out ads, tracking, and non-critical resources
 * - Graceful timeout handling (continues even if timeout reached)
 */
export async function waitForPageLoad(
  page: Page,
  options: WaitForPageLoadOptions = {}
): Promise<WaitForPageLoadResult> {
  const {
    timeout = 10000,
    pollInterval = 50,
    minimumWait = 100,
    waitForNetworkIdle = true,
  } = options;

  const startTime = Date.now();
  let lastState: PageLoadState | null = null;

  // Wait minimum time first
  if (minimumWait > 0) {
    await new Promise((resolve) => setTimeout(resolve, minimumWait));
  }

  // Poll until ready or timeout
  while (Date.now() - startTime < timeout) {
    try {
      lastState = await getPageLoadState(page);

      // Check if document is complete
      const documentReady = lastState.documentReadyState === "complete";

      // Check if network is idle (no pending critical requests)
      const networkIdle = !waitForNetworkIdle || lastState.pendingRequests.length === 0;

      if (documentReady && networkIdle) {
        return {
          success: true,
          readyState: lastState.documentReadyState,
          pendingRequests: lastState.pendingRequests.length,
          waitTimeMs: Date.now() - startTime,
          timedOut: false,
        };
      }
    } catch {
      // Page may be navigating, continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout reached - return current state
  return {
    success: false,
    readyState: lastState?.documentReadyState ?? "unknown",
    pendingRequests: lastState?.pendingRequests.length ?? 0,
    waitTimeMs: Date.now() - startTime,
    timedOut: true,
  };
}

/**
 * Get the current page load state including document ready state and pending requests.
 * Filters out ads, tracking, and non-critical resources that shouldn't block loading.
 */
async function getPageLoadState(page: Page): Promise<PageLoadState> {
  const result = await page.evaluate(() => {
    // Access browser globals via globalThis for TypeScript compatibility
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const g = globalThis as { document?: any; performance?: any };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const perf = g.performance!;
    const doc = g.document!;

    const now = perf.now();
    const resources = perf.getEntriesByType("resource");
    const pending: Array<{ url: string; loadingDurationMs: number; resourceType: string }> = [];

    // Common ad/tracking domains and patterns to filter out
    const adPatterns = [
      "doubleclick.net",
      "googlesyndication.com",
      "googletagmanager.com",
      "google-analytics.com",
      "facebook.net",
      "connect.facebook.net",
      "analytics",
      "ads",
      "tracking",
      "pixel",
      "hotjar.com",
      "clarity.ms",
      "mixpanel.com",
      "segment.com",
      "newrelic.com",
      "nr-data.net",
      "/tracker/",
      "/collector/",
      "/beacon/",
      "/telemetry/",
      "/log/",
      "/events/",
      "/track.",
      "/metrics/",
    ];

    // Non-critical resource types
    const nonCriticalTypes = ["img", "image", "icon", "font"];

    for (const entry of resources) {
      // Resources with responseEnd === 0 are still loading
      if (entry.responseEnd === 0) {
        const url = entry.name;

        // Filter out ads and tracking
        const isAd = adPatterns.some((pattern) => url.includes(pattern));
        if (isAd) continue;

        // Filter out data: URLs and very long URLs
        if (url.startsWith("data:") || url.length > 500) continue;

        const loadingDuration = now - entry.startTime;

        // Skip requests loading > 10 seconds (likely stuck/polling)
        if (loadingDuration > 10000) continue;

        const resourceType = entry.initiatorType || "unknown";

        // Filter out non-critical resources loading > 3 seconds
        if (nonCriticalTypes.includes(resourceType) && loadingDuration > 3000) continue;

        // Filter out image URLs even if type is unknown
        const isImageUrl = /\.(jpg|jpeg|png|gif|webp|svg|ico)(\?|$)/i.test(url);
        if (isImageUrl && loadingDuration > 3000) continue;

        pending.push({
          url,
          loadingDurationMs: Math.round(loadingDuration),
          resourceType,
        });
      }
    }

    return {
      documentReadyState: doc.readyState,
      documentLoading: doc.readyState !== "complete",
      pendingRequests: pending,
    };
  });

  return result;
}

/** Server mode information */
export interface ServerInfo {
  wsEndpoint: string;
  mode: "launch" | "extension";
  extensionConnected?: boolean;
}

/**
 * Options for creating or getting a page
 */
export interface PageOptions {
  /** Viewport size for new pages */
  viewport?: ViewportSize;
}

export interface DevBrowserClient {
  page: (name: string, options?: PageOptions) => Promise<Page>;
  list: () => Promise<string[]>;
  close: (name: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Get AI-friendly ARIA snapshot for a page.
   * Returns YAML format with refs like [ref=e1], [ref=e2].
   * Refs are stored on window.__devBrowserRefs for cross-connection persistence.
   */
  getAISnapshot: (name: string) => Promise<string>;
  /**
   * Get an element handle by its ref from the last getAISnapshot call.
   * Refs persist across Playwright connections.
   */
  selectSnapshotRef: (name: string, ref: string) => Promise<ElementHandle | null>;
  /**
   * Get server information including mode and extension connection status.
   */
  getServerInfo: () => Promise<ServerInfo>;
}

// Accomplish uses port 9224 to avoid conflicts with Claude Code's dev-browser (9222)
export async function connect(serverUrl = "http://localhost:9224"): Promise<DevBrowserClient> {
  let browser: Browser | null = null;
  let wsEndpoint: string | null = null;
  let connectingPromise: Promise<Browser> | null = null;

  async function ensureConnected(): Promise<Browser> {
    // Return existing connection if still active
    if (browser && browser.isConnected()) {
      return browser;
    }

    // If already connecting, wait for that connection (prevents race condition)
    if (connectingPromise) {
      return connectingPromise;
    }

    // Start new connection with mutex
    connectingPromise = (async () => {
      try {
        // Fetch wsEndpoint from server (with retry for concurrent connections)
        const res = await fetchWithRetry(serverUrl);
        if (!res.ok) {
          throw new Error(`Server returned ${res.status}: ${await res.text()}`);
        }
        const info = (await res.json()) as ServerInfoResponse;
        wsEndpoint = info.wsEndpoint;

        // Connect to the browser via CDP
        browser = await chromium.connectOverCDP(wsEndpoint);
        return browser;
      } finally {
        connectingPromise = null;
      }
    })();

    return connectingPromise;
  }

  // Find page by CDP targetId - more reliable than JS globals
  async function findPageByTargetId(b: Browser, targetId: string): Promise<Page | null> {
    for (const context of b.contexts()) {
      for (const page of context.pages()) {
        let cdpSession;
        try {
          cdpSession = await context.newCDPSession(page);
          const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
          if (targetInfo.targetId === targetId) {
            return page;
          }
        } catch (err) {
          // Only ignore "target closed" errors, log unexpected ones
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Target closed") && !msg.includes("Session closed")) {
            console.warn(`Unexpected error checking page target: ${msg}`);
          }
        } finally {
          if (cdpSession) {
            try {
              await cdpSession.detach();
            } catch {
              // Ignore detach errors - session may already be closed
            }
          }
        }
      }
    }
    return null;
  }

  // Helper to get a page by name (used by multiple methods)
  async function getPage(name: string, options?: PageOptions): Promise<Page> {
    // Request the page from server (creates if doesn't exist)
    // Use fetchWithRetry for concurrent connection resilience
    const res = await fetchWithRetry(`${serverUrl}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, viewport: options?.viewport } satisfies GetPageRequest),
    });

    if (!res.ok) {
      throw new Error(`Failed to get page: ${await res.text()}`);
    }

    const pageInfo = (await res.json()) as GetPageResponse & { url?: string };
    const { targetId } = pageInfo;

    // Connect to browser
    const b = await ensureConnected();

    // Check if we're in extension mode
    const infoRes = await fetchWithRetry(serverUrl);
    const info = (await infoRes.json()) as { mode?: string };
    const isExtensionMode = info.mode === "extension";

    if (isExtensionMode) {
      // In extension mode, DON'T use findPageByTargetId as it corrupts page state
      // Instead, find page by URL or use the only available page
      const allPages = b.contexts().flatMap((ctx) => ctx.pages());

      if (allPages.length === 0) {
        throw new Error(`No pages available in browser`);
      }

      if (allPages.length === 1) {
        return allPages[0]!;
      }

      // Multiple pages - try to match by URL if available
      if (pageInfo.url) {
        const matchingPage = allPages.find((p) => p.url() === pageInfo.url);
        if (matchingPage) {
          return matchingPage;
        }
      }

      // Fall back to first page
      if (!allPages[0]) {
        throw new Error(`No pages available in browser`);
      }
      return allPages[0];
    }

    // In launch mode, use the original targetId-based lookup
    const page = await findPageByTargetId(b, targetId);
    if (!page) {
      throw new Error(`Page "${name}" not found in browser contexts`);
    }

    return page;
  }

  return {
    page: getPage,

    async list(): Promise<string[]> {
      const res = await fetchWithRetry(`${serverUrl}/pages`);
      const data = (await res.json()) as ListPagesResponse;
      return data.pages;
    },

    async close(name: string): Promise<void> {
      const res = await fetchWithRetry(`${serverUrl}/pages/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        throw new Error(`Failed to close page: ${await res.text()}`);
      }
    },

    async disconnect(): Promise<void> {
      // Just disconnect the CDP connection - pages persist on server
      if (browser) {
        await browser.close();
        browser = null;
      }
    },

    async getAISnapshot(name: string): Promise<string> {
      // Get the page
      const page = await getPage(name);

      // Inject the snapshot script and call getAISnapshot
      const snapshotScript = getSnapshotScript();
      const snapshot = await page.evaluate((script: string) => {
        // Inject script if not already present
        // Note: page.evaluate runs in browser context where window exists
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        if (!w.__devBrowser_getAISnapshot) {
          // eslint-disable-next-line no-eval
          eval(script);
        }
        return w.__devBrowser_getAISnapshot();
      }, snapshotScript);

      return snapshot;
    },

    async selectSnapshotRef(name: string, ref: string): Promise<ElementHandle | null> {
      // Get the page
      const page = await getPage(name);

      // Find the element using the stored refs
      const elementHandle = await page.evaluateHandle((refId: string) => {
        // Note: page.evaluateHandle runs in browser context where globalThis is the window
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        const refs = w.__devBrowserRefs;
        if (!refs) {
          throw new Error("No snapshot refs found. Call getAISnapshot first.");
        }
        const element = refs[refId];
        if (!element) {
          throw new Error(
            `Ref "${refId}" not found. Available refs: ${Object.keys(refs).join(", ")}`
          );
        }
        return element;
      }, ref);

      // Check if we got an element
      const element = elementHandle.asElement();
      if (!element) {
        await elementHandle.dispose();
        return null;
      }

      return element;
    },

    async getServerInfo(): Promise<ServerInfo> {
      const res = await fetchWithRetry(serverUrl);
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}: ${await res.text()}`);
      }
      const info = (await res.json()) as {
        wsEndpoint: string;
        mode?: string;
        extensionConnected?: boolean;
      };
      return {
        wsEndpoint: info.wsEndpoint,
        mode: (info.mode as "launch" | "extension") ?? "launch",
        extensionConnected: info.extensionConnected,
      };
    },
  };
}
