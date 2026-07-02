import { route } from "../stores/router";
import { OverviewView } from "../views/OverviewView";
import { MemoriesView } from "../views/MemoriesView";
import { TasksView } from "../views/TasksView";
import { SkillsView } from "../views/SkillsView";
import { PoliciesView } from "../views/PoliciesView";
import { WorldModelsView } from "../views/WorldModelsView";
import { AnalyticsView } from "../views/AnalyticsView";
import { LogsView } from "../views/LogsView";
import { ImportView } from "../views/ImportView";
import { SettingsView } from "../views/SettingsView";
import { HelpView } from "../views/HelpView";
import { Icon } from "./Icon";
import { t } from "../stores/i18n";

export function ContentRouter() {
  const path = route.value.path;
  // Allow deep-linking into a specific Settings tab via `?tab=models|hub|general`,
  // e.g. clicking a model card on the Overview page navigates to
  // `#/settings?tab=models` and lands directly on the AI models tab.
  const settingsTabParam = route.value.params.tab;
  const settingsTab =
    settingsTabParam === "models" ||
    settingsTabParam === "hub" ||
    settingsTabParam === "general"
      ? settingsTabParam
      : undefined;
  switch (path) {
    case "/overview":     return <OverviewView />;
    case "/memories":     return <MemoriesView />;
    case "/tasks":        return <TasksView />;
    case "/skills":       return <SkillsView />;
    case "/policies":     return <PoliciesView />;
    case "/world-models": return <WorldModelsView />;
    case "/analytics":    return <AnalyticsView />;
    case "/logs":         return <LogsView />;
    case "/import":       return <ImportView />;
    // Legacy `/admin` deep-link — the top-level sidebar entry was
    // removed, but old bookmarks still work by landing directly on
    // Settings → Team Sharing.
    case "/admin":        return <SettingsView initialTab="hub" />;
    case "/settings":     return <SettingsView initialTab={settingsTab} />;
    case "/help":         return <HelpView />;
    default:
      return (
        <div class="empty">
          <div class="empty__icon">
            <Icon name="info" size={24} />
          </div>
          <div class="empty__title">{t("common.empty")}</div>
          <div class="empty__hint">
            <code class="mono">{path}</code>
          </div>
        </div>
      );
  }
}
