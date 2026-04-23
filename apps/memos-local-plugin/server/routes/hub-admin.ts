/**
 * Hub admin endpoint stub.
 *
 * Returns a shape the viewer's Admin view understands. When the user
 * hasn't enabled team sharing, we just send back `{enabled: false}` —
 * the UI has a dedicated onboarding empty state for that path.
 *
 * When sharing IS enabled, we still return an empty `pending/users/
 * groups` list for now: the `core/hub/` runtime is a stub, and wiring
 * in real sync state is a separate phase.
 */
import type { ServerDeps } from "../types.js";
import type { Routes } from "./registry.js";

export function registerHubAdminRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/hub/admin", async () => {
    const config = await deps.core.getConfig();
    const hub = (config?.hub ?? {}) as {
      enabled?: boolean;
      role?: "hub" | "client";
    };
    if (!hub.enabled) {
      return { enabled: false };
    }
    return {
      enabled: true,
      role: hub.role ?? "client",
      pending: [],
      users: [],
      groups: [],
    };
  });
}
