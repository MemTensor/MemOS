import * as path from "path";

/**
 * Derive the default owner from the workspace directory name.
 *
 * Convention: a workspace directory named "workspace-<agentName>" maps to
 * "agent:<agentName>".  If the directory name does not follow that pattern
 * (or no workspaceDir is provided) the fallback is "agent:main".
 */
export function resolveDefaultOwner(workspaceDir?: string): string {
  if (workspaceDir) {
    const base = path.basename(workspaceDir);
    const match = base.match(/^workspace-(.+)$/);
    if (match) {
      return `agent:${match[1]}`;
    }
  }
  return "agent:main";
}

/**
 * Build the owner filter array used for queries.
 *
 * If the caller supplied an explicit `owner` value it takes precedence;
 * otherwise the `defaultOwner` (derived from workspace context) is used.
 */
export function resolveOwnerFilter(owner: unknown, defaultOwner: string = "agent:main"): string[] {
  const resolvedOwner = typeof owner === "string" && owner.trim().length > 0 ? owner : defaultOwner;
  return resolvedOwner === "public" ? ["public"] : [resolvedOwner, "public"];
}
