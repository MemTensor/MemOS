import { t } from "../stores/i18n";
import { effectiveShareScope, type ShareScope } from "../utils/share";

export function ShareScopePill({ scope }: { scope?: ShareScope | null }) {
  const effectiveScope = effectiveShareScope(scope);
  return (
    <span class={`pill pill--share-${effectiveScope}`}>
      {t(`memories.share.scope.${effectiveScope}` as never)}
    </span>
  );
}
