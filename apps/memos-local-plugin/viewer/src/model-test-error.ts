import { ApiError } from "./api/client";

export type ModelTestFailureKind = "viewer_offline" | "model_failure";

/**
 * Distinguish an unreachable Viewer backend from an upstream model failure.
 *
 * An ApiError means the Viewer returned an HTTP response, so the backend is
 * online even when the model provider rejected the request.  Transport-level
 * failures are verified with one health probe; an HTTP error from that probe
 * likewise proves that Viewer is reachable.
 */
export async function classifyModelTestFailure(
  error: unknown,
  healthProbe: () => Promise<unknown>,
): Promise<ModelTestFailureKind> {
  if (error instanceof ApiError) return "model_failure";

  try {
    await healthProbe();
    return "model_failure";
  } catch (healthError) {
    return healthError instanceof ApiError ? "model_failure" : "viewer_offline";
  }
}
