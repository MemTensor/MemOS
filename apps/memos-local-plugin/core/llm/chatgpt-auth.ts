/**
 * "Sign in with ChatGPT" credentials for the `chatgpt` LLM provider.
 *
 * Sign in (from the plugin folder, after `npm run build`):
 *   node scripts/chatgpt-login.mjs
 *
 * Flow (developers.openai.com/siwc/token-sharing-open-source/sign-in):
 *   - OAuth authorization code + PKCE (S256), loopback callback on 127.0.0.1.
 *   - First sign-in uses client_id=dynamic_agent_client; the issued client_id
 *     is saved and reused. No client secret, no API key.
 *   - Scopes: openid profile email offline_access resource.invoke
 *     chatgpt.tokens.use.direct; resource=https://api.openai.com/v1.
 *   - Access token ~1h; refresh token rotates on every refresh.
 *
 * Secrets rule: nothing in this file logs, prints or throws a token. Error
 * messages carry OAuth error codes only. One known limit: on a re-sign-in
 * the browser is opened with an `id_token_hint` (the previous ID token,
 * which identifies the account but grants no API access) as a command-line
 * argument to the OS URL opener, which other local users can see in the
 * process list for that short moment. The printed address never carries it.
 */

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as cryptoVerify,
  type JsonWebKey,
} from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_API_BASE = "https://api.openai.com/v1";
export const CHATGPT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
];
export const REQUIRED_PLAN_SCOPE = "chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME_HINT = "MemOS local memory";
const CALLBACK_PATH = "/auth/callback";
const DEFAULT_CALLBACK_PORT = 1455;
/** Refresh when fewer than this many ms remain on the access token. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 20_000;

/** Refresh-token errors that mean "sign in again" (errors-and-recovery). */
const REAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export interface ChatGptCredentials {
  version: 1;
  issuer: string;
  client_id: string;
  ext_agent_host_id: string;
  subject?: string;
  email?: string;
  id_token?: string;
  access_token: string;
  refresh_token: string;
  token_type?: string;
  /** Epoch ms when the access token expires. */
  expires_at: number;
  scopes: string[];
  saved_at: string;
  /** Set when a refresh failed terminally; tokens are cleared. */
  reauth_required?: boolean;
}

export type ChatGptAuthErrorKind =
  | "not_signed_in"
  | "reauth_required"
  | "missing_scope"
  | "invalid_client"
  | "transient"
  | "lock_timeout";

export class ChatGptAuthError extends Error {
  constructor(
    readonly kind: ChatGptAuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ChatGptAuthError";
  }
}

// ─── Paths & storage ─────────────────────────────────────────────────────────

export function defaultTokenFile(): string {
  const env = process.env.MEMOS_CHATGPT_TOKEN_FILE;
  if (env && env.trim().length > 0) return env.trim();
  return path.join(os.homedir(), ".config", "memos-local", "chatgpt-oauth.json");
}

export async function readCredentials(file: string): Promise<ChatGptCredentials | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: ChatGptCredentials;
  try {
    parsed = JSON.parse(raw) as ChatGptCredentials;
  } catch {
    throw new ChatGptAuthError("not_signed_in", "ChatGPT credential file is malformed");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.client_id !== "string" ||
    !Array.isArray(parsed.scopes) ||
    typeof parsed.expires_at !== "number"
  ) {
    throw new ChatGptAuthError("not_signed_in", "ChatGPT credential file is malformed");
  }
  return parsed;
}

/**
 * Atomic owner-only write: temp file in the same folder, then rename.
 * Resolves false when owner-only permissions could not be applied.
 */
export async function writeCredentials(file: string, creds: ChatGptCredentials): Promise<boolean> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const handle = await fsp.open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(creds, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return restrictToOwner(file);
}

/**
 * Owner-only permissions. POSIX: chmod 700 for folders, 600 for files.
 * Windows: drop inherited ACEs and grant only the current user full
 * control (icacls). Best effort: never throws, returns false when the
 * permissions could not be applied so callers can warn.
 */
