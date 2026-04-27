/**
 * Viewer password gate.
 *
 * Opt-in security for the Memory Viewer — when the operator enables
 * password protection (Settings → 账户 → "启用密码保护"), every
 * `/api/v1/*` request MUST carry a valid session cookie issued by
 * this module. When password protection is OFF (the default,
 * preserves zero-config install.sh behaviour), this module is a
 * no-op and the API is reachable from localhost without auth.
 *
 * Storage shape:
 *
 *   $HOME/.auth.json  (mode 0600)
 *     {
 *       "version": 1,
 *       "hash": "<scrypt-hash>",  // password-derived key
 *       "salt": "<base64>",
 *       "sessionSecret": "<base64>",
 *       "createdAt": <epochMs>
 *     }
 *
 * We use Node's built-in `scrypt` (no bcrypt dep) with N=16384,r=8,p=1
 * and a 32-byte key. Sessions are HMAC-SHA256 signed JSON with a
 * 7-day rolling TTL — refreshed on every successful request.
 *
 * ## Multi-agent cookie scoping
 *
 * Browsers do NOT isolate cookies by port — `localhost:18799`
 * (openclaw) and `localhost:18800` (hermes) share a single cookie
 * jar. Same goes for the hub layout where one server proxies
 * `/openclaw/*` and `/hermes/*` from the same origin. If both
 * agents wrote the same cookie name (`memos_sess`) with `Path=/`,
 * a login on hermes would silently overwrite the openclaw cookie
 * (and vice versa) → refreshing one viewer would log the other one
 * out, because each agent signs sessions with its own
 * `sessionSecret`.
 *
 * To stay isolated we name the cookie `memos_sess_<agent>` (e.g.
 * `memos_sess_openclaw`, `memos_sess_hermes`). Both cookies coexist
 * in the browser's jar without conflict. When the host doesn't
 * advertise an agent (test fixtures, plain single-agent installs)
 * we fall back to the legacy `memos_sess` name so existing setups
 * continue to work unchanged.
 *
 * On the read side we additionally accept the legacy `memos_sess`
 * cookie when the per-agent one is missing. This means users who
 * were already logged in before the upgrade aren't kicked out the
 * first time they refresh — the next successful response will
 * write the new per-agent cookie and the transition is silent.
 *
 * Endpoints (public, no auth):
 *   - `GET  /api/v1/auth/status`
 *   - `POST /api/v1/auth/setup`   body: { password }
 *   - `POST /api/v1/auth/login`   body: { password }
 *   - `POST /api/v1/auth/logout`
 *
 * Everything else under `/api/v1/*` is gated by `requireSession`
 * (called from `server/http.ts::dispatch`).
 */
