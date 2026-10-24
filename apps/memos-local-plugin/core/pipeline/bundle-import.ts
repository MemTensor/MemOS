import type {
  MemoryImportBundle,
  MemoryImportIssue,
  MemoryImportOptions,
  MemoryImportResult,
} from "../../agent-contract/import.js";
import type {
  PolicyDTO,
  RuntimeNamespace,
  SkillDTO,
  TraceDTO,
  WorldModelDTO,
} from "../../agent-contract/dto.js";
import { MemosError } from "../../agent-contract/errors.js";
import {
  isVisibleTo,
  normalizeNamespace,
  ownerFromNamespace,
} from "../runtime/namespace.js";
import { rootLogger } from "../logger/index.js";
import type { Repos, StorageDb } from "../storage/index.js";
import type {
  EpisodeId,
  SkillRow,
  TraceId,
  TraceRow,
  WorldModelRow,
} from "../types.js";

type Kind = MemoryImportIssue["kind"];
type RecordRow = Record<string, unknown>;
type Owner = ReturnType<typeof ownerFromNamespace>;
const BATCH_SIZE = 100;

function validationIssue(
  kind: Kind,
  value: unknown,
): Omit<MemoryImportIssue, "index" | "kind"> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { code: "invalid_row", message: "Row must be an object." };
  }
  const row = value as RecordRow;
  const required =
    kind === "trace"
      ? ["id", "sessionId", "episodeId"]
      : kind === "policy"
        ? [
            "id",
            "title",
            "trigger",
            "procedure",
            "verification",
            "boundary",
            "status",
          ]
        : kind === "skill"
          ? ["id", "name", "invocationGuide", "status"]
          : ["id", "title", "body"];
  for (const field of required) {
    if (
      typeof row[field] !== "string" ||
      (["id", "sessionId", "episodeId"].includes(field) && !row[field].trim())
    ) {
      return {
        field,
        code: "invalid_field",
        message: `${field} must be a string${field === "id" ? " with a nonempty id" : ""}.`,
      };
    }
  }
  if (
    row.status != null &&
    !(
      kind === "worldModel"
        ? ["active", "archived"]
        : ["candidate", "active", "archived"]
    ).includes(String(row.status))
  ) {
    return {
      field: "status",
      code: "invalid_field",
      message: "status is not a supported lifecycle state.",
    };
  }
  for (const field of [
    "ts",
    "turnId",
    "createdAt",
    "updatedAt",
    "lastUsedAt",
    "version",
  ]) {
    if (row[field] != null && !Number.isSafeInteger(row[field])) {
      return {
        field,
        code: "invalid_integer",
        message: `${field} must be a safe integer; timestamps use milliseconds.`,
      };
    }
  }
  for (const field of [
    "userText",
    "agentText",
    "summary",
    "reflection",
    "agentThinking",
    "ownerAgentKind",
    "ownerProfileId",
    "ownerWorkspaceId",
  ]) {
    if (row[field] != null && typeof row[field] !== "string") {
      return {
        field,
        code: "invalid_field",
        message: `${field} must be a string.`,
      };
    }
  }
  for (const field of [
    "value",
    "alpha",
    "priority",
    "rHuman",
    "support",
    "gain",
    "eta",
    "salience",
    "confidence",
  ]) {
    if (
      row[field] != null &&
      (typeof row[field] !== "number" || !Number.isFinite(row[field]))
    ) {
      return {
        field,
        code: "invalid_field",
        message: `${field} must be a finite number.`,
      };
    }
  }
  for (const field of [
    "toolCalls",
    "tags",
    "preference",
    "antiPattern",
    "policyIds",
    "sourceEpisodeIds",
    "sourceFeedbackIds",
    "sourceTraceIds",
    "sourcePolicyIds",
    "sourceWorldModelIds",
    "evidenceAnchors",
  ]) {
    if (row[field] != null && !Array.isArray(row[field])) {
      return {
        field,
        code: "invalid_field",
        message: `${field} must be an array.`,
      };
    }
    if (
      field !== "toolCalls" &&
      Array.isArray(row[field]) &&
      row[field].some((value) => typeof value !== "string")
    ) {
      return {
        field,
        code: "invalid_field",
        message: `${field} must contain strings.`,
      };
    }
  }
  if (row.share != null) {
    const share = row.share as RecordRow;
    if (
      typeof share !== "object" ||
      Array.isArray(share) ||
      !["private", "local", "public", "hub"].includes(String(share.scope))
    ) {
      return {
        field: "share",
        code: "invalid_field",
        message: "share must specify a valid scope.",
      };
    }
    if (share.sharedAt != null && !Number.isSafeInteger(share.sharedAt)) {
      return {
        field: "share.sharedAt",
        code: "invalid_integer",
        message: "share.sharedAt must be an integer timestamp in milliseconds.",
      };
    }
  }
  return undefined;
}

