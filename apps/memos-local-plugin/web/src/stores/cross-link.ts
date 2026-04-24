/**
 * Cross-linking helpers.
 *
 * Every drawer-owning view (Memories / Tasks / Skills / Policies /
 * WorldModels) can be deep-linked via `#/<path>?id=<rowId>`. Clicking a
 * pill anywhere in the UI that references a row of another kind
 * should call `linkTo()` — the target view reads `route.params.id` on
 * mount and auto-opens its detail drawer.
 *
 * Keeping this tiny (navigate + URL-encode) so we don't take a
 * dependency on a real router library.
 */
import { navigate, route } from "./router";

export type EntityKind =
  | "memory"
  | "task"
  | "skill"
  | "policy"
  | "world-model";

const PATH_BY_KIND: Record<EntityKind, string> = {
  memory: "/memories",
  task: "/tasks",
  skill: "/skills",
  policy: "/policies",
  "world-model": "/world-models",
};

/**
 * Navigate to the target view with the row's id as a query param. The
 * destination view should watch `route.value.params.id` and open the
 * row's drawer when present (see e.g. `PoliciesView` mount effect).
 */
export function linkTo(kind: EntityKind, id: string): void {
  const path = PATH_BY_KIND[kind];
  if (!path || !id) return;
  navigate(path, { id });
}

/**
 * Read (and consume) the `?id=` param on the current route. Used by
 * views when they mount — they fetch the referenced row, open its
 * drawer, then optionally clear the param so browser back navigation
 * lands on the list view rather than re-triggering the drawer.
 */
export function takeEntryId(): string | null {
  return route.value.params.id ?? null;
}

/**
 * Clear the `id` param from the URL without triggering a view switch.
 * Call from a drawer's `onClose`.
 */
export function clearEntryId(): void {
  const current = route.value;
  if (!current.params.id) return;
  const rest: Record<string, string> = { ...current.params };
  delete rest.id;
  navigate(current.path, rest);
}
