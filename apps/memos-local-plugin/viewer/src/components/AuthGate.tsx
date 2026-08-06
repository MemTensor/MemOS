/**
 * Auth gate — wraps the whole app shell.
 *
 * State machine (`GET /api/v1/auth/status`):
 *
 *   needsSetup = true                  → <SetupScreen>
 *   needsSetup = false, !authenticated → <LoginScreen>
 *   authenticated = true               → render children
 *
 * First-run flow is mandatory password setup: there is no way to
 * skip the SetupScreen. Subsequent visits re-use the `memos_sess`
 * cookie until it expires (7 days). When the cookie expires the
 * user lands on the LoginScreen again.
 *
 * Layout mirrors the legacy `memos-local-openclaw` v2 auth screen:
 * a centred card with the agent's own logo on top (OpenClaw
 * mascot for openclaw, teal Hermes mark for hermes) and the form
 * stacked below. No left/right split. Password rules are
 * deliberately light — we do not enforce a 6-char minimum; the
 * server rejects empty strings but accepts anything else.
 */
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Icon } from "./Icon";
import { t } from "../stores/i18n";
import { health } from "../stores/health";

type Status =
  | { state: "loading" }
  | { state: "setup" }
  | { state: "login" }
  | { state: "ready" };

export function AuthGate({ children }: { children: ComponentChildren }) {
  const [status, setStatus] = useState<Status>({ state: "loading" });

  const refresh = async () => {
    try {
      const r = await fetch("/api/v1/auth/status", { cache: "no-store" });
      if (r.status === 401) {
        setStatus({ state: "login" });
        return;
      }
      const body = (await r.json()) as {
        enabled?: boolean;
        needsSetup?: boolean;
        authenticated?: boolean;
      };
      if (body.needsSetup) setStatus({ state: "setup" });
      else if (body.enabled && !body.authenticated) setStatus({ state: "login" });
      else setStatus({ state: "ready" });
    } catch {
      setStatus({ state: "ready" });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (status.state === "loading") {
    return (
      <div
        style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg)"
      >
        <Icon name="loader-2" size={32} class="spin" />
      </div>
    );
  }

  if (status.state === "setup") return <SetupScreen onDone={refresh} />;
  if (status.state === "login") return <LoginScreen onUnlocked={refresh} />;
  return <>{children}</>;
}

// ─── Setup (first run) ──────────────────────────────────────────────────

function SetupScreen({ onDone }: { onDone: () => void }) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: Event) => {
    if (e) e.preventDefault();
    if (busy) return;
    setError(null);
    if (!pw1) {
      setError(t("auth.err.empty"));
      return;
    }
    if (pw1 !== pw2) {
      setError(t("auth.err.mismatch"));
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/v1/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw1 }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
        setError(body.error?.message ?? "setup failed");
        return;
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <AuthLogo />
      <AuthHeader
        title={t("auth.setup.title")}
        subtitle={t("auth.setup.subtitle")}
      />
      <form onSubmit={submit} class="vstack" style="gap:var(--sp-4);width:100%">
        <AuthField
          label={t("auth.setup.newPassword")}
          type="password"
          value={pw1}
          autoFocus
          onInput={setPw1}
        />
        <AuthField
          label={t("auth.setup.confirm")}
          type="password"
          value={pw2}
          onInput={setPw2}
        />
        {error && <AuthError text={error} />}
        <button
          type="submit"
          class="memos-auth-submit"
          disabled={busy || !pw1 || !pw2}
        >
          <Icon name={busy ? "loader-2" : "check"} size={14} class={busy ? "spin" : ""} />
          {busy ? t("common.loading") : t("auth.setup.submit")}
        </button>
        <p
          style="font-size:12px;text-align:center;margin:0;color:hsl(0,0%,45.1%)"
        >
          {t("auth.setup.hint")}
        </p>
      </form>
    </AuthShell>
  );
}

// ─── Login (returning user / expired cookie) ────────────────────────────

function LoginScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: Event) => {
    if (e) e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.status === 200) {
        onUnlocked();
        return;
      }
      const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
      setError(body.error?.message ?? t("auth.err.badPassword"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <AuthLogo />
      <AuthHeader
        title={t("auth.login.title")}
        subtitle={t("auth.login.subtitle")}
      />
      <form onSubmit={submit} class="vstack" style="gap:var(--sp-4);width:100%">
        <AuthField
          label={t("auth.login.password")}
          type="password"
          value={password}
          autoFocus
          onInput={setPassword}
        />
        {error && <AuthError text={error} />}
        <button
          type="submit"
          class="memos-auth-submit"
          disabled={busy || !password}
        >
          <Icon name={busy ? "loader-2" : "check"} size={14} class={busy ? "spin" : ""} />
          {busy ? t("common.loading") : t("auth.login.submit")}
        </button>
      </form>
    </AuthShell>
  );
}

