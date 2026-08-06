import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { HubRole, HubUserStatus } from "../storage/repos/hub.js";

export interface UserTokenPayload {
  userId: string;
  username: string;
  role: HubRole;
  status: HubUserStatus;
}

interface SignedUserTokenPayload extends UserTokenPayload {
  exp: number;
}

export function makeSharedToken(): string {
  return base64url(randomBytes(24));
}

export function issueUserToken(
  payload: UserTokenPayload,
  secret: string,
  ttlMs = 24 * 60 * 60 * 1000,
): string {
  const full: SignedUserTokenPayload = { ...payload, exp: Date.now() + ttlMs };
  const body = base64url(JSON.stringify(full));
  return `${body}.${sign(body, secret)}`;
}

export function verifyUserToken(token: string, secret: string): UserTokenPayload | null {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(body, secret);
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const parsed = JSON.parse(unbase64url(body).toString("utf8")) as SignedUserTokenPayload;
    if (!parsed.userId || parsed.exp < Date.now()) return null;
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

function sign(value: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(value).digest());
}

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
