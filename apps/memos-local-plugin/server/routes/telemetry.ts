/**
 * Telemetry side-channel — endpoints invoked by the viewer to record
 * UI-side events (mounts, navigation) that the backend can't observe
 * on its own.
 *
 * Currently a single endpoint:
 *
 *   POST /api/v1/telemetry/viewer-opened
 *     Fired once by the viewer's `<App />` `useEffect` on mount. The
 *     handler delegates to `Telemetry.trackViewerOpened()`, which
 *     batches into the next ARMS flush. Body is ignored; future
 *     callers can pass page/source hints without breaking the wire
 *     format.
 *
 * Why a dedicated route instead of piggy-backing on
 * `GET /api/v1/overview` (the previous behaviour)?
 *   - The overview endpoint is also polled by background jobs and
 *     called from non-UI contexts; treating any GET as "user opened
 *     the viewer" produced both false positives and false negatives.
 *   - The previous in-memory `viewerTracked` flag was per-process, so
 *     bridge restarts re-counted the same operator and the metric
 *     drifted.
 *   - Tying to the actual SPA mount keeps the semantics honest:
 *     "someone loaded the viewer in a browser tab".
 *
 * The endpoint always returns `{ ok: true }` (even if telemetry is
 * disabled or no instance is bound), so the viewer can fire-and-forget
 * without surfacing failures to the UI.
 */

import type { ServerDeps } from "../types.js";
import type { Routes } from "./registry.js";

export function registerTelemetryRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("POST /api/v1/telemetry/viewer-opened", async () => {
    deps.telemetry?.trackViewerOpened();
    return { ok: true };
  });
}
