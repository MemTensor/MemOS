import { describe, expect, it } from "vitest";
import {
  createTeamToken,
  issueUserToken,
  verifyTeamToken,
  verifyUserToken,
} from "../src/hub/auth";

describe("hub auth", () => {
  it("should create and verify a team token", () => {
    const token = createTeamToken("team-secret");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
    expect(verifyTeamToken(token, "team-secret")).toBe(true);
    expect(verifyTeamToken(token, "wrong-secret")).toBe(false);
  });

  it("should issue and verify a user token", () => {
    const token = issueUserToken(
      {
        userId: "user-1",
        username: "alice",
        role: "admin",
        status: "active",
      },
      "team-secret",
      60_000,
    );

    const verified = verifyUserToken(token, "team-secret");
    expect(verified).not.toBeNull();
    expect(verified!.userId).toBe("user-1");
    expect(verified!.username).toBe("alice");
    expect(verified!.role).toBe("admin");
    expect(verified!.status).toBe("active");
  });

  it("should reject expired or tampered user tokens", async () => {
    const token = issueUserToken(
      {
        userId: "user-2",
        username: "bob",
        role: "member",
        status: "active",
      },
      "team-secret",
      1,
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(verifyUserToken(token, "team-secret")).toBeNull();

    const valid = issueUserToken(
      {
        userId: "user-3",
        username: "carol",
        role: "member",
        status: "active",
      },
      "team-secret",
      60_000,
    );
    const tampered = valid.replace(/.$/, valid.endsWith("a") ? "b" : "a");
    expect(verifyUserToken(tampered, "team-secret")).toBeNull();
  });
});
