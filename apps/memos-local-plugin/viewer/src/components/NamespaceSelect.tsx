import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";

export interface NamespaceOption {
  agentKind: string;
  profileId: string;
  count: number;
}

interface NamespaceResponse {
  namespaces: NamespaceOption[];
}

interface NamespaceSelectProps {
  value: string;
  onChange: (value: string) => void;
}

export function NamespaceSelect({ value, onChange }: NamespaceSelectProps) {
  const [options, setOptions] = useState<NamespaceOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<NamespaceResponse>("/api/v1/diag/namespace")
      .then((res) => {
        if (!cancelled) setOptions(res.namespaces ?? []);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <label class="namespace-select" aria-label={t("memories.filter.namespace")}>
      <span class="sr-only">
        {t("memories.filter.namespace")}
      </span>
      <select
        class="select select--namespace"
        value={value}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
      >
        <option value="">{t("memories.filter.namespace.all")}</option>
        {options.map((opt) => (
          <option
            key={namespaceKey(opt)}
            value={namespaceKey(opt)}
            title={t("memories.filter.namespace.count", { n: opt.count })}
          >
            {namespaceLabel(opt)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function appendNamespaceParams(qs: URLSearchParams, value: string): void {
  const ns = parseNamespaceFilter(value);
  if (!ns) return;
  qs.set("ownerAgentKind", ns.agentKind);
  qs.set("ownerProfileId", ns.profileId);
}

export function namespaceKey(ns: Pick<NamespaceOption, "agentKind" | "profileId">): string {
  return `${ns.agentKind}/${ns.profileId}`;
}

export function namespaceLabel(ns: Pick<NamespaceOption, "agentKind" | "profileId">): string {
  return `${ns.agentKind}/${ns.profileId}`;
}

export function agentClass(agent: string): string {
  return agent === "openclaw" || agent === "hermes" ? agent : "unknown";
}

function parseNamespaceFilter(value: string): { agentKind: string; profileId: string } | null {
  if (!value) return null;
  const [agentKind, profileId] = value.split("/", 2);
  if (!agentKind || !profileId) return null;
  return { agentKind, profileId };
}
