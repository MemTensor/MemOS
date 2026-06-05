import { describe, expect, it } from "vitest";

import { isVisibleTo, visibilityWhere } from "../../../core/runtime/namespace.js";
import type { RuntimeNamespace } from "../../../agent-contract/dto.js";

describe("runtime/namespace", () => {
  const mainNs: RuntimeNamespace = {
    agentKind: "openclaw",
    profileId: "main",
  };

  it("keeps private memories isolated across unrelated profiles", () => {
    expect(
      isVisibleTo(
        {
          ownerAgentKind: "openclaw",
          ownerProfileId: "reviewer",
          share: { scope: "private" },
        },
        mainNs,
      ),
    ).toBe(false);
  });

  it("treats legacy default and main OpenClaw profiles as the same private owner", () => {
    expect(
      isVisibleTo(
        {
          ownerAgentKind: "openclaw",
          ownerProfileId: "default",
          share: { scope: "private" },
        },
        mainNs,
      ),
    ).toBe(true);

    expect(
      isVisibleTo(
        {
          ownerAgentKind: "openclaw",
          ownerProfileId: "main",
          share: { scope: "private" },
        },
        { agentKind: "openclaw", profileId: "default" },
      ),
    ).toBe(true);
  });

  it("does not merge default and main private profiles for other agents", () => {
    expect(
      isVisibleTo(
        {
          ownerAgentKind: "codex",
          ownerProfileId: "default",
          share: { scope: "private" },
        },
        { agentKind: "codex", profileId: "main" },
      ),
    ).toBe(false);
  });

  it("includes the legacy main/default pair in SQL visibility filters", () => {
    const vis = visibilityWhere(mainNs);
    expect(vis.sql).toContain("@vis_owner_agent_kind = 'openclaw'");
    expect(vis.sql).toContain("@vis_owner_profile_id IN ('main', @vis_default_profile_id)");
    expect(vis.sql).toContain("COALESCE(owner_profile_id, @vis_default_profile_id) IN ('main', @vis_default_profile_id)");
  });
});
