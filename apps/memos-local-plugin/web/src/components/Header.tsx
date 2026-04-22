/**
 * Top bar — brand (logo + version pill), global search, peer agents,
 * theme + language switchers. The notification bell was removed in
 * favour of inline toasts; per-event status now surfaces in Logs/Live.
 */
import { useState, useEffect } from "preact/hooks";
import { t } from "../stores/i18n";
import { health } from "../stores/health";
import { peers, discoverPeers } from "../stores/peers";
import { Icon } from "./Icon";
import { navigate } from "../stores/router";
import { ThemeLangFooter } from "./ThemeLangFooter";

export function Header() {
  const h = health.value;
  const [searchQ, setSearchQ] = useState("");

  const runSearch = (e: Event) => {
    e.preventDefault();
    const q = searchQ.trim();
    if (!q) return;
    navigate("/memories", { q });
  };

  // Discover other agent viewers running on nearby ports once after
  // health is known. Updates `peers` for the agent switcher.
  const peerList = peers.value;
  useEffect(() => {
    if (!h?.agent) return;
    void discoverPeers();
  }, [h?.agent]);

  return (
    <div class="topbar">
      <div class="topbar__brand">
        {/*
         * Brand: local MemOS logo + a small OpenClaw/Hermes agent icon.
         */}
        <span class="topbar__brand-mark" aria-hidden="true">
          <img
            src="logo.svg"
            alt="MemOS"
            width={24}
            height={24}
            style="display:block"
          />
        </span>
        <div class="topbar__brand-text">
          <span class="topbar__brand-title">{t("header.brand")}</span>
          <span class="topbar__brand-sub">{t("header.subtitle")}</span>
        </div>
        {h?.agent && (
          <span
            class="topbar__agent-mark"
            title={h.agent}
            aria-label={h.agent}
            style="margin-left:var(--sp-2);display:inline-flex;align-items:center"
          >
            {/*
             * Match the MemOS brand pill's visible glyph size (24×24).
             * Previously the agent mark was 22×22 and sat naked —
             * without the indigo container `.topbar__brand-mark` the
             * eye perceives a smaller silhouette. Bumping the image to
             * 28 closes the gap so MemOS and OpenClaw/Hermes marks
             * read as equal in the top bar.
             */}
            <img
              src={h.agent === "hermes" ? "hermes-logo.svg" : "openclaw-logo.svg"}
              alt={h.agent}
              width={28}
              height={28}
              style="display:block"
            />
          </span>
        )}
        {peerList.length > 0 && (
          <div
            class="hstack"
            style="gap:4px;margin-left:var(--sp-2)"
            aria-label={t("header.agent.peers")}
          >
            {peerList.map((p) => (
              <a
                key={p.port}
                class="pill pill--agent-link"
                href={p.url}
                title={`${p.agent} @ ${p.url}`}
              >
                <Icon name="arrow-up-right" size={10} />
                {p.agent}
              </a>
            ))}
          </div>
        )}
      </div>

      <div class="topbar__center">
        <form
          role="search"
          class="topbar__search-form"
          autocomplete="off"
          onSubmit={runSearch}
        >
          <label class="topbar__search">
            <span class="topbar__search-icon">
              <Icon name="search" size={16} />
            </span>
            <input
              type="search"
              name="memos-search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellcheck={false}
              placeholder={t("header.search.placeholder")}
              aria-label={t("common.search")}
              value={searchQ}
              onInput={(e) => setSearchQ((e.target as HTMLInputElement).value)}
            />
          </label>
        </form>
      </div>

      <div class="topbar__actions">
        <ThemeLangFooter inline />
      </div>
    </div>
  );
}
