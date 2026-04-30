/**
 * Sidebar navigation — primary app nav with real Lucide icons and
 * translation-aware labels. Each item is declared in a single place
 * (NAV_ITEMS) so adding a new view is one line.
 */
import { route, navigate } from "../stores/router";
import { t } from "../stores/i18n";
import { Icon, type IconName } from "./Icon";
import { health, type BridgeHealthStatus, type HealthPayload } from "../stores/health";

interface NavItem {
  path: string;
  icon: IconName;
  labelKey:
    | "nav.overview"
    | "nav.memories"
    | "nav.tasks"
    | "nav.skills"
    | "nav.policies"
    | "nav.worldModels"
    | "nav.analytics"
    | "nav.logs"
    | "nav.import"
    | "nav.settings"
    | "nav.help";
}

interface NavSection {
  titleKey: "nav.section.work" | "nav.section.insights" | "nav.section.system";
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    titleKey: "nav.section.work",
    items: [
      { path: "/overview", icon: "layers", labelKey: "nav.overview" },
      { path: "/memories", icon: "brain-circuit", labelKey: "nav.memories" },
      { path: "/tasks", icon: "list-checks", labelKey: "nav.tasks" },
      { path: "/skills", icon: "wand-sparkles", labelKey: "nav.skills" },
      { path: "/policies", icon: "sparkles", labelKey: "nav.policies" },
      { path: "/world-models", icon: "globe", labelKey: "nav.worldModels" },
    ],
  },
  {
    titleKey: "nav.section.insights",
    items: [
      { path: "/analytics", icon: "bar-chart-3", labelKey: "nav.analytics" },
      { path: "/logs", icon: "scroll-text", labelKey: "nav.logs" },
    ],
  },
  {
    titleKey: "nav.section.system",
    items: [
      { path: "/import", icon: "arrow-down-up", labelKey: "nav.import" },
      // "Team Admin" used to be a standalone sidebar entry — it
      // duplicated the Settings → Team Sharing tab and confused
      // users about where to manage hub membership. Mirror the
      // legacy viewer's IA: hub management lives exclusively under
      // Settings and gets revealed as sub-options only when the
      // user flips the "enable sharing" switch on that tab.
      { path: "/settings", icon: "settings-2", labelKey: "nav.settings" },
      // Documentation entry — explains every page's metadata
      // (V/α/priority, skill statuses, share scopes, etc.) so users
      // never have to guess what an unfamiliar score means.
      { path: "/help", icon: "book-open", labelKey: "nav.help" },
    ],
  },
];

export function Sidebar() {
  const current = route.value.path;
  const h = health.value;
  const statusColor = !h
    ? "var(--fg-dim)"
    : h.llm?.available && h.embedder?.available
    ? "var(--success)"
    : "var(--warning)";
  const bridge = h?.bridge;
  const bridgeVisual = bridgeVisualFor(bridge?.status ?? "unknown");
  const bridgeTitle = bridge ? bridgeTooltip(bridge) : "";

  return (
    <aside class="sidebar">
      {SECTIONS.map((section) => (
        <div key={section.titleKey}>
          <div class="sidebar__section">{t(section.titleKey)}</div>
          {section.items.map((item) => {
            const active = current === item.path;
            return (
              <a
                key={item.path}
                class="sidebar__item"
                href={`#${item.path}`}
                aria-current={active ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(item.path);
                }}
              >
                <Icon name={item.icon} size={18} />
                <span class="sidebar__item-label">{t(item.labelKey)}</span>
              </a>
            );
          })}
        </div>
      ))}

      {h?.version && (
        <div class="sidebar__status">
          <div class="sidebar__version" title={`v${h.version}`}>
            <span
              class="dot"
              aria-hidden="true"
              style={`width:6px;height:6px;border-radius:999px;background:${statusColor};box-shadow:0 0 0 3px color-mix(in srgb, ${statusColor} 20%, transparent)`}
            />
            <span class="sidebar__version-text">v{h.version}</span>
          </div>
          {bridge && (
            <div class="sidebar__bridge" title={bridgeTitle}>
              <span
                class="dot"
                aria-hidden="true"
                style={`width:6px;height:6px;border-radius:999px;background:${bridgeVisual.color};box-shadow:0 0 0 3px color-mix(in srgb, ${bridgeVisual.color} 20%, transparent)`}
              />
              <span class="sidebar__bridge-text">{t(bridgeVisual.labelKey)}</span>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function bridgeVisualFor(status: BridgeHealthStatus): {
  color: string;
  labelKey:
    | "bridge.connected"
    | "bridge.reconnecting"
    | "bridge.disconnected"
    | "bridge.unknown";
} {
  switch (status) {
    case "connected":
      return { color: "var(--success)", labelKey: "bridge.connected" };
    case "reconnecting":
      return { color: "var(--warning)", labelKey: "bridge.reconnecting" };
    case "disconnected":
      return { color: "var(--red)", labelKey: "bridge.disconnected" };
    case "unknown":
    default:
      return { color: "var(--fg-dim)", labelKey: "bridge.unknown" };
  }
}

function bridgeTooltip(bridge: NonNullable<HealthPayload["bridge"]>): string {
  const parts = [t("bridge.tooltip")];
  if (bridge.lastOkAt) {
    parts.push(t("bridge.tooltip.lastOk", { ts: new Date(bridge.lastOkAt).toLocaleTimeString() }));
  }
  if (bridge.status !== "connected" && bridge.lastError) {
    parts.push(t("bridge.tooltip.lastError", { msg: bridge.lastError }));
  }
  return parts.join("\n");
}
