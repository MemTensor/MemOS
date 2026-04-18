import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { PluginContext, Skill, SkillVersion } from "../types";
import type { SqliteStore } from "../storage/sqlite";
import type { SkillGenerateOutput } from "../types";
import type { SkillBundle } from "../sharing/types";
import { resolveHubClient, hubRequestJson } from "./hub";

export function buildSkillBundleForHub(store: SqliteStore, skillId: string): SkillBundle {
  const skill = store.getSkill(skillId);
  if (!skill) {
    throw new Error(`Skill not found: ${skillId}`);
  }

  const latestVersion = store.getLatestSkillVersion(skillId);
  const skillMd = readSkillMarkdown(skill.dirPath, latestVersion?.content ?? "");

  return {
    metadata: {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      qualityScore: skill.qualityScore,
    },
    bundle: {
      skill_md: skillMd,
      scripts: readCompanionFiles(path.join(skill.dirPath, "scripts")),
      references: readCompanionFiles(path.join(skill.dirPath, "references")),
      evals: readEvals(path.join(skill.dirPath, "evals", "evals.json")),
    } satisfies SkillGenerateOutput,
  };
}

function readSkillMarkdown(dirPath: string, fallback: string): string {
  const skillMdPath = path.join(dirPath, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    return fs.readFileSync(skillMdPath, "utf8");
  }
  return fallback;
}

function readCompanionFiles(dirPath: string): Array<{ filename: string; content: string }> {
  if (!fs.existsSync(dirPath)) return [];

  const out: Array<{ filename: string; content: string }> = [];
  walkFiles(dirPath, dirPath, out);
  return out.sort((left, right) => left.filename.localeCompare(right.filename));
}

function walkFiles(rootDir: string, currentDir: string, out: Array<{ filename: string; content: string }>): void {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(rootDir, fullPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push({
      filename: path.relative(rootDir, fullPath).replace(/\\/g, "/"),
      content: fs.readFileSync(fullPath, "utf8"),
    });
  }
}

function readEvals(evalsPath: string): Array<{ id: number; prompt: string; expectations: string[] }> {
  if (!fs.existsSync(evalsPath)) return [];
  const raw = JSON.parse(fs.readFileSync(evalsPath, "utf8")) as { evals?: Array<{ id: number; prompt: string; expectations: string[] }> };
  return Array.isArray(raw.evals) ? raw.evals : [];
}


export async function publishSkillBundleToHub(
  store: SqliteStore,
  ctx: PluginContext,
  input: { skillId: string; visibility: "public" | "group"; groupId?: string; hubAddress?: string; userToken?: string },
): Promise<{ skillId: string; visibility: "public" | "group" }> {
  const bundle = buildSkillBundleForHub(store, input.skillId);
  const client = await resolveHubClient(store, ctx, { hubAddress: input.hubAddress, userToken: input.userToken });
  return hubRequestJson(client.hubUrl, client.userToken, "/api/v1/hub/skills/publish", {
    method: "POST",
    body: JSON.stringify({
      visibility: input.visibility,
      groupId: input.groupId,
      metadata: bundle.metadata,
      bundle: bundle.bundle,
    }),
  }) as Promise<{ skillId: string; visibility: "public" | "group" }>;
}

export async function unpublishSkillBundleFromHub(
  store: SqliteStore,
  ctx: PluginContext,
  input: { skillId: string; hubAddress?: string; userToken?: string },
): Promise<{ ok: boolean }> {
  const client = await resolveHubClient(store, ctx, { hubAddress: input.hubAddress, userToken: input.userToken });
  return hubRequestJson(client.hubUrl, client.userToken, "/api/v1/hub/skills/unpublish", {
    method: "POST",
    body: JSON.stringify({
      sourceSkillId: input.skillId,
    }),
  }) as Promise<{ ok: boolean }>;
}

export async function fetchHubSkillBundle(
  store: SqliteStore,
  ctx: PluginContext,
  input: { skillId: string; hubAddress?: string; userToken?: string },
): Promise<SkillBundle & { skillId: string }> {
  const client = await resolveHubClient(store, ctx, { hubAddress: input.hubAddress, userToken: input.userToken });
  return hubRequestJson(client.hubUrl, client.userToken, `/api/v1/hub/skills/${encodeURIComponent(input.skillId)}/bundle`, {
    method: "GET",
  }) as Promise<SkillBundle & { skillId: string }>;
}