function ownerFor(
  row: RecordRow,
  fallback: Owner,
  options: MemoryImportOptions,
): Owner {
  if (options.ownership === "target") return fallback;
  return {
    ownerAgentKind: (row.ownerAgentKind as string) ?? fallback.ownerAgentKind,
    ownerProfileId: (row.ownerProfileId as string) ?? fallback.ownerProfileId,
    ownerWorkspaceId:
      (row.ownerWorkspaceId as string | null) ?? fallback.ownerWorkspaceId,
  };
}

/** Import each row atomically; a rejected trace must not leave synthetic parents behind. */
export async function importMemoryBundle(
  bundle: MemoryImportBundle,
  options: MemoryImportOptions,
  context: { db: StorageDb; repos: Repos; namespace: RuntimeNamespace },
): Promise<MemoryImportResult> {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
    throw new MemosError("invalid_argument", "bundle must be an object");
  if (bundle.version !== undefined && bundle.version !== 1)
    throw new MemosError("unsupported", "unsupported bundle version");
  if (
    options.ownership !== undefined &&
    !["preserve", "target"].includes(options.ownership)
  )
    throw new MemosError(
      "invalid_argument",
      "ownership must be preserve or target",
    );
  if (
    options.targetProfileId !== undefined &&
    (options.ownership !== "target" ||
      typeof options.targetProfileId !== "string" ||
      !options.targetProfileId.trim())
  ) {
    throw new MemosError(
      "invalid_argument",
      "targetProfileId requires target ownership and a nonempty profile id",
    );
  }
  if (options.dryRun !== undefined && typeof options.dryRun !== "boolean")
    throw new MemosError("invalid_argument", "dryRun must be boolean");
  const collections = [
    ["trace", "traces"],
    ["policy", "policies"],
    ["skill", "skills"],
    ["worldModel", "worldModels"],
  ] as const;
  for (const [, name] of collections) {
    if (bundle[name] !== undefined && !Array.isArray(bundle[name]))
      throw new MemosError("invalid_argument", `${name} must be an array`);
  }
  const { db, repos, namespace } = context;
  const target = normalizeNamespace({
    ...namespace,
    profileId: options.targetProfileId ?? namespace.profileId,
  });
  const fallback = ownerFromNamespace(
    options.ownership === "target" ? target : namespace,
  );
  const result: MemoryImportResult = {
    imported: 0,
    skipped: 0,
    duplicates: 0,
    invalid: 0,
    failed: 0,
    visible: 0,
    hidden: 0,
    dryRun: options.dryRun === true,
    issues: [],
  };
  const issue = (value: MemoryImportIssue) => {
    if (result.issues.length < 50) result.issues.push(value);
  };

  for (const [kind, name] of collections) {
    const rows = bundle[name] ?? [];
    const ids = new Set<string>();
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE);
      const existingTraces =
        kind === "trace"
          ? new Set(
              repos.traces
                .getManyByIds(
                  batch
                    .filter(
                      (row): row is RecordRow =>
                        !!row &&
                        typeof row === "object" &&
                        typeof (row as RecordRow).id === "string",
                    )
                    .map((row) => row.id as TraceId),
                )
                .map((row) => row.id as string),
            )
          : new Set<string>();
      db.tx(() => {
        for (let i = 0; i < batch.length; i++) {
          const index = offset + i;
          const invalid = validationIssue(kind, batch[i]);
          if (invalid) {
            result.invalid++;
            result.skipped++;
            issue({ kind, index, ...invalid });
            continue;
          }
          const raw = batch[i] as RecordRow;
          const id = raw.id as string;
          const exists =
            ids.has(id) ||
            (kind === "trace"
              ? existingTraces.has(id)
              : kind === "policy"
                ? !!repos.policies.getById(id)
                : kind === "skill"
                  ? !!repos.skills.getById(id)
                  : !!repos.worldModel.getById(id));
          if (exists) {
            result.duplicates++;
            result.skipped++;
            continue;
          }
          const owner = ownerFor(raw, fallback, options);
          const row = { ...raw, ...owner };
          try {
            if (!options.dryRun) db.tx(() => insertRow(kind, row, repos));
            ids.add(id);
            result.imported++;
            if (isVisibleTo(row, namespace)) result.visible++;
            else result.hidden++;
          } catch {
            result.failed++;
            result.skipped++;
            issue({
              kind,
              index,
              code: "write_failed",
              message:
                "Database rejected this row; verify its fields and references.",
            });
          }
        }
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (!options.dryRun && (result.failed || result.invalid)) {
    rootLogger.child({ channel: "core.import" }).warn("rows_rejected", {
      invalid: result.invalid,
      failed: result.failed,
      issues: result.issues,
    });
  }
  return result;
}

function insertRow(kind: Kind, raw: RecordRow & Owner, repos: Repos): void {
  const owner: Owner = {
    ownerAgentKind: raw.ownerAgentKind,
    ownerProfileId: raw.ownerProfileId,
    ownerWorkspaceId: raw.ownerWorkspaceId,
  };
  const now = Date.now();
  if (kind === "trace") {
    const dto = raw as unknown as TraceDTO;
    const ts = dto.ts ?? now;
    if (!repos.sessions.getById(dto.sessionId))
      repos.sessions.upsert({
        id: dto.sessionId,
        agent: owner.ownerAgentKind,
        ...owner,
        startedAt: ts,
        lastSeenAt: ts,
        meta: { source: "import" },
      });
    const episode = repos.episodes.getById(dto.episodeId);
    if (!episode)
      repos.episodes.upsert({
        id: dto.episodeId,
        sessionId: dto.sessionId,
        ...owner,
        share: dto.share ?? null,
        startedAt: ts,
        endedAt: ts,
        traceIds: [],
        rTask: null,
        status: "closed",
        meta: { source: "import" },
      });
    repos.traces.insert({
      ...owner,
      id: dto.id,
      episodeId: dto.episodeId,
      sessionId: dto.sessionId,
      ts,
      userText: dto.userText ?? "",
      agentText: dto.agentText ?? "",
      summary: dto.summary ?? null,
      share: dto.share ?? null,
      toolCalls: dto.toolCalls ?? [],
      agentThinking: dto.agentThinking ?? null,
      reflection: dto.reflection ?? null,
      value: dto.value ?? 0,
      alpha: dto.alpha ?? 0,
      rHuman: dto.rHuman ?? null,
      priority: dto.priority ?? 0,
      tags: dto.tags ?? [],
      vecSummary: null,
      vecAction: null,
      turnId: dto.turnId ?? ts,
      schemaVersion: 1,
    } as TraceRow);
    repos.episodes.appendTrace(dto.episodeId as EpisodeId, [
      ...new Set([...(episode?.traceIds ?? []), dto.id]),
    ]);
  } else if (kind === "policy") {
    const dto = raw as unknown as PolicyDTO;
    repos.policies.insert({
      ...owner,
      id: dto.id,
      title: dto.title,
      trigger: dto.trigger,
      procedure: dto.procedure,
      verification: dto.verification,
      boundary: dto.boundary,
      support: dto.support ?? 0,
      gain: dto.gain ?? 0,
      status: dto.status,
      experienceType: dto.experienceType ?? "success_pattern",
      evidencePolarity: dto.evidencePolarity ?? "positive",
      salience: dto.salience ?? 0,
      confidence: dto.confidence ?? 0.5,
      skillEligible: dto.skillEligible !== false,
      sourceEpisodeIds: dto.sourceEpisodeIds ?? [],
      sourceFeedbackIds: dto.sourceFeedbackIds ?? [],
      sourceTraceIds: dto.sourceTraceIds ?? [],
      inducedBy: "import",
      decisionGuidance: {
        preference: [...(dto.preference ?? [])],
        antiPattern: [...(dto.antiPattern ?? [])],
      },
      verifierMeta: dto.verifierMeta ?? null,
      share: dto.share ?? null,
      vec: null,
      createdAt: dto.createdAt ?? now,
      updatedAt: dto.updatedAt ?? now,
    });
  } else if (kind === "skill") {
    const dto = raw as unknown as SkillDTO;
    repos.skills.insert({
      ...owner,
      id: dto.id,
      name: dto.name,
      status: dto.status,
      invocationGuide: dto.invocationGuide,
      eta: dto.eta ?? 0,
      support: dto.support ?? 0,
      gain: dto.gain ?? 0,
      trialsAttempted: 0,
      trialsPassed: 0,
      sourcePolicyIds: dto.sourcePolicyIds ?? [],
      sourceWorldModelIds: dto.sourceWorldModelIds ?? [],
      evidenceAnchors: dto.evidenceAnchors ?? [],
      procedureJson: {},
      share: dto.share ?? null,
      vec: null,
      createdAt: dto.createdAt ?? now,
      updatedAt: dto.updatedAt ?? now,
      version: dto.version ?? 1,
      usageCount: dto.usageCount ?? 0,
      lastUsedAt: dto.lastUsedAt ?? null,
    } as SkillRow);
  } else {
    const dto = raw as unknown as WorldModelDTO;
    repos.worldModel.insert({
      ...owner,
      id: dto.id,
      title: dto.title,
      body: dto.body,
      structure: { environment: [], inference: [], constraints: [] },
      domainTags: [],
      confidence: 0.5,
      policyIds: dto.policyIds ?? [],
      sourceEpisodeIds: [],
      inducedBy: "import",
      share: dto.share ?? null,
      vec: null,
      createdAt: dto.createdAt ?? now,
      updatedAt: dto.updatedAt ?? now,
      version: dto.version ?? 1,
      status: dto.status ?? "active",
    } as WorldModelRow);
  }
}
