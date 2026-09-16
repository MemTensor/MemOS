/**
 * Lock the semantics of the ONE shared
 * exact-owner predicate (`isExactOwner` in `core/storage/repos/_helpers.ts`)
 * reused by the evidence union reconcile and the preview/rollback paths.
 *
 * No semantics change from the two hand-written copies it replaced:
 * NULL-tolerant `??` fallbacks (unknown/default/NULL) and NULL-exact
 * workspace matching (Gate 2 — NULL never acts as a wildcard).
 */

import { describe, expect, it } from "vitest";

import { isExactOwner } from "../../../core/storage/repos/_helpers.js";

describe("storage/repos — isExactOwner (shared exact-namespace predicate)", () => {
  it("matches an identical triple", () => {
    expect(
      isExactOwner(
        { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: "ws_a" },
        { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: "ws_a" },
      ),
    ).toBe(true);
  });

  it("applies NULL-tolerant fallbacks (unknown/default/NULL)", () => {
    expect(
      isExactOwner(
        {},
        { ownerAgentKind: "unknown", ownerProfileId: "default", ownerWorkspaceId: null },
      ),
    ).toBe(true);
    expect(
      isExactOwner(
        { ownerAgentKind: null, ownerProfileId: null, ownerWorkspaceId: null },
        { ownerAgentKind: "unknown", ownerProfileId: "default" },
      ),
    ).toBe(true);
  });

  it("rejects kind/profile mismatches", () => {
    const row = { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: null };
    expect(isExactOwner(row, { ownerAgentKind: "hermes", ownerProfileId: "default" })).toBe(false);
    expect(isExactOwner(row, { ownerAgentKind: "openclaw", ownerProfileId: "other" })).toBe(false);
  });

  it("is workspace-exact: NULL never matches a named workspace and vice versa", () => {
    expect(
      isExactOwner(
        { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: null },
        { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: "ws_a" },
      ),
    ).toBe(false);
    expect(
      isExactOwner(
        { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: "ws_a" },
        { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: null },
      ),
    ).toBe(false);
    expect(
      isExactOwner(
        { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: "ws_a" },
        { ownerAgentKind: "openclaw", ownerProfileId: "default", ownerWorkspaceId: "ws_b" },
      ),
    ).toBe(false);
  });

  it("keeps empty strings as-is (??, not ||): '' never falls back to 'unknown'", () => {
    expect(
      isExactOwner(
        { ownerAgentKind: "", ownerProfileId: "default", ownerWorkspaceId: null },
        { ownerAgentKind: "unknown", ownerProfileId: "default", ownerWorkspaceId: null },
      ),
    ).toBe(false);
    expect(
      isExactOwner(
        { ownerAgentKind: "", ownerProfileId: "default", ownerWorkspaceId: null },
        { ownerAgentKind: "", ownerProfileId: "default", ownerWorkspaceId: null },
      ),
    ).toBe(true);
  });
});
