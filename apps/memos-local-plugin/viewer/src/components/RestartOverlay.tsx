/**
 * Restart overlay.
 *
 * IMPORTANT: config saves must never fall back to a "settings saved"
 * toast/card. OpenClaw restarts the gateway; Hermes terminates the
 * active `hermes chat` process while keeping the Memory Viewer daemon
 * online. DeepSeek Harness returns a manual profile-restart handoff. All
 * flows use this full-screen overlay instead of a passive success card.
 */
import {
  restartState,
  dismissRestartBanner,
  resolveRestartAgent,
  type RestartPhase,
} from "../stores/restart";
import { t } from "../stores/i18n";
import { Icon } from "./Icon";

function FullScreenSpinner() {
  const s = restartState.value;
  const agentType = resolveRestartAgent();
  const message = overlayMessage(s.phase, agentType, s.message);
  const hint = overlayHint(s.phase, agentType);
  const terminal = isTerminalPhase(s.phase);
  const dismissible = terminal && !(
    s.phase === "manualRestartRequired" && agentType === "hermes"
  );

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
        {!terminal ? (
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
        {dismissible && (
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

type AgentType = "openclaw" | "hermes" | "deepseek-harness";

function overlayMessage(
  phase: RestartPhase,
  agentType: AgentType,
  responseMessage?: string,
): string {
  switch (phase) {
    case "manualCloseRequired":
      return t("restart.manualClose");
    case "manualClearRestartRequired":
      return t("restart.clearComplete");
    case "clearFailed":
      return t("restart.clearFailed");
    case "clearResultUnknown":
      return t("restart.clearResultUnknown");
    case "clearing":
      return t("restart.clearing");
    case "manualRestartRequired":
      return agentType === "hermes"
        ? t("restart.manual.hermes")
        : responseMessage ?? t("restart.manual");
    case "restartFailed":
      return t("restart.failed");
    case "waitingUp":
      return t("restart.waitingUp");
    default:
      return agentType === "hermes"
        ? t("restart.restarting.hermes")
        : t("restart.restarting");
  }
}

function overlayHint(phase: RestartPhase, agentType: AgentType): string {
  switch (phase) {
    case "manualCloseRequired":
      return t("restart.manualCloseHint");
    case "manualClearRestartRequired":
      return t(`restart.clearCompleteHint.${agentType}` as any);
    case "clearFailed":
      return t(`restart.clearFailedHint.${agentType}` as any);
    case "clearResultUnknown":
      return t(`restart.clearResultUnknownHint.${agentType}` as any);
    case "manualRestartRequired":
      return t(`restart.manualHint.${agentType}` as any);
    case "restartFailed":
      return t(`restart.failedHint.${agentType}` as any);
    default:
      return t("restart.autoRefresh");
  }
}

function isTerminalPhase(phase: RestartPhase): boolean {
  return [
    "restartFailed",
    "manualRestartRequired",
    "manualClearRestartRequired",
    "clearFailed",
    "clearResultUnknown",
    "manualCloseRequired",
  ].includes(phase);
}

export function RestartOverlay() {
  const s = restartState.value;
  if (s.phase === "idle") return null;
  return <FullScreenSpinner />;
}
