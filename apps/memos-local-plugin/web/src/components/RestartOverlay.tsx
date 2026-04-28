/**
 * Restart overlay — two UX modes:
 *
 *   - **OpenClaw** (auto-restart): full-screen spinner overlay styled after
 *     the legacy `memos-local-openclaw` viewer. The gateway is being
 *     restarted; we poll health and reload automatically.
 *
 *   - **Hermes / generic** (manual restart): bottom-of-screen toast that
 *     tells the user to restart the agent process themselves.
 */
import { restartState, dismissRestartBanner } from "../stores/restart";
import { health } from "../stores/health";
import { t } from "../stores/i18n";
import { Icon } from "./Icon";

function FullScreenSpinner() {
  const s = restartState.value;

  const message =
    s.phase === "restartFailed"
      ? t("restart.failed")
      : s.phase === "waitingUp"
        ? t("restart.waitingUp")
        : t("restart.restarting");

  const agentType = health.value?.agent === "openclaw" ? "openclaw" : "hermes";
  const hint =
    s.phase === "restartFailed"
      ? t(`restart.failedHint.${agentType}` as any)
      : t("restart.autoRefresh");

  return (
    <div
      role="status"
      aria-live="assertive"
      style={`
        position:fixed;inset:0;z-index:99999;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        background:rgba(0,0,0,.55);backdrop-filter:blur(6px);
        color:#fff;font-family:inherit;
      `}
    >
      <div
        style={`
          display:flex;flex-direction:column;align-items:center;
          gap:16px;max-width:400px;text-align:center;
        `}
      >
        {s.phase !== "restartFailed" ? (
          <div
            style={`
              width:36px;height:36px;
              border:3px solid rgba(255,255,255,.2);
              border-top-color:#fff;
              border-radius:50%;
              animation:restartSpin 1s linear infinite;
            `}
          />
        ) : (
          <Icon name="circle-alert" size={36} />
        )}
        <div style="font-size:15px;font-weight:600">{message}</div>
        <div style="font-size:12px;opacity:.6">{hint}</div>
        {s.phase === "restartFailed" && (
          <button
            class="btn btn--ghost btn--sm"
            onClick={dismissRestartBanner}
            style="color:#fff;border-color:rgba(255,255,255,.3);margin-top:8px"
          >
            {t("common.close")}
          </button>
        )}
      </div>
      <style>{`@keyframes restartSpin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function Toast() {
  const s = restartState.value;
  const agent = health.value?.agent ?? "agent";
  const restartHint =
    agent === "hermes"
      ? t("restart.hint.hermes")
      : t("restart.hint.generic");

  const title =
    s.phase === "cleared" ? t("restart.cleared") : t("restart.saved");

  return (
    <div
      role="status"
      aria-live="polite"
      style={`
        position:fixed;left:50%;bottom:24px;transform:translateX(-50%);
        z-index:1000;max-width:520px;width:calc(100% - 32px);
      `}
    >
      <div
        class="card"
        style={`
          padding:14px 18px;display:flex;align-items:flex-start;gap:12px;
          box-shadow:0 12px 32px -12px rgba(0,0,0,0.32);
        `}
      >
        <div style="flex-shrink:0;display:flex;align-items:center;color:var(--success)">
          <Icon name="circle-check" size={20} />
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:var(--fw-semi);font-size:var(--fs-md)">
            {title}
          </div>
          <div class="muted" style="font-size:var(--fs-sm);margin-top:2px">
            {restartHint}
          </div>
        </div>
        <button
          class="btn btn--ghost btn--sm"
          aria-label={t("common.close")}
          onClick={dismissRestartBanner}
          style="flex-shrink:0;padding:4px"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}

export function RestartOverlay() {
  const s = restartState.value;
  if (s.phase === "idle") return null;

  if (
    s.phase === "restarting" ||
    s.phase === "waitingUp" ||
    s.phase === "restartFailed"
  ) {
    return <FullScreenSpinner />;
  }

  return <Toast />;
}
