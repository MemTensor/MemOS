import { describe, expect, it, vi } from "vitest";

import { saveSettingsAndRestart } from "../../../viewer/src/settings-save";

describe("settings save flow", () => {
  it("applies the saved server config before starting the restart", async () => {
    const events: string[] = [];
    const saved = {
      embedding: {
        provider: "local",
        model: "Xenova/all-MiniLM-L6-v2",
      },
    };
    const persist = vi.fn(async () => {
      events.push("persist");
      return saved;
    });
    const applySaved = vi.fn((value: typeof saved) => {
      events.push("apply");
      expect(value).toBe(saved);
    });
    const restart = vi.fn(async () => {
      events.push("restart");
    });

    await saveSettingsAndRestart(saved, persist, applySaved, restart);

    expect(events).toEqual(["persist", "apply", "restart"]);
    expect(applySaved).toHaveBeenCalledWith(saved);
  });
});