export function restoreSkillBundleFromHub(
  store: SqliteStore,
  ctx: PluginContext,
  payload: SkillBundle & { skillId?: string },
): { localSkillId: string; localName: string; dirPath: string } {
  validateBundle(payload.bundle);

  const skillsStoreDir = path.join(ctx.stateDir, "skills-store");
  fs.mkdirSync(skillsStoreDir, { recursive: true });

  const baseName = sanitizeName(payload.metadata.name) || `hub-skill-${(payload.skillId ?? payload.metadata.id).slice(0, 8)}`;
  const resolvedName = resolveLocalSkillName(store, baseName, payload.skillId ?? payload.metadata.id);
  const dirPath = path.join(skillsStoreDir, resolvedName);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, "SKILL.md"), payload.bundle.skill_md, "utf8");

  writeCompanionFiles(dirPath, "scripts", payload.bundle.scripts);
  writeCompanionFiles(dirPath, "references", payload.bundle.references);
  if (payload.bundle.evals.length > 0) {
    const evalDir = path.join(dirPath, "evals");
    fs.mkdirSync(evalDir, { recursive: true });
    fs.writeFileSync(path.join(evalDir, "evals.json"), JSON.stringify({ skill_name: payload.metadata.name, evals: payload.bundle.evals }, null, 2), "utf8");
  }

  const now = Date.now();
  const localSkillId = randomUUID();
  const skill: Skill = {
    id: localSkillId,
    name: resolvedName,
    description: payload.metadata.description,
    version: payload.metadata.version,
    status: "active",
    tags: JSON.stringify(["hub-import"]),
    sourceType: "manual",
    dirPath,
    installed: 0,
    owner: "agent:main",
    visibility: "private",
    qualityScore: payload.metadata.qualityScore,
    createdAt: now,
    updatedAt: now,
  };
  const version: SkillVersion = {
    id: randomUUID(),
    skillId: localSkillId,
    version: payload.metadata.version,
    content: payload.bundle.skill_md,
    changelog: "Imported from hub",
    changeSummary: "Imported from hub",
    upgradeType: "create",
    sourceTaskId: null,
    metrics: "{}",
    qualityScore: payload.metadata.qualityScore,
    createdAt: now,
  };

  store.insertSkill(skill);
  store.insertSkillVersion(version);
  return { localSkillId, localName: resolvedName, dirPath };
}

function validateBundle(bundle: SkillGenerateOutput): void {
  const allowedExtensions = new Set([".md", ".ts", ".js", ".sh", ".json", ".yaml", ".yml", ".txt"]);
  const files = [...bundle.scripts, ...bundle.references];
  if (Buffer.byteLength(bundle.skill_md, "utf8") > 100 * 1024) throw new Error("SKILL.md exceeds size limit");
  if (files.length > 50) throw new Error("bundle contains too many files");

  let totalBytes = Buffer.byteLength(bundle.skill_md, "utf8");
  for (const file of files) {
    const name = file.filename;
    if (!name || path.isAbsolute(name) || name.startsWith("/") || name.includes("..")) throw new Error(`unsafe filename: ${name}`);
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) throw new Error(`invalid filename: ${name}`);
    const ext = path.extname(name).toLowerCase();
    if (!allowedExtensions.has(ext)) throw new Error(`unsupported file type: ${name}`);
    const fileSize = Buffer.byteLength(file.content, "utf8");
    if (fileSize > 512 * 1024) throw new Error(`file exceeds size limit: ${name}`);
    totalBytes += fileSize;
  }
  if (totalBytes > 5 * 1024 * 1024) throw new Error("bundle exceeds size limit");
}

function writeCompanionFiles(dirPath: string, root: "scripts" | "references", files: Array<{ filename: string; content: string }>): void {
  if (files.length === 0) return;
  const rootDir = path.join(dirPath, root);
  fs.mkdirSync(rootDir, { recursive: true });
  for (const file of files) {
    const target = path.join(rootDir, file.filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, "utf8");
  }
}

function sanitizeName(input: string): string {
  return input.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveLocalSkillName(store: SqliteStore, baseName: string, sourceId: string): string {
  if (!store.getSkillByName(baseName)) return baseName;
  return `${baseName}-hub-${sourceId.slice(0, 8)}`;
}
