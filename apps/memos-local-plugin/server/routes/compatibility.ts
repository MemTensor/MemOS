/**
 * Compatibility diagnostics route.
 *
 * This is a read-only surface used to explain which integration paradigm
 * a host can take and why. It is intentionally simple so future adapters
 * and installers can reuse the same evaluator.
 */

import type { ServerDeps } from "../types.js";
import type { Routes } from "./registry.js";
import { parseJson } from "./registry.js";
import {
  assessCompatibility,
  listCompatibilityCapabilities,
  supportMatrixFor,
  type CompatibilityAssessmentInput,
} from "../../core/index.js";

export function registerCompatibilityRoutes(
  routes: Routes,
  deps: ServerDeps,
): void {
  routes.set("GET /api/v1/compatibility/capabilities", () => ({
    capabilities: listCompatibilityCapabilities(),
  }));

  routes.set("POST /api/v1/compatibility/assess", (ctx) => {
    const input = parseJson<CompatibilityAssessmentInput>(ctx);
    return assessCompatibility(input);
  });

  routes.set("GET /api/v1/compatibility/matrix", (ctx) => {
    const mode = ctx.url.searchParams.get("mode");
    const matrix = supportMatrixFor(
      normalizeMode(mode),
    );
    return {
      mode: normalizeMode(mode),
      matrix,
    };
  });

  void deps;
}

function normalizeMode(
  mode: string | null,
): "native-integration" | "hook-plugin" | "mcp" | "rest-sdk" | "wrapper-proxy" | "historical-connector" | null {
  if (
    mode === "native-integration" ||
    mode === "hook-plugin" ||
    mode === "mcp" ||
    mode === "rest-sdk" ||
    mode === "wrapper-proxy" ||
    mode === "historical-connector"
  ) {
    return mode;
  }
  return null;
}