// ─── Shell + atoms ──────────────────────────────────────────────────────

/*
 * Auth shell — mirrors the legacy `memos-local-openclaw` v1 viewer
 * (see `apps/memos-local-openclaw/src/viewer/html.ts` around the
 * `.auth-screen` block): full-viewport gradient background, a
 * centred white card, a floating logo on top with a subtle bounce,
 * a tight headline and subtitle, and a generous form body. The
 * visual identity is intentionally different from the main app
 * shell to signal "you are locked out" rather than a dashboard.
 */
function AuthShell({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={`
        position:fixed;inset:0;display:flex;align-items:center;
        justify-content:center;padding:20px;overflow:hidden;
        background:linear-gradient(135deg,#2400ff 0%,#0087ff 35%,#6c279d 70%,#691eff 100%)
      `}
    >
      {/* soft floating orbs for depth (pure decoration, GPU-friendly) */}
      <div
        aria-hidden="true"
        style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle at 20% 30%, rgba(255,255,255,0.12) 0%, transparent 40%), radial-gradient(circle at 80% 70%, rgba(255,255,255,0.08) 0%, transparent 45%);"
      />
      <div
        style={`
          width:100%;max-width:420px;padding:40px 36px;
          display:flex;flex-direction:column;align-items:center;
          gap:16px;text-align:center;position:relative;z-index:1;
          background:#fff;border-radius:16px;
          box-shadow:0 25px 50px -12px rgba(0,0,0,.25);
          color:#0a0a0a
        `}
      >
        <style>{`
          @keyframes memos-auth-logo-float {
            0%, 100% { transform: translateY(0); }
            50%      { transform: translateY(-6px); }
          }
          .memos-auth-logo-img {
            animation: memos-auth-logo-float 3s ease-in-out infinite;
          }
          .memos-auth-input {
            width: 100%;
            padding: 12px 16px;
            border: 1px solid hsl(0, 0%, 89.8%);
            border-radius: 10px;
            font-size: 14px;
            outline: none;
            background: #fff;
            color: #0a0a0a;
            transition: border-color .15s, box-shadow .15s;
            box-sizing: border-box;
          }
          .memos-auth-input::placeholder { color: hsl(0, 0%, 45.1%); }
          .memos-auth-input:focus {
            border-color: #6c279d;
            box-shadow: 0 0 0 3px rgba(108, 39, 157, .15);
          }
          .memos-auth-submit {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 10px;
            font-weight: 600;
            font-size: 14px;
            color: #fff;
            background: linear-gradient(135deg, #6c279d 0%, #691eff 100%);
            cursor: pointer;
            transition: transform .1s, box-shadow .15s, opacity .15s;
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          }
          .memos-auth-submit:hover:not(:disabled) {
            box-shadow: 0 6px 20px -6px rgba(108, 39, 157, .55);
          }
          .memos-auth-submit:disabled {
            opacity: .55; cursor: not-allowed;
          }
        `}</style>
        {children}
      </div>
    </div>
  );
}

function AuthLogo() {
  const agent = health.value?.agent;
  const src =
    agent === "hermes"
      ? "hermes-logo.svg"
      : agent === "openclaw"
      ? "openclaw-logo.svg"
      : "memos-logo.svg";
  return (
    <div style="display:flex;align-items:center;justify-content:center;margin-bottom:4px">
      <img
        class="memos-auth-logo-img"
        src={src}
        alt={agent ?? "MemOS"}
        width={64}
        height={64}
        style="display:block;filter:drop-shadow(0 8px 20px rgba(108,39,157,.35))"
      />
    </div>
  );
}

function AuthHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style="margin-bottom:4px">
      <h1 style="margin:0;font-size:22px;font-weight:700;color:#0a0a0a;letter-spacing:-.02em">
        {title}
      </h1>
      <p style="margin:6px 0 0;font-size:13px;color:hsl(0,0%,45.1%)">
        {subtitle}
      </p>
    </div>
  );
}

function AuthField({
  label,
  type,
  value,
  onInput,
  autoFocus,
}: {
  label: string;
  type: string;
  value: string;
  onInput: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label style="display:flex;flex-direction:column;gap:6px;text-align:left;width:100%">
      <span style="font-size:12px;font-weight:500;color:hsl(0,0%,45.1%)">
        {label}
      </span>
      <input
        class="memos-auth-input"
        type={type}
        value={value}
        autoFocus={autoFocus}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      />
    </label>
  );
}

function AuthError({ text }: { text: string }) {
  return (
    <div
      style={`
        display:flex;align-items:center;gap:6px;
        color:hsl(0 84.2% 60.2%);font-size:13px;
        padding:8px 12px;
        background:rgba(239,68,68,.08);
        border-radius:8px;text-align:left;width:100%
      `}
    >
      <Icon name="circle-alert" size={14} />
      <span>{text}</span>
    </div>
  );
}
