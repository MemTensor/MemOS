import { randomUUID, createHash } from "crypto";
import { issueUserToken, verifyUserToken } from "./auth";
import type { Logger } from "../types";
import type { UserInfo } from "../sharing/types";
import type { SqliteStore } from "../storage/sqlite";

type ManagedHubUser = UserInfo & {
  tokenHash: string;
  createdAt: number;
  approvedAt: number | null;
  lastIp: string;
  lastActiveAt: number | null;
  identityKey?: string;
  leftAt?: number | null;
  removedAt?: number | null;
  rejectedAt?: number | null;
  rejoinRequestedAt?: number | null;
};

export class HubUserManager {
  constructor(private store: SqliteStore, private log: Logger) {}

  createPendingUser(input: { username: string; deviceName?: string; identityKey?: string }): ManagedHubUser {
    const user: ManagedHubUser = {
      id: randomUUID(),
      username: input.username,
      deviceName: input.deviceName,
      role: "member" as const,
      status: "pending" as const,
      groups: [],
      tokenHash: "",
      createdAt: Date.now(),
      approvedAt: null,
      lastIp: "",
      lastActiveAt: null,
      identityKey: input.identityKey || "",
    };
    this.store.upsertHubUser(user);
    return user;
  }

  findByIdentityKey(identityKey: string): ManagedHubUser | null {
    if (!identityKey) return null;
    return this.store.findHubUserByIdentityKey(identityKey);
  }

  markUserLeft(userId: string): boolean {
    this.log.info(`Hub: user "${userId}" marked as left`);
    return this.store.markHubUserLeft(userId);
  }

  rejoinUser(userId: string): ManagedHubUser | null {
    const user = this.store.getHubUser(userId);
    if (!user) return null;
    const updated: ManagedHubUser = {
      ...user,
      status: "pending" as const,
      tokenHash: "",
      rejoinRequestedAt: Date.now(),
    };
    this.store.upsertHubUser(updated);
    this.log.info(`Hub: user "${userId}" (${user.username}) requested rejoin, previous status: ${user.status}`);
    return updated;
  }

  listPendingUsers(): ManagedHubUser[] {
    return this.store.listHubUsers("pending");
  }

  approveUser(userId: string, token: string): ManagedHubUser | null {
    const user = this.store.getHubUser(userId);
    if (!user) return null;
    const updated = {
      ...user,
      status: "active" as const,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      approvedAt: Date.now(),
    };
    this.store.upsertHubUser(updated);
    return updated;
  }

  ensureBootstrapAdmin(secret: string, username = "admin", bootstrapUserId?: string, bootstrapToken?: string): { user: ManagedHubUser; token: string } {
    if (bootstrapUserId) {
      const bootstrapUser = this.store.getHubUser(bootstrapUserId);
      if (bootstrapUser && bootstrapUser.role === "admin" && bootstrapUser.status === "active") {
        if (bootstrapToken && bootstrapUser.tokenHash === createHash("sha256").update(bootstrapToken).digest("hex") && verifyUserToken(bootstrapToken, secret)) {
          return { user: bootstrapUser, token: bootstrapToken };
        }
        const refreshedToken = issueUserToken(
          { userId: bootstrapUser.id, username: bootstrapUser.username, role: bootstrapUser.role, status: bootstrapUser.status },
          secret,
          3650 * 24 * 60 * 60 * 1000,
        );
        const refreshedUser: ManagedHubUser = {
          ...bootstrapUser,
          tokenHash: createHash("sha256").update(refreshedToken).digest("hex"),
        };
        this.store.upsertHubUser(refreshedUser);
        return { user: refreshedUser, token: refreshedToken };
      }
    }

    const existing = this.store.listHubUsers().find((user) => user.role === "admin" && user.status === "active");
    if (existing) {
      const refreshedToken = issueUserToken(
        { userId: existing.id, username: existing.username, role: existing.role, status: existing.status },
        secret,
        3650 * 24 * 60 * 60 * 1000,
      );
      const refreshedUser: ManagedHubUser = {
        ...existing,
        tokenHash: createHash("sha256").update(refreshedToken).digest("hex"),
      };
      this.store.upsertHubUser(refreshedUser);
      return { user: refreshedUser, token: refreshedToken };
    }

    const user: ManagedHubUser = {
      id: randomUUID(),
      username,
      deviceName: "hub",
      role: "admin",
      status: "active",
      groups: [],
      tokenHash: "",
      createdAt: Date.now(),
      approvedAt: Date.now(),
      lastIp: "",
      lastActiveAt: null,
    };
    const token = issueUserToken(
      { userId: user.id, username: user.username, role: user.role, status: user.status },
      secret,
      3650 * 24 * 60 * 60 * 1000,
    );
    user.tokenHash = createHash("sha256").update(token).digest("hex");
    this.store.upsertHubUser(user);
    return { user, token };
  }

  isUsernameTaken(username: string, excludeUserId?: string): boolean {
    const users = this.store.listHubUsers();
    return users.some(u => u.username === username && u.id !== excludeUserId && u.status !== "left" && u.status !== "removed");
  }

  updateUsername(userId: string, newUsername: string): ManagedHubUser | null {
    const user = this.store.getHubUser(userId);
    if (!user) return null;
    const updated = { ...user, username: newUsername };
    this.store.upsertHubUser(updated);
    return updated;
  }

  rejectUser(userId: string): ManagedHubUser | null {
    const user = this.store.getHubUser(userId);
    if (!user) return null;
    const updated: ManagedHubUser = {
      ...user,
      status: "rejected" as const,
      rejectedAt: Date.now(),
    };
    this.store.upsertHubUser(updated);
    return updated;
  }

  resetToPending(userId: string): ManagedHubUser | null {
    const user = this.store.getHubUser(userId);
    if (!user) return null;
    const updated = {
      ...user,
      status: "pending" as const,
      tokenHash: "",
      approvedAt: null,
    };
    this.store.upsertHubUser(updated);
    return updated;
  }
}
