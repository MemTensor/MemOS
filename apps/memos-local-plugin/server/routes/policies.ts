/**
 * Policies ("经验") and World Models ("世界环境知识") REST routes.
 *
 * Both panels live on the same conceptual rung as Memories: a
 * newest-first listing with search, single-row GET, status toggles,
 * and hard delete. The backing data comes from
 * `handle.repos.policies` / `handle.repos.worldModel`, surfaced on
 * `MemoryCore` via:
 *
 *   - `listPolicies({ status?, limit, offset, q })`
 *   - `setPolicyStatus(id, status)`   // candidate → active → archived
 *   - `deletePolicy(id)`
 *   - `listWorldModels({ limit, offset, q })`
 *   - `deleteWorldModel(id)`
 *   - `getPolicy(id)` / `getWorldModel(id)`  (pre-existing)
 *
 * The viewer's **PoliciesView** and **WorldModelsView** call
 * exclusively through this file. We don't talk to the repos directly
 * from the HTTP layer — that'd skip the `ensureLive` / RLS guards
 * the core applies for us.
 */
import type { PolicyDTO } from "../../agent-contract/dto.js";
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

export function registerPoliciesRoutes(routes: Routes, deps: ServerDeps): void {
  // ─── Policies (L2 "经验") ────────────────────────────────────────

  routes.set("GET /api/v1/policies", async (ctx) => {
    const params = ctx.url.searchParams;
    const parsedLimit = Number(params.get("limit"));
    const parsedOffset = Number(params.get("offset"));
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
    const offset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
    const statusRaw = params.get("status");
    const status = isValidPolicyStatus(statusRaw) ? statusRaw : undefined;
    const q = params.get("q") || undefined;
    const policies = await deps.core.listPolicies({ status, limit, offset, q });
    return {
      policies,
      limit,
      offset,
      nextOffset: policies.length === limit ? offset + limit : undefined,
    };
  });

  routes.setPattern("GET /api/v1/policies/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const policy = await deps.core.getPolicy(id);
    if (!policy) {
      writeError(ctx, 404, "not_found", `policy not found: ${id}`);
      return;
    }
    return policy;
  });

  /**
   * PATCH /api/v1/policies/:id — transition status and/or edit body
   * fields. Body shape (all optional, at least one required):
   *
   *   {
   *     status?: 'candidate' | 'active' | 'archived',
   *     title?, trigger?, procedure?, verification?, boundary?: string
   *   }
   *
   * Pre-existing callers that only sent `{status}` keep working — the
   * viewer's "启用 / 停用 / 归档" buttons still hit this endpoint with
   * just the status flag.
   */
  routes.setPattern("PATCH /api/v1/policies/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const body = parseJson<{
      status?: unknown;
      title?: unknown;
      trigger?: unknown;
      procedure?: unknown;
      verification?: unknown;
      boundary?: unknown;
    }>(ctx);
    const contentPatch: {
      title?: string;
      trigger?: string;
      procedure?: string;
      verification?: string;
      boundary?: string;
    } = {};
    if (typeof body.title === "string") contentPatch.title = body.title;
    if (typeof body.trigger === "string") contentPatch.trigger = body.trigger;
    if (typeof body.procedure === "string") contentPatch.procedure = body.procedure;
    if (typeof body.verification === "string") contentPatch.verification = body.verification;
    if (typeof body.boundary === "string") contentPatch.boundary = body.boundary;
    const hasContent = Object.keys(contentPatch).length > 0;
    const hasStatus = body.status !== undefined;
    if (!hasStatus && !hasContent) {
      writeError(
        ctx,
        400,
        "invalid_argument",
        "provide at least one of status / title / trigger / procedure / verification / boundary",
      );
      return;
    }
    if (hasStatus && !isValidPolicyStatus(body.status)) {
      writeError(
        ctx,
        400,
        "invalid_argument",
        "status must be one of: candidate, active, archived",
      );
      return;
    }
    let updated = hasContent
      ? await deps.core.updatePolicy(id, contentPatch)
      : await deps.core.getPolicy(id);
    if (!updated) {
      writeError(ctx, 404, "not_found", `policy not found: ${id}`);
      return;
    }
    if (hasStatus) {
      updated = await deps.core.setPolicyStatus(
        id,
        body.status as PolicyDTO["status"],
      );
      if (!updated) {
        writeError(ctx, 404, "not_found", `policy not found: ${id}`);
        return;
      }
    }
    return updated;
  });

  /**
   * `POST /api/v1/policies/:id/share` — set/clear the share state.
   * Same body shape as `POST /api/v1/traces/:id/share`.
   */
  routes.setPattern("POST /api/v1/policies/:id/share", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const body = parseJson<{
      scope?: "private" | "public" | "hub" | null;
      target?: string | null;
    }>(ctx);
    const scope = body.scope === undefined ? "public" : body.scope;
    const updated = await deps.core.sharePolicy(id, {
      scope: scope ?? null,
      target: body.target ?? null,
      sharedAt: scope ? Date.now() : null,
    });
    if (!updated) {
      writeError(ctx, 404, "not_found", `policy not found: ${id}`);
      return;
    }
    return updated;
  });

  routes.setPattern("DELETE /api/v1/policies/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    return await deps.core.deletePolicy(id);
  });

  /**
   * `POST /api/v1/policies/:id/guidance` — append decision guidance to
   * a policy. Body: `{ preference?: string[]; antiPattern?: string[] }`.
   * The viewer's PolicyDrawer uses this for manual guidance entry
   * when the feedback pipeline hasn't produced any yet. Duplicates
   * are de-duped server-side.
   */
  routes.setPattern("POST /api/v1/policies/:id/guidance", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const body = parseJson<{ preference?: unknown; antiPattern?: unknown }>(ctx);
    const pref = normalizeGuidanceList(body.preference);
    const avoid = normalizeGuidanceList(body.antiPattern);
    if (pref.length === 0 && avoid.length === 0) {
      writeError(
        ctx,
        400,
        "invalid_argument",
        "provide at least one preference or antiPattern string",
      );
      return;
    }
    const updated = await deps.core.editPolicyGuidance(id, {
      preference: pref,
      antiPattern: avoid,
    });
    if (!updated) {
      writeError(ctx, 404, "not_found", `policy not found: ${id}`);
      return;
    }
    return updated;
  });

  /**
   * `GET /api/v1/policies/:id/usage` — everything that references this
   * policy from the other tiers. The viewer's PolicyDrawer calls this
   * to render the "Related skills / In world models / Source episodes"
   * cross-link sections. Kept server-side so the drawer doesn't have
   * to pull every skill + world-model to filter client-side.
   */
  routes.setPattern("GET /api/v1/policies/:id/usage", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const policy = await deps.core.getPolicy(id);
    if (!policy) {
      writeError(ctx, 404, "not_found", `policy not found: ${id}`);
      return;
    }
    const [skills, worldModels] = await Promise.all([
      deps.core.listSkills({ limit: 500 }),
      deps.core.listWorldModels({ limit: 500 }),
    ]);
    return {
      skills: skills
        .filter((s) => s.sourcePolicyIds.includes(id))
        .map((s) => ({ id: s.id, name: s.name, status: s.status, eta: s.eta })),
      worldModels: worldModels
        .filter((w) => w.policyIds.includes(id))
        .map((w) => ({ id: w.id, title: w.title })),
      // Policy rows carry their source episodes directly — no join
      // needed. Return the full list so the drawer can render every
      // task that contributed a supporting trace.
      sourceEpisodes: policy.sourceEpisodeIds ?? [],
    };
  });

  // ─── World models (L3 "世界环境知识") ────────────────────────────

  routes.set("GET /api/v1/world-models", async (ctx) => {
    const params = ctx.url.searchParams;
    const parsedLimit = Number(params.get("limit"));
    const parsedOffset = Number(params.get("offset"));
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
    const offset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
    const q = params.get("q") || undefined;
    const worldModels = await deps.core.listWorldModels({ limit, offset, q });
    return {
      worldModels,
      limit,
      offset,
      nextOffset: worldModels.length === limit ? offset + limit : undefined,
    };
  });

  routes.setPattern("GET /api/v1/world-models/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const model = await deps.core.getWorldModel(id);
    if (!model) {
      writeError(ctx, 404, "not_found", `world model not found: ${id}`);
      return;
    }
    return model;
  });

  /**
   * `GET /api/v1/world-models/:id/usage` — cross-link payload for the
   * world-model drawer. Resolves `policyIds` to {id, title, status}
   * triples so the drawer can render clickable policy chips without
   * another round-trip per chip.
   */
  routes.setPattern("GET /api/v1/world-models/:id/usage", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const wm = await deps.core.getWorldModel(id);
    if (!wm) {
      writeError(ctx, 404, "not_found", `world model not found: ${id}`);
      return;
    }
    const policies = await Promise.all(
      wm.policyIds.map(async (pid) => {
        const p = await deps.core.getPolicy(pid);
        return p
          ? { id: p.id, title: p.title, status: p.status, gain: p.gain }
          : { id: pid, title: null, status: null, gain: null };
      }),
    );
    return { policies };
  });

  routes.setPattern("DELETE /api/v1/world-models/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    return await deps.core.deleteWorldModel(id);
  });

  /**
   * PATCH /api/v1/world-models/:id — edit body and/or flip lifecycle.
   * Body shape (all optional, at least one required):
   *
   *   { title?: string; body?: string; status?: 'active' | 'archived' }
   */
  routes.setPattern("PATCH /api/v1/world-models/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const body = parseJson<{
      title?: unknown;
      body?: unknown;
      status?: unknown;
    }>(ctx);
    const patch: { title?: string; body?: string; status?: "active" | "archived" } = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.body === "string") patch.body = body.body;
    if (body.status === "active" || body.status === "archived") {
      patch.status = body.status;
    }
    if (Object.keys(patch).length === 0) {
      writeError(
        ctx,
        400,
        "invalid_argument",
        "provide at least one of title / body / status",
      );
      return;
    }
    const updated = await deps.core.updateWorldModel(id, patch);
    if (!updated) {
      writeError(ctx, 404, "not_found", `world model not found: ${id}`);
      return;
    }
    return updated;
  });

  /**
   * `POST /api/v1/world-models/:id/share` — set/clear the share
   * state. Same body shape as `POST /api/v1/traces/:id/share`.
   */
  routes.setPattern("POST /api/v1/world-models/:id/share", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const body = parseJson<{
      scope?: "private" | "public" | "hub" | null;
      target?: string | null;
    }>(ctx);
    const scope = body.scope === undefined ? "public" : body.scope;
    const updated = await deps.core.shareWorldModel(id, {
      scope: scope ?? null,
      target: body.target ?? null,
      sharedAt: scope ? Date.now() : null,
    });
    if (!updated) {
      writeError(ctx, 404, "not_found", `world model not found: ${id}`);
      return;
    }
    return updated;
  });

  /**
   * Soft-archive a world model (reversible). Mirrors the trace-level
   * "归档" affordance.
   */
  routes.setPattern("POST /api/v1/world-models/:id/archive", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const updated = await deps.core.archiveWorldModel(id);
    if (!updated) {
      writeError(ctx, 404, "not_found", `world model not found: ${id}`);
      return;
    }
    return updated;
  });

  routes.setPattern("POST /api/v1/world-models/:id/unarchive", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const updated = await deps.core.unarchiveWorldModel(id);
    if (!updated) {
      writeError(ctx, 404, "not_found", `world model not found: ${id}`);
      return;
    }
    return updated;
  });
}

function isValidPolicyStatus(v: unknown): v is PolicyDTO["status"] {
  return v === "candidate" || v === "active" || v === "archived";
}

function normalizeGuidanceList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t) continue;
    // Cap line length so a malformed client doesn't flood boundary.
    out.push(t.length > 400 ? t.slice(0, 400) : t);
    if (out.length >= 20) break;
  }
  return out;
}
