/**
 * Shared episode-status derivation — unit tests.
 *
 * Pins the classification rules used by both the HTTP server's
 * `GET /api/v1/episodes?status=…` filter and the viewer's task-status
 * chip group. The two consumers must agree on every branch, so the
 * tests cover each rule in `deriveEpisodeStatus` explicitly.
 */
import { describe, expect, it } from "vitest";

import {
  ACTIVE_GRACE_WINDOW_MS,
  R_NEGATIVE_FLOOR,
  deriveEpisodeStatus,
  parseTaskStatusFilter,
} from "../../../agent-contract/episode-status.js";
import type { EpisodeListItemDTO } from "../../../agent-contract/dto.js";

function row(overrides: Partial<EpisodeListItemDTO> = {}): EpisodeListItemDTO {
  return {
    id: "e1",
    sessionId: "s1",
    startedAt: 0,
    status: "closed",
    turnCount: 0,
    ...overrides,
  } as EpisodeListItemDTO;
}

describe("deriveEpisodeStatus", () => {
  const NOW = 1_000_000;

  it("returns active for open episodes", () => {
    expect(deriveEpisodeStatus(row({ status: "open" }), NOW)).toBe("active");
  });

  it("returns active inside the recently-finalized grace window", () => {
    expect(
      deriveEpisodeStatus(
        row({
          status: "closed",
          closeReason: "finalized",
          endedAt: NOW - 1,
        }),
        NOW,
      ),
    ).toBe("active");
  });

  it("falls out of active once the grace window has fully elapsed", () => {
    expect(
      deriveEpisodeStatus(
        row({
          status: "closed",
          closeReason: "finalized",
          endedAt: NOW - ACTIVE_GRACE_WINDOW_MS - 1,
          turnCount: 4,
        }),
        NOW,
      ),
    ).toBe("completed");
  });

  it("classifies clearly-negative rTask as failed", () => {
    expect(
      deriveEpisodeStatus(
        row({
          rTask: R_NEGATIVE_FLOOR - 0.01,
          closeReason: "finalized",
          endedAt: NOW - ACTIVE_GRACE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe("failed");
  });

  it("treats slight negatives above the floor as completed (soft-fail)", () => {
    expect(
      deriveEpisodeStatus(
        row({
          rTask: R_NEGATIVE_FLOOR + 0.01,
          closeReason: "finalized",
          endedAt: NOW - ACTIVE_GRACE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe("completed");
  });

  it("returns skipped when reward pipeline opted out", () => {
    expect(
      deriveEpisodeStatus(
        row({
          status: "closed",
          rewardSkipped: true,
          closeReason: "finalized",
          endedAt: NOW - ACTIVE_GRACE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe("skipped");
  });

  it("returns completed when a skill was generated, even with null rTask", () => {
    expect(
      deriveEpisodeStatus(
        row({
          status: "closed",
          skillStatus: "generated",
          closeReason: "finalized",
          endedAt: NOW - ACTIVE_GRACE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe("completed");
  });

  it("returns skipped when episode was abandoned and no other signal", () => {
    expect(
      deriveEpisodeStatus(
        row({
          status: "closed",
          closeReason: "abandoned",
          endedAt: NOW - ACTIVE_GRACE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe("skipped");
  });

  it("returns completed when ≥2 user turns even without a reward", () => {
    expect(
      deriveEpisodeStatus(
        row({
          status: "closed",
          turnCount: 2,
          closeReason: "finalized",
          endedAt: NOW - ACTIVE_GRACE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe("completed");
  });

  it("falls back to skipped for short, unscored episodes", () => {
    expect(
      deriveEpisodeStatus(
        row({
          status: "closed",
          turnCount: 1,
          closeReason: "finalized",
          endedAt: NOW - ACTIVE_GRACE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe("skipped");
  });
});

describe("parseTaskStatusFilter", () => {
  it("accepts known status slugs verbatim", () => {
    for (const slug of ["active", "completed", "skipped", "failed"] as const) {
      expect(parseTaskStatusFilter(slug)).toBe(slug);
    }
  });

  it("collapses unknown / empty / null to no-filter", () => {
    expect(parseTaskStatusFilter(null)).toBe("");
    expect(parseTaskStatusFilter(undefined)).toBe("");
    expect(parseTaskStatusFilter("")).toBe("");
    expect(parseTaskStatusFilter("nonsense")).toBe("");
    expect(parseTaskStatusFilter("FAILED")).toBe("");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(parseTaskStatusFilter("  failed  ")).toBe("failed");
  });
});
