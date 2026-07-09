/**
 * Feedback endpoint.
 *
 * Explicit user feedback (thumbs up/down, corrections) from the
 * viewer. Accepts a partial `FeedbackDTO`; the core assigns `id` +
 * `ts` on write.
 */

import type { FeedbackDTO } from "../../agent-contract/dto.js";
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

export function registerFeedbackRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("POST /api/v1/feedback", async (ctx) => {
    const fb = parseJson<Partial<FeedbackDTO>>(ctx);
    if (!fb.channel) {
      writeError(ctx, 400, "invalid_argument", "channel is required");
      return;
    }
    if (!fb.polarity) {
      writeError(ctx, 400, "invalid_argument", "polarity is required");
      return;
    }
    if (fb.traceId) {
      const trace = await deps.core.getTrace(fb.traceId);
      if (!trace) {
        writeError(ctx, 404, "trace_not_found", `trace not found: ${fb.traceId}`);
        return;
      }
    }
    const out = await deps.core.submitFeedback({
      channel: fb.channel,
      polarity: fb.polarity,
      magnitude: typeof fb.magnitude === "number" ? fb.magnitude : 0,
      rationale: fb.rationale,
      raw: fb.raw,
      traceId: fb.traceId,
      episodeId: fb.episodeId,
      ts: fb.ts,
    });
    return out;
  });
}
