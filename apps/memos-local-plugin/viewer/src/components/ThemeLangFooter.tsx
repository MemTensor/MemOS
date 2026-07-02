/**
 * Theme + language toggles. Used both as a sidebar footer and (with
 * `inline`) as a compact group inside the topbar.
 */
import { theme, cycleTheme, type Theme } from "../stores/theme";
import { locale, setLocale } from "../stores/i18n";
import { Icon } from "./Icon";
import { t } from "../stores/i18n";

interface ThemeLangFooterProps {
  inline?: boolean;
}

export function ThemeLangFooter({ inline = false }: ThemeLangFooterProps) {
  const currentTheme = theme.value;
  const currentLocale = locale.value;
  const wrapperClass = inline ? "theme-lang theme-lang--inline" : "sidebar__footer";

  return (
    <div class={wrapperClass}>
      <div class="segmented" role="group" aria-label={t("settings.general.theme")}>
        <ThemeChoice theme="auto"  icon="monitor" current={currentTheme} />
        <ThemeChoice theme="light" icon="sun"     current={currentTheme} />
        <ThemeChoice theme="dark"  icon="moon"    current={currentTheme} />
      </div>
      <div class="segmented" role="group" aria-label={t("settings.general.lang")}>
        <button
          class="segmented__item"
          aria-pressed={currentLocale === "en"}
          onClick={() => setLocale("en")}
        >
          EN
        </button>
        <button
          class="segmented__item"
          aria-pressed={currentLocale === "zh"}
          onClick={() => setLocale("zh")}
        >
          中
        </button>
      </div>
    </div>
  );
}

function ThemeChoice({
  theme: t,
  icon,
  current,
}: {
  theme: Theme;
  icon: "monitor" | "sun" | "moon";
  current: Theme;
}) {
  return (
    <button
      class="segmented__item"
      aria-pressed={current === t}
      onClick={() => cycleTheme(t)}
      title={t}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}
