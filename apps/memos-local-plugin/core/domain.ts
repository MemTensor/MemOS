/**
 * Task-domain presets. IR-only retrieval/render behaviors are gated on
 * `domain === "ir"` so normal agent sessions stay on the default path.
 */

export type MemosDomain = "" | "ir";

export function isIrDomain(domain: string | undefined | null): domain is "ir" {
  return domain === "ir";
}

export function effectiveSkillInjectionMode(config: {
  domain?: string;
  skillInjectionMode?: "summary" | "full";
}): "summary" | "full" {
  if (!isIrDomain(config.domain)) return "summary";
  return config.skillInjectionMode ?? "summary";
}

export function effectiveReadOnlyInjectionProfile(
  config: {
    domain?: string;
    readOnlyInjectionProfile?:
      | "all"
      | "experience"
      | "skill"
      | "skill_experience";
  },
): "all" | "experience" | "skill" | "skill_experience" {
  if (!isIrDomain(config.domain)) return "all";
  return config.readOnlyInjectionProfile ?? "all";
}
