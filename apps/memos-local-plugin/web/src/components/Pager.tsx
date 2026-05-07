import { useEffect, useState } from "preact/hooks";
import { t } from "../stores/i18n";
import { Icon } from "./Icon";

interface PagerProps {
  page: number;
  totalItems: number;
  pageSize: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
  hasMore?: boolean;
  loading?: boolean;
  onPageChange: (page: number) => void;
}

export function Pager({
  page,
  totalItems,
  pageSize,
  pageSizeOptions = [10, 20, 25, 50],
  onPageSizeChange,
  hasMore,
  loading = false,
  onPageChange,
}: PagerProps) {
  const totalPages = Math.max(
    1,
    Math.ceil(totalItems / pageSize),
    page + 1 + (hasMore ? 1 : 0),
  );
  const canGoNext = page + 1 < totalPages;
  const [draft, setDraft] = useState(String(page + 1));
  const pageItems = buildPageItems(page + 1, totalPages);

  useEffect(() => {
    setDraft(String(page + 1));
  }, [page]);

  const goTo = (nextPage: number) => {
    const clamped = Math.min(totalPages - 1, Math.max(0, nextPage));
    if (clamped !== page) onPageChange(clamped);
  };

  const submitJump = (event: Event) => {
    event.preventDefault();
    const pageNumber = Number.parseInt(draft, 10);
    if (Number.isFinite(pageNumber)) goTo(pageNumber - 1);
    else setDraft(String(page + 1));
  };

  return (
    <div class="pager">
      <button
        class="pager__nav"
        disabled={page === 0 || loading}
        onClick={() => goTo(page - 1)}
        aria-label={t("common.prev")}
        title={t("common.prev")}
      >
        <Icon name="chevron-left" size={14} />
      </button>

      <div class="pager__pages" aria-label={t("pager.pageOfTotal", { n: page + 1, total: totalPages })}>
        {pageItems.map((item, index) =>
          item === "ellipsis" ? (
            <span class="pager__ellipsis" key={`ellipsis-${index}`}>...</span>
          ) : (
            <button
              class="pager__page-btn"
              key={item}
              type="button"
              disabled={loading}
              aria-current={item === page + 1 ? "page" : undefined}
              onClick={() => goTo(item - 1)}
            >
              {item}
            </button>
          )
        )}
      </div>

      <button
        class="pager__nav"
        disabled={!canGoNext || loading}
        onClick={() => goTo(page + 1)}
        aria-label={t("common.next")}
        title={t("common.next")}
      >
        <Icon name="chevron-right" size={14} />
      </button>

      <div class="pager__spacer" />

      <span class="muted pager__summary" style="font-size:var(--fs-xs);white-space:nowrap">
        {t("pager.totalPerPage", { total: totalItems, pageSize })}
      </span>

      <label class="pager__page-size">
        <select
          class="select pager__page-size-select"
          value={pageSize}
          disabled={loading || !onPageSizeChange}
          onChange={(event) => {
            const nextSize = Number.parseInt((event.target as HTMLSelectElement).value, 10);
            if (Number.isFinite(nextSize) && nextSize !== pageSize) onPageSizeChange?.(nextSize);
          }}
          aria-label={t("pager.pageSize.label")}
        >
          {Array.from(new Set([...pageSizeOptions, pageSize])).sort((a, b) => a - b).map((option) => (
            <option key={option} value={option}>
              {t("pager.pageSize.option", { pageSize: option })}
            </option>
          ))}
        </select>
      </label>

      <form class="pager__jump" onSubmit={submitJump}>
        <span class="pager__jump-label">
          {t("pager.jump.label")}
        </span>
        <input
          class="input pager__jump-input"
          type="number"
          min={1}
          max={totalPages}
          value={draft}
          disabled={loading}
          onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
          aria-label={t("pager.jump.label")}
        />
        <button
          class="sr-only"
          type="submit"
          disabled={loading}
          aria-label={t("pager.jump.go")}
          title={t("pager.jump.go")}
        >
          {t("pager.jump.go")}
        </button>
        <span class="pager__jump-label">
          {t("pager.jump.pageUnit")}
        </span>
      </form>
    </div>
  );
}

type PageItem = number | "ellipsis";

function buildPageItems(currentPage: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis", totalPages];
  }

  if (currentPage >= totalPages - 3) {
    return [1, "ellipsis", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages];
}
