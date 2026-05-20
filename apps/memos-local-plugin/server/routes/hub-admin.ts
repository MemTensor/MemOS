import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

export function registerHubAdminRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/hub/admin", async () => {
    if (deps.core.hubAdminSnapshot) {
      return await deps.core.hubAdminSnapshot();
    }
    const config = await deps.core.getConfig();
    const hub = (config?.hub ?? {}) as { enabled?: boolean; role?: "hub" | "client" };
    return {
      enabled: !!hub.enabled,
      role: hub.role ?? "client",
      pending: [],
      users: [],
      groups: [],
    };
  });

  routes.set("GET /api/v1/hub/status", async () => {
    if (deps.core.hubAdminSnapshot) {
      return await deps.core.hubAdminSnapshot();
    }
    return { enabled: false };
  });

  routes.set("POST /api/v1/hub/admin/approve-user", async (ctx) => {
    const body = parseJson<{ userId?: string }>(ctx);
    const userId = String(body.userId || "");
    if (!userId) {
      writeError(ctx, 400, "invalid_argument", "userId is required");
      return;
    }
    const result = await deps.core.approveHubUser?.(userId);
    if (!result || (typeof result === "object" && (result as { ok?: boolean }).ok === false)) {
      writeError(ctx, 404, "not_found", `hub user not found: ${userId}`);
      return;
    }
    return result;
  });

  routes.set("POST /api/v1/hub/admin/reject-user", async (ctx) => {
    const body = parseJson<{ userId?: string }>(ctx);
    const userId = String(body.userId || "");
    if (!userId) {
      writeError(ctx, 400, "invalid_argument", "userId is required");
      return;
    }
    const result = await deps.core.rejectHubUser?.(userId);
    if (!result || (typeof result === "object" && (result as { ok?: boolean }).ok === false)) {
      writeError(ctx, 404, "not_found", `hub user not found: ${userId}`);
      return;
    }
    return result;
  });

  routes.set("POST /api/v1/hub/admin/remove-user", async (ctx) => {
    const body = parseJson<{ userId?: string }>(ctx);
    const userId = String(body.userId || "");
    if (!userId) {
      writeError(ctx, 400, "invalid_argument", "userId is required");
      return;
    }
    const result = await deps.core.removeHubUser?.(userId);
    if (!result || (typeof result === "object" && (result as { ok?: boolean }).ok === false)) {
      writeError(ctx, 404, "not_found", `hub user not found: ${userId}`);
      return;
    }
    return result;
  });
}
