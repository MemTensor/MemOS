import { describe, expect, it, vi } from "vitest";

import { startOptionalViewer } from "../../../adapters/openclaw/runtime-viewer.js";

describe("OpenClaw shared runtime Viewer", () => {
  it("continues headless when the fixed Viewer port is occupied", async () => {
    const inUse = Object.assign(new Error("address already in use"), {
      code: "EADDRINUSE",
    });
    const onPortInUse = vi.fn();

    await expect(
      startOptionalViewer(async () => {
        throw inUse;
      }, onPortInUse),
    ).resolves.toBeNull();
    expect(onPortInUse).toHaveBeenCalledOnce();
  });

  it("does not hide unrelated Viewer startup failures", async () => {
    const failure = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });

    await expect(
      startOptionalViewer(async () => {
        throw failure;
      }, vi.fn()),
    ).rejects.toBe(failure);
  });
});
