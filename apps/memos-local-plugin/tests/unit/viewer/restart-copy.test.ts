import { afterEach, describe, expect, it } from "vitest";

import { locale, t } from "../../../viewer/src/stores/i18n";

describe("Hermes restart copy", () => {
  afterEach(() => {
    locale.value = "en";
  });

  it("sets expectations for the Windows Hermes initialization delay", () => {
    locale.value = "en";
    expect(t("restart.manual.hermes")).toBe(
      "Configuration saved. Restart Hermes to apply the changes.",
    );
    expect(t("restart.manualHint.hermes")).toContain("about 20–30 seconds");
    expect(t("restart.manualHint.hermes")).toContain("Keep this page open");

    locale.value = "zh";
    expect(t("restart.manual.hermes")).toBe(
      "配置已保存，请重启 Hermes 以应用更改。",
    );
    expect(t("restart.manualHint.hermes")).toContain("约 20–30 秒");
    expect(t("restart.manualHint.hermes")).toContain("请保持当前页面打开");
  });
});