export async function restrictToOwner(target: string): Promise<boolean> {
  const isDir = (await fsp.stat(target).catch(() => null))?.isDirectory() === true;
  if (process.platform !== "win32") {
    return fsp.chmod(target, isDir ? 0o700 : 0o600).then(
      () => true,
      () => false,
    );
  }
  const user = os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  const principal = domain ? `${domain}\\${user}` : user;
  const icacls = (args: string[]) =>
    new Promise<boolean>((resolve) => {
      execFile("icacls", [target, ...args], { windowsHide: true }, (err) => resolve(!err));
    });
  // /reset drops explicit ACEs a new file gets from the process token
  // (SYSTEM, logon session); then keep only the owner. Folders grant the
  // owner with (OI)(CI) so files created inside inherit owner-only access.
  const reset = await icacls(["/reset"]);
  const granted = await icacls([
    "/inheritance:r",
    "/grant:r",
    isDir ? `${principal}:(OI)(CI)F` : `${principal}:F`,
  ]);
  return reset && granted;
}

// ─── Lock (serialise refreshes across MemOS processes) ───────────────────────

async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  // Unique per acquisition, so a holder never removes a lock that a peer
  // re-created after treating this one as stale.
  const owner = `${process.pid}.${randomBytes(8).toString("hex")}`;
  const started = Date.now();
  for (;;) {
    // Checked on every pass, so no path below can spin past the wait limit.
    if (Date.now() - started > LOCK_WAIT_MS) {
      throw new ChatGptAuthError("lock_timeout", "timed out waiting for the ChatGPT token lock");
    }
    try {
      const h = await fsp.open(lock, "wx", 0o600);
      await h.writeFile(owner);
      await h.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const st = await fsp.stat(lock).catch(() => null);
      if (!st) continue; // lock vanished between open and stat: retry at once
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fsp.rm(lock, { force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try {
    return await fn();
  } finally {
    const current = await fsp.readFile(lock, "utf8").catch(() => null);
    if (current === owner) await fsp.rm(lock, { force: true }).catch(() => undefined);
  }
}

// ─── Token use & refresh ─────────────────────────────────────────────────────

export interface TokenOptions {
  file?: string;
  /** Refresh even if the token is not near expiry (after a 401). */
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Only used with `force`: skip refresh if another process already rotated past this token. */
  staleAccessToken?: string;
}

export interface AccessToken {
  accessToken: string;
  expiresAt: number;
  email?: string;
}

/**
 * Return a usable access token, refreshing (under a cross-process lock) when
 * it is within REFRESH_MARGIN_MS of expiry or when `force` is set.
 */
export async function getAccessToken(opts: TokenOptions = {}): Promise<AccessToken> {
  const file = opts.file ?? defaultTokenFile();
  const now = opts.now ?? Date.now;
  const creds = await readCredentials(file);
  assertUsable(creds);
  if (!opts.force && creds.expires_at - now() > REFRESH_MARGIN_MS) {
    return { accessToken: creds.access_token, expiresAt: creds.expires_at, email: creds.email };
  }
  return withFileLock(file, async () => {
    // Another process may have refreshed while we waited for the lock.
    const fresh = await readCredentials(file);
    assertUsable(fresh);
    const rotatedByPeer = opts.force
      ? opts.staleAccessToken !== undefined && fresh.access_token !== opts.staleAccessToken
      : fresh.expires_at - now() > REFRESH_MARGIN_MS;
    if (rotatedByPeer) {
      return { accessToken: fresh.access_token, expiresAt: fresh.expires_at, email: fresh.email };
    }
    const updated = await refreshCredentials(fresh, file, opts.fetchImpl ?? fetch, now);
    return { accessToken: updated.access_token, expiresAt: updated.expires_at, email: updated.email };
  });
}

function assertUsable(creds: ChatGptCredentials | null): asserts creds is ChatGptCredentials {
  if (!creds) {
    throw new ChatGptAuthError("not_signed_in", "not signed in to ChatGPT (run scripts/chatgpt-login.mjs)");
  }
  if (creds.reauth_required || !creds.refresh_token || !creds.access_token) {
    throw new ChatGptAuthError("reauth_required", "ChatGPT sign-in expired (run scripts/chatgpt-login.mjs)");
  }
  if (!creds.scopes.includes(REQUIRED_PLAN_SCOPE)) {
    throw new ChatGptAuthError("missing_scope", `ChatGPT grant lacks ${REQUIRED_PLAN_SCOPE}; sign in again`);
  }
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function refreshCredentials(
  creds: ChatGptCredentials,
  file: string,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<ChatGptCredentials> {
  let resp: Response;
  try {
    resp = await fetchImpl(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: creds.client_id,
        refresh_token: creds.refresh_token,
        resource: CHATGPT_RESOURCE,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ChatGptAuthError("transient", `ChatGPT token refresh failed: ${(err as Error).name}`);
  }
  const body = (await resp.json().catch(() => ({}))) as TokenEndpointResponse;
  if (!resp.ok || !body.access_token) {
    const code = body.error ?? `http_${resp.status}`;
    if (REAUTH_ERRORS.has(code)) {
      // Docs: clear the unusable tokens, keep the issued client_id for re-sign-in.
      await writeCredentials(file, {
        ...creds,
        access_token: "",
        refresh_token: "",
        id_token: undefined,
        reauth_required: true,
        saved_at: new Date(now()).toISOString(),
      });
      throw new ChatGptAuthError("reauth_required", `ChatGPT refresh rejected (${code}); sign in again`);
    }
    if (code === "invalid_client") {
      throw new ChatGptAuthError("invalid_client", "ChatGPT refresh rejected (invalid_client)");
    }
    // 5xx / network / unknown: keep credentials untouched.
    throw new ChatGptAuthError("transient", `ChatGPT token refresh failed (${code})`);
  }
  const updated: ChatGptCredentials = {
    ...creds,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? creds.refresh_token,
    id_token: body.id_token ?? creds.id_token,
    token_type: body.token_type ?? creds.token_type,
    expires_at: now() + (body.expires_in ?? 3600) * 1000,
    scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : creds.scopes,
    saved_at: new Date(now()).toISOString(),
    reauth_required: false,
  };
  await writeCredentials(file, updated);
  return updated;
}

// ─── Models ──────────────────────────────────────────────────────────────────

export interface ChatGptModel {
  slug: string;
  displayName?: string;
}

/** GET /v1/models, keeping entries with visibility "list". */
export async function listChatGptModels(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<ChatGptModel[]> {
  const resp = await fetchImpl(`${CHATGPT_API_BASE}/models`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await resp.json().catch(() => ({}))) as {
    models?: Array<{ slug?: string; id?: string; display_name?: string; visibility?: string }>;
    data?: Array<{ slug?: string; id?: string; display_name?: string; visibility?: string }>;
    error?: { code?: string; message?: string };
  };
  if (!resp.ok) {
    throw new Error(`model list failed: HTTP ${resp.status} ${body.error?.code ?? ""}`.trim());
  }
  const rows = body.models ?? body.data ?? [];
  return rows
    // ChatGPT-plan listings mark usable models "list"; a plain OpenAI-style
    // listing has no visibility field, so keep those rows too.
    .filter((m) => m.visibility === undefined || m.visibility === "list")
    .map((m) => ({ slug: m.slug ?? m.id ?? "", displayName: m.display_name }))
    .filter((m) => m.slug.length > 0);
}

// ─── Interactive sign-in ─────────────────────────────────────────────────────

export interface LoginOptions {
  file?: string;
  port?: number;
  /** Prints status lines (never tokens). */
  print?: (line: string) => void;
  openBrowser?: (url: string) => void;
  timeoutMs?: number;
}

export interface LoginResult {
  email?: string;
  subject?: string;
  scopes: string[];
  expiresAt: number;
  file: string;
  newRegistration: boolean;
}

export async function runLogin(opts: LoginOptions = {}): Promise<LoginResult> {
  const file = opts.file ?? defaultTokenFile();
  const print = opts.print ?? ((l: string) => console.log(l));
  const existing = await readCredentials(file).catch(() => null);
  const savedClientId = existing?.client_id && existing.client_id !== DYNAMIC_CLIENT_ID ? existing.client_id : null;
  // Host ID is chosen and persisted BEFORE the browser opens (docs: overview page).
  const extAgentHostId = await getOrCreateHostId(file, existing?.ext_agent_host_id);

  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));

  const preferredPort = opts.port ?? DEFAULT_CALLBACK_PORT;
  const { server, port } = await listenLoopback(preferredPort);
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  if (preferredPort !== 0 && port !== preferredPort) {
    print(`Port ${preferredPort} is busy, so the sign-in callback uses ${redirectUri} instead.`);
    if (savedClientId) {
      print(`If sign-in fails with a redirect error, free port ${preferredPort} and run this again.`);
    }
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: savedClientId ?? DYNAMIC_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CHATGPT_SCOPES.join(" "),
    resource: CHATGPT_RESOURCE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: extAgentHostId,
  });
  if (!savedClientId) params.set("agent_name_hint", AGENT_NAME_HINT);
  // The printed address never carries the ID token: `id_token_hint` is an
  // optional hint, so it only goes into the URL handed to the browser.
  const printableUrl = `${CHATGPT_AUTHORIZE_URL}?${params.toString()}`;
  if (savedClientId && existing?.id_token) params.set("id_token_hint", existing.id_token);
  const authorizeUrl = `${CHATGPT_AUTHORIZE_URL}?${params.toString()}`;

  print("Opening your browser to sign in with ChatGPT.");
  print("If it does not open, paste this address into your browser:");
  print(printableUrl);
  (opts.openBrowser ?? openInBrowser)(authorizeUrl);

  let callback: URLSearchParams;
  try {
    callback = await waitForCallback(server, state, opts.timeoutMs ?? 15 * 60_000);
  } finally {
    server.close();
  }

  if (callback.get("state") !== state) throw new Error("sign-in failed: state mismatch");
  const oauthErr = callback.get("error");
  if (oauthErr) throw new Error(`sign-in failed: ${oauthErr}`);
  const code = callback.get("code");
  if (!code) throw new Error("sign-in failed: no authorization code returned");
  const returnedClientId = callback.get("client_id");
  let clientId: string;
  if (savedClientId) {
    if (returnedClientId && returnedClientId !== savedClientId) {
      throw new Error("sign-in failed: callback returned a different client_id");
    }
    clientId = savedClientId;
  } else {
    if (!returnedClientId || returnedClientId === DYNAMIC_CLIENT_ID) {
      throw new Error("sign-in failed: registration incomplete (no issued client_id)");
    }
    clientId = returnedClientId;
  }

  const tokenResp = await fetch(CHATGPT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: CHATGPT_RESOURCE,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const tok = (await tokenResp.json().catch(() => ({}))) as TokenEndpointResponse;
  if (!tokenResp.ok || !tok.access_token) {
    throw new Error(`token exchange failed: ${tok.error ?? `HTTP ${tokenResp.status}`}`);
  }
  if (!tok.refresh_token) throw new Error("token exchange returned no refresh token (offline_access not granted)");
  // RFC 6749 §5.1: `scope` may be omitted when the grant equals the request.
  const scopes = (tok.scope ?? callback.get("scope") ?? CHATGPT_SCOPES.join(" ")).split(/\s+/).filter(Boolean);

  let subject: string | undefined;
  let email: string | undefined;
  if (tok.id_token) {
    const claims = await verifyIdToken(tok.id_token, clientId, nonce);
    subject = claims.sub;
    email = typeof claims.email === "string" ? claims.email : undefined;
    if (existing?.subject && savedClientId && existing.subject !== subject) {
      throw new Error("sign-in failed: a different ChatGPT account signed in for this registration");
    }
  }

  const creds: ChatGptCredentials = {
    version: 1,
    issuer: CHATGPT_ISSUER,
    client_id: clientId,
    ext_agent_host_id: extAgentHostId,
    subject,
    email,
    id_token: tok.id_token,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    token_type: tok.token_type,
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
    scopes,
    saved_at: new Date().toISOString(),
  };
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const dirRestricted = await restrictToOwner(path.dirname(file));
  const fileRestricted = await writeCredentials(file, creds);
  if (!dirRestricted || !fileRestricted) {
    print(`Warning: could not restrict ${file} to your user account; check its permissions.`);
  }
  return { email, subject, scopes, expiresAt: creds.expires_at, file, newRegistration: !savedClientId };
}

/** Status without secrets. */
export async function describeCredentials(file = defaultTokenFile()): Promise<Record<string, unknown>> {
  const c = await readCredentials(file);
  if (!c) return { signedIn: false, file };
  return {
    signedIn: !c.reauth_required && Boolean(c.refresh_token),
    file,
    email: c.email,
    planScope: c.scopes.includes(REQUIRED_PLAN_SCOPE),
    scopes: c.scopes,
    accessTokenExpires: new Date(c.expires_at).toISOString(),
    reauthRequired: Boolean(c.reauth_required),
    savedAt: c.saved_at,
  };
}

// ─── Host ID ─────────────────────────────────────────────────────────────────

/**
 * Accepted `ext_agent_host_id` formats (developers.openai.com/siwc/
 * token-sharing-open-source): JWK-thumbprint URN, `urn:uuid:<uuidv4>`, or
 * `did:key:`. Opaque — never an email or user id. One per host, stable.
 */
export function isValidHostId(id: string | undefined): id is string {
  if (!id) return false;
  return (
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    id.startsWith("urn:ietf:params:oauth:jwk-thumbprint:") ||
    id.startsWith("did:key:")
  );
}

export function hostIdFile(tokenFile: string): string {
  return path.join(path.dirname(tokenFile), "host-id");
}

/**
 * Return this host's persisted ID, creating `urn:uuid:<uuidv4>` once if none
 * exists. Order: valid ID already in the credential record → `host-id` file
 * → new. Written owner-only before sign-in starts.
 */
export async function getOrCreateHostId(tokenFile: string, fromCredentials?: string): Promise<string> {
  if (isValidHostId(fromCredentials)) return fromCredentials;
  const f = hostIdFile(tokenFile);
  try {
    const saved = (await fsp.readFile(f, "utf8")).trim();
    if (isValidHostId(saved)) return saved;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const id = `urn:uuid:${randomUUID()}`; // randomUUID() is v4
  const dir = path.dirname(f);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await restrictToOwner(dir);
  const tmp = path.join(dir, `.host-id.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await fsp.writeFile(tmp, id, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fsp.rename(tmp, f);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await restrictToOwner(f);
  return id;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function listenLoopback(preferred: number): Promise<{ server: http.Server; port: number }> {
  const tryPort = (port: number) =>
    new Promise<{ server: http.Server; port: number }>((resolve, reject) => {
      const server = http.createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        resolve({ server, port: typeof addr === "object" && addr ? addr.port : port });
      });
    });
  return tryPort(preferred).catch(() => tryPort(0));
}

/**
 * Resolves on the first callback that carries this sign-in's `state`.
 * Stray requests (browser prefetch, retries, other local processes) get a
 * 400 and the listener keeps waiting, so they cannot end the sign-in.
 */
function waitForCallback(server: http.Server, state: string, timeoutMs: number): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sign-in timed out")), timeoutMs);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Unknown sign-in request.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><title>MemOS</title><p style=\"font-family:sans-serif\">" +
          "MemOS received the ChatGPT sign-in. You can close this tab.</p>",
      );
      clearTimeout(timer);
      resolve(url.searchParams);
    });
  });
}

function openInBrowser(url: string): void {
  if (process.platform === "win32") {
    // rundll32 avoids cmd.exe treating '&' in the URL as a command separator.
    execFile("rundll32", ["url.dll,FileProtocolHandler", url], { windowsHide: true }, () => undefined);
  } else if (process.platform === "darwin") {
    execFile("open", [url], () => undefined);
  } else {
    execFile("xdg-open", [url], () => undefined);
  }
}

interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  sub?: string;
  email?: unknown;
}

/** RS256 signature + iss/aud/exp/nonce checks against OpenAI's JWKS. */
export async function verifyIdToken(
  idToken: string,
  clientId: string,
  nonce: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token malformed");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string; kid?: string };
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as IdTokenClaims;
  if (header.alg !== "RS256") throw new Error(`id_token alg ${header.alg} not accepted`);
  const jwksResp = await fetchImpl(CHATGPT_JWKS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!jwksResp.ok) throw new Error(`id_token JWKS fetch failed: HTTP ${jwksResp.status}`);
  const jwks = (await jwksResp.json().catch(() => ({}))) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  let jwk: JsonWebKey | undefined;
  if (header.kid) {
    jwk = keys.find((k) => k.kid === header.kid);
  } else if (keys.length === 1) {
    // A single key is only accepted when the token names no key.
    jwk = keys[0];
  }
  if (!jwk) throw new Error("id_token signing key not found in JWKS");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], "base64url"),
  );
  if (!ok) throw new Error("id_token signature invalid");
  if (claims.iss !== CHATGPT_ISSUER) throw new Error("id_token issuer mismatch");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error("id_token audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) throw new Error("id_token expired");
  if (claims.nonce !== nonce) throw new Error("id_token nonce mismatch");
  return claims;
}