import {
  existsSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";

import type { ServerDeps, ServerOptions } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_COOKIE_NAME = "memos_sess";
const SCRYPT_KEYLEN = 32;

/**
 * Resolve the per-agent cookie name. Falls back to the legacy
 * `memos_sess` when no agent is configured (single-agent installs +
 * test fixtures) so unrelated callers continue to work.
 */
function cookieNameFor(agent: string | null | undefined): string {
  if (!agent) return LEGACY_COOKIE_NAME;
  return `${LEGACY_COOKIE_NAME}_${agent}`;
}

/**
 * Read the current session cookie, preferring the per-agent name and
 * silently falling back to the legacy name (for users upgrading from
 * a pre-fix viewer). Returns null when neither is present.
 */
function readSessionCookie(
  cookieHeader: string | undefined,
  agent: string | null | undefined,
): string | null {
  const primary = cookieNameFor(agent);
  const v = readCookie(cookieHeader, primary);
  if (v) return v;
  if (primary !== LEGACY_COOKIE_NAME) {
    return readCookie(cookieHeader, LEGACY_COOKIE_NAME);
  }
  return null;
}

export interface AuthState {
  version: 1;
  hash: string;
  salt: string;
  sessionSecret: string;
  createdAt: number;
}

/**
 * Serialise / deserialise the auth file. Sits alongside `config.yaml`
 * but is kept separate because it contains credentials.
 */
function authPath(homeDir: string): string {
  return join(homeDir, ".auth.json");
}

export function readAuthState(homeDir: string): AuthState | null {
  const p = authPath(homeDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as AuthState;
    if (raw.version !== 1 || !raw.hash || !raw.salt || !raw.sessionSecret) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function writeAuthState(homeDir: string, state: AuthState): void {
  const p = authPath(homeDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
  try {
    chmodSync(p, 0o600);
  } catch {
    /* platform may not support — best-effort */
  }
}

function hashPassword(
  password: string,
  saltBase64?: string,
): { hash: string; salt: string } {
  const salt = saltBase64
    ? Buffer.from(saltBase64, "base64")
    : randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN);
  return {
    hash: key.toString("base64"),
    salt: salt.toString("base64"),
  };
}

function verifyPassword(password: string, state: AuthState): boolean {
  const { hash } = hashPassword(password, state.salt);
  return timingSafeEqual(
    Buffer.from(hash, "base64"),
    Buffer.from(state.hash, "base64"),
  );
}

// ─── Session tokens (HMAC-SHA256 signed JSON) ──────────────────────────────

interface SessionPayload {
  iat: number;
  exp: number;
}

function signSession(state: AuthState, payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", Buffer.from(state.sessionSecret, "base64"))
    .update(body)
    .digest("base64url");
  return `${body}.${mac}`;
}

export function verifySession(token: string, state: AuthState): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", Buffer.from(state.sessionSecret, "base64"))
    .update(body)
    .digest("base64url");
  if (mac.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as
      | SessionPayload
      | null;
    if (!payload || typeof payload.exp !== "number") return false;
    return Date.now() < payload.exp;
  } catch {
    return false;
  }
}

// ─── Cookie helpers ────────────────────────────────────────────────────────

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function setSessionCookie(
  res: { setHeader: (name: string, value: string | string[]) => void },
  token: string,
  agent: string | null | undefined,
): void {
  const name = cookieNameFor(agent);
  res.setHeader("Set-Cookie", [
    `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000,
    )}`,
  ]);
}

function clearSessionCookie(
  res: { setHeader: (name: string, value: string | string[]) => void },
  agent: string | null | undefined,
): void {
  const name = cookieNameFor(agent);
  // Also clear the legacy name so users upgrading from a pre-fix
  // viewer don't end up with two stale cookies after logout.
  const cookies = [
    `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  ];
  if (name !== LEGACY_COOKIE_NAME) {
    cookies.push(
      `${LEGACY_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    );
  }
  res.setHeader("Set-Cookie", cookies);
}

// ─── Public routes ─────────────────────────────────────────────────────────

export function registerAuthRoutes(
  routes: Routes,
  deps: ServerDeps,
  options: ServerOptions = {},
): void {
  const homeRoot = (): string | null => deps.home?.root ?? null;
  const agent = options.agent ?? null;

  routes.set("GET /api/v1/auth/status", async (ctx) => {
    const root = homeRoot();
    if (!root) {
      // Server has no home configured (e.g. test fixture) — treat as
      // open to preserve existing test behaviour.
      return { enabled: false, needsSetup: false, authenticated: true };
    }
    const state = readAuthState(root);
    if (!state) {
      // No password configured yet. First-run flow: frontend must
      // show the SetupScreen before rendering the app shell. Every
      // request up to /auth/setup is allowed through (the session
      // middleware also permits unauthed access when no state file
      // exists — see `requireSession` below).
      return { enabled: true, needsSetup: true, authenticated: false };
    }
    const cookie = readSessionCookie(ctx.req.headers.cookie, agent);
    const authed = cookie ? verifySession(cookie, state) : false;
    return { enabled: true, needsSetup: false, authenticated: authed };
  });

  routes.set("POST /api/v1/auth/setup", async (ctx) => {
    const root = homeRoot();
    if (!root) {
      writeError(ctx, 503, "unavailable", "home not configured");
      return;
    }
    const body = parseJson<{ password?: string }>(ctx);
    const pw = (body.password ?? "").trim();
    // Legacy parity: any non-empty password is acceptable. The
    // viewer is loopback-only by default, so a 6-char minimum
    // just added friction without meaningful security.
    if (pw.length === 0) {
      writeError(ctx, 400, "invalid_argument", "password is required");
      return;
    }
    if (readAuthState(root)) {
      writeError(ctx, 409, "already_exists", "password already configured");
      return;
    }
    const { hash, salt } = hashPassword(pw);
    const state: AuthState = {
      version: 1,
      hash,
      salt,
      sessionSecret: randomBytes(32).toString("base64"),
      createdAt: Date.now(),
    };
    writeAuthState(root, state);
    const now = Date.now();
    const token = signSession(state, { iat: now, exp: now + SESSION_TTL_MS });
    setSessionCookie(ctx.res, token, agent);
    return { ok: true };
  });

  routes.set("POST /api/v1/auth/login", async (ctx) => {
    const root = homeRoot();
    if (!root) {
      writeError(ctx, 503, "unavailable", "home not configured");
      return;
    }
    const state = readAuthState(root);
    if (!state) {
      writeError(ctx, 404, "not_found", "password not configured");
      return;
    }
    const body = parseJson<{ password?: string }>(ctx);
    const pw = (body.password ?? "").trim();
    if (!verifyPassword(pw, state)) {
      writeError(ctx, 401, "unauthenticated", "invalid password");
      return;
    }
    const now = Date.now();
    const token = signSession(state, { iat: now, exp: now + SESSION_TTL_MS });
    setSessionCookie(ctx.res, token, agent);
    return { ok: true };
  });

  routes.set("POST /api/v1/auth/logout", async (ctx) => {
    clearSessionCookie(ctx.res, agent);
    return { ok: true };
  });

  /**
   * `POST /api/v1/auth/reset` — delete the `.auth.json` file and clear
   * the session cookie. The next `GET /api/v1/auth/status` will then
   * report `needsSetup: true`, and the AuthGate will show the setup
   * screen again so the user can choose a brand-new password.
   *
   * This is a blunt "I forgot my password" escape hatch; it requires
   * an already-authenticated session to call, i.e. the user must
   * still be logged in to click the Settings → "Reset password"
   * button. If the session is expired, they must manually delete
   * `~/.openclaw/memos-plugin/.auth.json` on disk (documented
   * elsewhere).
   */
  routes.set("POST /api/v1/auth/reset", async (ctx) => {
    const root = homeRoot();
    if (!root) {
      writeError(ctx, 503, "unavailable", "home not configured");
      return;
    }
    // Require a currently valid session before deleting the auth file —
    // otherwise anyone on localhost could drop the password.
    const state = readAuthState(root);
    if (state) {
      const cookie = readSessionCookie(ctx.req.headers.cookie, agent);
      if (!cookie || !verifySession(cookie, state)) {
        writeError(ctx, 401, "unauthenticated", "login required");
        return;
      }
    }
    const p = authPath(root);
    if (existsSync(p)) {
      try {
        (await import("node:fs")).unlinkSync(p);
      } catch {
        writeError(ctx, 500, "internal", "failed to delete auth file");
        return;
      }
    }
    clearSessionCookie(ctx.res, agent);
    return { ok: true };
  });
}

/**
 * Middleware hook — returns true when the request is allowed to
 * proceed, false when it has been answered with 401.
 *
 * Called from `server/http.ts::dispatch` ahead of the route table.
 * Auth endpoints themselves bypass this check (they're what a locked
 * client uses to unlock).
 *
 * `agent` (optional) scopes the cookie name so this server's session
 * doesn't collide with another agent's session sharing the same
 * `localhost` cookie jar (see file header).
 */
export function requireSession(
  req: { headers: { cookie?: string } },
  res: {
    setHeader: (n: string, v: string | string[]) => void;
    writeHead: (code: number, headers?: Record<string, string>) => void;
    end: (body?: string) => void;
  },
  homeDir: string,
  pathname: string,
  agent?: string | null,
): boolean {
  // Public: auth endpoints + health (so the viewer can tell whether
  // the backend is up BEFORE unlocking).
  if (pathname.startsWith("/api/v1/auth/")) return true;
  if (pathname === "/api/v1/health") return true;

  const state = readAuthState(homeDir);
  if (!state) return true; // password protection off → open

  const cookie = readSessionCookie(req.headers.cookie, agent);
  if (cookie && verifySession(cookie, state)) return true;

  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: { code: "unauthenticated", message: "login required" },
    }),
  );
  return false;
}
