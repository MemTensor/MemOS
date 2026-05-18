/**
 * Top bar — brand (logo + version pill), global search with categorized
 * dropdown, peer agents, theme + language switchers.
 */
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { t } from "../stores/i18n";
import { health } from "../stores/health";
import { peers, discoverPeers } from "../stores/peers";
import { Icon, type IconName } from "./Icon";
import { navigate } from "../stores/router";
import { ThemeLangFooter } from "./ThemeLangFooter";
import { api } from "../api/client";

interface SearchCategory {
  key: string;
  icon: IconName;
  labelKey: string;
  route: string;
  items: { id: string; text: string }[];
  loading: boolean;
}

export function Header() {
  const h = health.value;
  const [searchQ, setSearchQ] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [categories, setCategories] = useState<SearchCategory[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = (e: Event) => {
    e.preventDefault();
    const q = searchQ.trim();
    if (!q) return;
    setShowDropdown(false);
    navigate("/memories", { q });
  };

  const fetchResults = useCallback(async (q: string) => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const empty: SearchCategory[] = [
      { key: "memories", icon: "brain-circuit", labelKey: "nav.memories", route: "/memories", items: [], loading: true },
      { key: "tasks", icon: "list-checks", labelKey: "nav.tasks", route: "/tasks", items: [], loading: true },
      { key: "skills", icon: "wand-sparkles", labelKey: "nav.skills", route: "/skills", items: [], loading: true },
      { key: "policies", icon: "sparkles", labelKey: "nav.policies", route: "/policies", items: [], loading: true },
      { key: "world-models", icon: "globe", labelKey: "nav.worldModels", route: "/world-models", items: [], loading: true },
    ];
    setCategories(empty);
    setShowDropdown(true);

    const signal = ctrl.signal;
    const limit = 3;

    const fetchers = [
      api
        .get<{ traces: { id: string; summary?: string; userText?: string }[] }>(
          `/api/v1/traces?q=${encodeURIComponent(q)}&limit=${limit}`,
          { signal },
        )
        .then((r) =>
          (r.traces ?? []).map((t) => ({
            id: t.id,
            text: (t.summary || t.userText || "").slice(0, 80),
          })),
        )
        .catch(() => [] as { id: string; text: string }[]),

      api
        .get<{ episodes: { id: string; preview?: string }[] }>(
          `/api/v1/episodes?q=${encodeURIComponent(q)}&limit=${limit}`,
          { signal },
        )
        .then((r) =>
          (r.episodes ?? []).map((ep) => ({
            id: ep.id,
            text: (ep.preview || "").slice(0, 80),
          })),
        )
        .catch(() => [] as { id: string; text: string }[]),

      api
        .get<{ skills: { id: string; name: string }[] }>(
          `/api/v1/skills?q=${encodeURIComponent(q)}&limit=${limit}`,
          { signal },
        )
        .then((r) =>
          (r.skills ?? []).map((s) => ({
            id: s.id,
            text: s.name,
          })),
        )
        .catch(() => [] as { id: string; text: string }[]),

      api
        .get<{ policies: { id: string; title?: string; trigger?: string }[] }>(
          `/api/v1/policies?q=${encodeURIComponent(q)}&limit=${limit}`,
          { signal },
        )
        .then((r) =>
          (r.policies ?? []).map((p) => ({
            id: p.id,
            text: (p.title || p.trigger || "").slice(0, 80),
          })),
        )
        .catch(() => [] as { id: string; text: string }[]),

      api
        .get<{ worldModels: { id: string; title?: string }[] }>(
          `/api/v1/world-models?q=${encodeURIComponent(q)}&limit=${limit}`,
          { signal },
        )
        .then((r) =>
          (r.worldModels ?? []).map((w) => ({
            id: w.id,
            text: (w.title || "").slice(0, 80),
          })),
        )
        .catch(() => [] as { id: string; text: string }[]),
    ];

    const results = await Promise.allSettled(fetchers);
    if (signal.aborted) return;

    setCategories((prev) =>
      prev.map((cat, i) => ({
        ...cat,
        items: results[i].status === "fulfilled" ? results[i].value : [],
        loading: false,
      })),
    );
  }, []);

  useEffect(() => {
    const q = searchQ.trim();
    if (!q) {
      setShowDropdown(false);
      setCategories([]);
      return;
    }
    const timer = setTimeout(() => void fetchResults(q), 250);
    return () => clearTimeout(timer);
  }, [searchQ, fetchResults]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleItemClick = (cat: SearchCategory, itemId: string) => {
    setShowDropdown(false);
    setSearchQ("");
    navigate(cat.route, { q: searchQ.trim() });
  };

  const handleCategoryMore = (cat: SearchCategory) => {
    setShowDropdown(false);
    setSearchQ("");
    navigate(cat.route, { q: searchQ.trim() });
  };

  const peerList = peers.value;
  useEffect(() => {
    if (!h?.agent) return;
    void discoverPeers();
  }, [h?.agent]);

  const totalResults = categories.reduce((sum, c) => sum + c.items.length, 0);
  const anyLoading = categories.some((c) => c.loading);

  return (
    <div class="topbar">
      <div class="topbar__brand">
        <span class="topbar__brand-mark" aria-hidden="true">
          <img
            src="memos-logo.svg"
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
                target="_blank"
                rel="noopener"
                title={`${p.agent} @ ${p.url}`}
              >
                <Icon name="arrow-up-right" size={10} />
                {p.agent}
              </a>
            ))}
          </div>
        )}
      </div>

      <div class="topbar__center" ref={containerRef}>
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
              onFocus={() => {
                if (searchQ.trim() && categories.length > 0) setShowDropdown(true);
              }}
            />
          </label>
        </form>

        {showDropdown && (
          <div class="search-dropdown">
            {anyLoading && totalResults === 0 && (
              <div class="search-dropdown__loading">
                <Icon name="loader-2" size={14} />
                <span>{t("common.search")}...</span>
              </div>
            )}
            {!anyLoading && totalResults === 0 && (
              <div class="search-dropdown__empty">
                {t("header.search.noResults")}
              </div>
            )}
            {categories
              .filter((c) => c.items.length > 0)
              .map((cat) => (
                <div class="search-dropdown__section" key={cat.key}>
                  <div class="search-dropdown__section-header">
                    <Icon name={cat.icon} size={14} />
                    <span>{t(cat.labelKey as any)}</span>
                  </div>
                  <ul class="search-dropdown__list">
                    {cat.items.map((item) => (
                      <li key={item.id}>
                        <button
                          class="search-dropdown__item"
                          onClick={() => handleItemClick(cat, item.id)}
                        >
                          <span class="search-dropdown__item-text">
                            {item.text || item.id}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    class="search-dropdown__more"
                    onClick={() => handleCategoryMore(cat)}
                  >
                    {t("header.search.viewAll")} →
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>

      <div class="topbar__actions">
        <ThemeLangFooter inline />
      </div>
    </div>
  );
}
