/**
 * Read-only eval injection scopes. `all` keeps the normal tool_driven tier
 * mix; other profiles override which tiers are retrieved before prompt.
 */
export type ReadOnlyInjectionProfile =
  | "all"
  | "experience"
  | "skill"
  | "skill_experience";

export interface InjectionProfilePlan {
  scenarioId?: string;
  wantTier1?: boolean;
  wantTier2?: boolean;
  wantTier3?: boolean;
  experienceOnly?: boolean;
  limit?: number;
}

export function resolveInjectionProfilePlan(
  profile: ReadOnlyInjectionProfile | undefined,
): InjectionProfilePlan | undefined {
  switch (profile) {
    case "experience":
      return {
        wantTier1: false,
        wantTier2: true,
        wantTier3: false,
        experienceOnly: true,
      };
    case "skill":
      return {
        wantTier1: true,
        wantTier2: false,
        wantTier3: false,
      };
    case "skill_experience":
      return {
        wantTier1: true,
        wantTier2: true,
        wantTier3: false,
        experienceOnly: true,
      };
    case "all":
    default:
      return undefined;
  }
}

export function mergeRetrievePlanOverride(
  ...layers: Array<InjectionProfilePlan | undefined>
): InjectionProfilePlan | undefined {
  const merged: InjectionProfilePlan = {};
  for (const layer of layers) {
    if (!layer) continue;
    Object.assign(merged, layer);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
