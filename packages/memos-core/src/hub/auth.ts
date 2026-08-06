import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { UserRole, UserStatus } from "../sharing/types";

type UserTokenPayload = {
  userId: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  exp: number;
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function unbase64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function sign(value: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(value).digest());
}

export function createTeamToken(secret: string): string {
  const nonce = base64url(randomBytes(12));
  const body = `team.${nonce}`;
  return `${body}.${sign(body, secret)}`;
}

export function verifyTeamToken(token: string, secret: string): boolean {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return false;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(body, secret);
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function issueUserToken(
  payload: { userId: string; username: string; role: UserRole; status: UserStatus },
  secret: string,
  ttlMs = 24 * 60 * 60 * 1000,
): string {
  const full: UserTokenPayload = { ...payload, exp: Date.now() + ttlMs };
  const body = base64url(JSON.stringify(full));
  return `${body}.${sign(body, secret)}`;
}

export function verifyUserToken(token: string, secret: string): Omit<UserTokenPayload, "exp"> | null {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(body, secret);

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const parsed = JSON.parse(unbase64url(body).toString("utf8")) as UserTokenPayload;
    if (parsed.exp < Date.now()) return null;
    return {
      userId: parsed.userId,
      username: parsed.username,
      role: parsed.role,
      status: parsed.status,
    };
  } catch {
    return null;
  }
}
