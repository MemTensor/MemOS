export function areAllIdsSelected(
  selected: ReadonlySet<string>,
  ids: Iterable<string>,
): boolean {
  const pageIds = Array.from(new Set(ids));
  return pageIds.length > 0 && pageIds.every((id) => selected.has(id));
}

export function toggleIdsInSelection(
  selected: ReadonlySet<string>,
  ids: Iterable<string>,
): Set<string> {
  const pageIds = Array.from(new Set(ids));
  const next = new Set(selected);
  const shouldDeselect = areAllIdsSelected(selected, pageIds);

  for (const id of pageIds) {
    if (shouldDeselect) next.delete(id);
    else next.add(id);
  }

  return next;
}
