import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../../viewer/src/api/client";
import { classifyModelTestFailure } from "../../../viewer/src/model-test-error";

describe("classifyModelTestFailure", () => {
  it("keeps backend model errors distinct from Viewer availability", async () => {
    const healthProbe = vi.fn();
    const result = await classifyModelTestFailure(
      new ApiError("model_test_failed", "upstream model rejected the request", 502),
      healthProbe,
    );

    expect(result).toBe("model_failure");
    expect(healthProbe).not.toHaveBeenCalled();
  });

  it("reports a model failure when Viewer still answers health", async () => {
    const result = await classifyModelTestFailure(
      new TypeError("Failed to fetch"),
      async () => ({ ok: true }),
    );

    expect(result).toBe("model_failure");
  });

  it("treats an HTTP health error as proof that Viewer is online", async () => {
    const result = await classifyModelTestFailure(
      new TypeError("Failed to fetch"),
      async () => {
        throw new ApiError("unauthorized", "Unauthorized", 401);
      },
    );

    expect(result).toBe("model_failure");
  });

  it("reports Viewer offline only when both requests have a transport failure", async () => {
    const result = await classifyModelTestFailure(
      new TypeError("Failed to fetch"),
      async () => {
        throw new TypeError("Failed to fetch");
      },
    );

    expect(result).toBe("viewer_offline");
  });
});
