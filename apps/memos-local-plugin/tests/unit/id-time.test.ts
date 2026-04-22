import { describe, expect, it } from "vitest";

import { ids, newUuid, shortId } from "../../core/id.js";
import { formatDurationMs, hrNowMs, isoFromEpochMs, now, setNow } from "../../core/time.js";

describe("core/id", () => {
  it("uuid v7 is monotonically increasing in lexical order", () => {
    const a = newUuid();
    const b = newUuid();
    expect(b > a).toBe(true);
  });

  it("shortId only contains Crockford characters", () => {
    for (let i = 0; i < 100; i++) {
      const s = shortId(20);
      expect(s).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{20}$/);
    }
  });

  it("ids.* helpers prefix correctly", () => {
    expect(ids.trace()).toMatch(/^tr_/);
    expect(ids.episode()).toMatch(/^ep_/);
    expect(ids.session()).toMatch(/^se_/);
    expect(ids.policy()).toMatch(/^po_/);
    expect(ids.world()).toMatch(/^wm_/);
    expect(ids.skill()).toMatch(/^sk_/);
    expect(ids.feedback()).toMatch(/^fb_/);
    expect(ids.span()).toMatch(/^sp_/);
    expect(ids.trace_corr()).toMatch(/^co_/);
  });
});

describe("core/time", () => {
  it("setNow swaps the wall clock and restores", () => {
    const restore = setNow(() => 12345);
    try { expect(now()).toBe(12345); } finally { restore(); }
    expect(now()).not.toBe(12345);
  });

  it("hrNowMs is monotonically non-decreasing", () => {
    const a = hrNowMs();
    const b = hrNowMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("formatDurationMs renders human strings", () => {
    expect(formatDurationMs(0.5)).toMatch(/ms/);
    expect(formatDurationMs(45)).toBe("45ms");
    expect(formatDurationMs(3500)).toBe("3.50s");
    expect(formatDurationMs(95_000)).toBe("1m35s");
    expect(formatDurationMs(120_000)).toBe("2m");
    expect(formatDurationMs(NaN)).toBe("?");
  });

  it("isoFromEpochMs round-trips against Date", () => {
    const t = 1_700_000_000_000;
    expect(isoFromEpochMs(t)).toBe(new Date(t).toISOString());
  });
});
