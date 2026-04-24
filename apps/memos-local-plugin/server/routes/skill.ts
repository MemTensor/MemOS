/**
 * Skill layer endpoints.
 *
 * Skills are the callable top of the memory stack (Phase 11). The
 * viewer uses these to render the skill library and to retire stale
 * skills when a user clicks "archive".
 */

import type { SkillDTO, SkillId } from "../../agent-contract/dto.js";
import type { ServerDeps } from "../types.js";
import { buildSingleFileZip } from "../../core/util/tiny-zip.js";
import { parseJson, writeError, type Routes } from "./registry.js";

export function registerSkillRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/skills", async (ctx) => {
    const status = (ctx.url.searchParams.get("status") as SkillDTO["status"] | null) ?? undefined;
    // Viewer needs prev/next pagination — ask for one extra page so we
    // can tell the client whether there's more without a count query.
    const pageSize = limitOrUndefined(ctx.url.searchParams.get("limit")) ?? 50;
    const offset = Math.max(0, Number(ctx.url.searchParams.get("offset") ?? 0) || 0);
    const all = await deps.core.listSkills({ status, limit: pageSize + offset + 1 });
    const page = all.slice(offset, offset + pageSize);
    const hasMore = all.length > offset + pageSize;
    const total = await deps.core.countSkills({ status });
    return {
      skills: page,
      limit: pageSize,
      offset,
      total,
      nextOffset: hasMore ? offset + pageSize : undefined,
    };
  });

  routes.set("GET /api/v1/skills/get", async (ctx) => {
    const id = ctx.url.searchParams.get("id");
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const skill = await deps.core.getSkill(id as SkillId);
    if (skill === null) {
      writeError(ctx, 404, "not_found", `skill not found: ${id}`);
      return;
    }
    return skill;
  });

  /**
   * `GET /api/v1/skills/:id/timeline` — evolution history for one skill.
   *
   * We assemble the timeline by walking the recent `api_logs` rows for
   * the `skill_generate` / `skill_evolve` tool names and keeping those
   * whose payload mentions this skill id. Mirrors the legacy
   * `memos-local-openclaw` "version history" table shown in the Skills
   * drawer.
   */
  routes.setPattern("GET /api/v1/skills/:id/timeline", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const picks = await Promise.all(
      ["skill_generate", "skill_evolve"].map((tool) =>
        deps.core.listApiLogs({ toolName: tool, limit: 500, offset: 0 }),
      ),
    );
    interface TimelineEntry {
      ts: number;
      kind: string;
      phase?: string;
      durationMs: number;
      success: boolean;
      summary?: string;
    }
    const entries: TimelineEntry[] = [];
    for (const res of picks) {
      for (const row of res.logs) {
        const out = safeJson(row.outputJson);
        const inp = safeJson(row.inputJson);
        const skillId =
          (out as { skillId?: unknown } | null)?.skillId ??
          (inp as { skillId?: unknown } | null)?.skillId;
        if (skillId !== id) continue;
        const kind =
          ((out as { kind?: unknown } | null)?.kind as string | undefined) ??
          row.toolName;
        const phase = (inp as { phase?: unknown } | null)?.phase as
          | string
          | undefined;
        const summary =
          ((out as { name?: unknown } | null)?.name as string | undefined) ??
          ((out as { reason?: unknown } | null)?.reason as string | undefined);
        entries.push({
          ts: row.calledAt,
          kind,
          phase,
          durationMs: row.durationMs,
          success: row.success,
          summary,
        });
      }
    }
    entries.sort((a, b) => b.ts - a.ts);
    return { skillId: id, entries };
  });

  /**
   * `GET /api/v1/skills/:id/usage` — cross-link payload for the skill
   * drawer. Resolves `sourcePolicyIds` / `sourceWorldModelIds` to
   * {id, name/title} pairs so the viewer can render clickable chips
   * without fetching every policy / world-model.
   */
  routes.setPattern("GET /api/v1/skills/:id/usage", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const skill = await deps.core.getSkill(id as SkillId);
    if (!skill) {
      writeError(ctx, 404, "not_found", `skill not found: ${id}`);
      return;
    }
    const sourcePolicies = await Promise.all(
      skill.sourcePolicyIds.map(async (pid) => {
        const p = await deps.core.getPolicy(pid);
        return p
          ? { id: p.id, title: p.title, status: p.status, gain: p.gain }
          : { id: pid, title: null, status: null, gain: null };
      }),
    );
    const sourceWorldModels = await Promise.all(
      skill.sourceWorldModelIds.map(async (wid) => {
        const w = await deps.core.getWorldModel(wid);
        return w ? { id: w.id, title: w.title } : { id: wid, title: null };
      }),
    );
    return {
      sourcePolicies,
      sourceWorldModels,
    };
  });

  routes.set("POST /api/v1/skills/archive", async (ctx) => {
    // Accept either `{id}` (JSON-RPC flavour) or `{skillId}` (viewer).
    const body = parseJson<{ id?: string; skillId?: string; reason?: string }>(ctx);
    const target = body.id ?? body.skillId;
    if (!target) {
      writeError(ctx, 400, "invalid_argument", "id or skillId is required");
      return;
    }
    await deps.core.archiveSkill(target as SkillId, body.reason);
    return { ok: true };
  });

  /**
   * `POST /api/v1/skills/reactivate` — flip an archived skill back to
   * active. Accepts either `{id}` or `{skillId}` to match the viewer's
   * existing archive flow.
   */
  routes.set("POST /api/v1/skills/reactivate", async (ctx) => {
    const body = parseJson<{ id?: string; skillId?: string }>(ctx);
    const target = body.id ?? body.skillId;
    if (!target) {
      writeError(ctx, 400, "invalid_argument", "id or skillId is required");
      return;
    }
    const updated = await deps.core.reactivateSkill(target as SkillId);
    if (!updated) {
      writeError(ctx, 404, "not_found", `skill not found: ${target}`);
      return;
    }
    return updated;
  });

  /**
   * `DELETE /api/v1/skills/:id` — hard delete (vs `archive` which just
   * flips status). Idempotent.
   */
  routes.setPattern("DELETE /api/v1/skills/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    return await deps.core.deleteSkill(id as SkillId);
  });

  /**
   * `PATCH /api/v1/skills/:id` — viewer's edit modal. Mutable fields:
   * `name`, `invocationGuide`. Returns the updated DTO.
   */
  routes.setPattern("PATCH /api/v1/skills/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const body = parseJson<{ name?: string; invocationGuide?: string }>(ctx);
    const updated = await deps.core.updateSkill(id as SkillId, {
      name: typeof body.name === "string" ? body.name : undefined,
      invocationGuide:
        typeof body.invocationGuide === "string" ? body.invocationGuide : undefined,
    });
    if (!updated) {
      writeError(ctx, 404, "not_found", `skill not found: ${id}`);
      return;
    }
    return updated;
  });

  /**
   * `POST /api/v1/skills/:id/share` — set/clear the share state.
   * Same body shape as `POST /api/v1/traces/:id/share`.
   */
  routes.setPattern("POST /api/v1/skills/:id/share", async (ctx) => {
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
    const updated = await deps.core.shareSkill(id as SkillId, {
      scope: scope ?? null,
      target: body.target ?? null,
      sharedAt: scope ? Date.now() : null,
    });
    if (!updated) {
      writeError(ctx, 404, "not_found", `skill not found: ${id}`);
      return;
    }
    return updated;
  });

  /**
   * `GET /api/v1/skills/:id/download` — bundle the skill's invocation
   * guide as a one-file ZIP (`SKILL.md`). Lets the user grab the
   * guide for sharing into another agent or backing up locally.
   */
  routes.setPattern("GET /api/v1/skills/:id/download", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const skill = await deps.core.getSkill(id as SkillId);
    if (!skill) {
      writeError(ctx, 404, "not_found", `skill not found: ${id}`);
      return;
    }
    const md = renderSkillMarkdown(skill);
    const buf = buildSingleFileZip("SKILL.md", md);
    const filename = sanitizeFilename(skill.name || skill.id) + ".zip";
    ctx.res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(buf.length),
      "content-disposition": `attachment; filename="${filename}"`,
    });
    ctx.res.end(buf);
  });
}

function renderSkillMarkdown(skill: SkillDTO): string {
  const head = `# ${skill.name || skill.id}\n\n`;
  const meta = `> id: ${skill.id}\n> status: ${skill.status}\n> version: ${skill.version}\n\n`;
  const guide = skill.invocationGuide?.trim() || "(no invocation guide)";
  return head + meta + guide + "\n";
}

function sanitizeFilename(raw: string): string {
  const trimmed = raw.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe.length > 0 ? safe.slice(0, 80) : "skill";
}

function limitOrUndefined(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : undefined;
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
