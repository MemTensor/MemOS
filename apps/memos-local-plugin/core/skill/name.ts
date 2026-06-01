const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "for",
  "with",
  "from",
  "that",
  "this",
  "using",
  "use",
  "task",
  "skill",
  "fix",
  "issue",
  "bug",
  "new",
  "final",
  "strict",
  "comprehensive",
]);

const ACTION_WORDS = [
  "apply",
  "patch",
  "repair",
  "fix",
  "retry",
  "install",
  "verify",
  "migrate",
  "refactor",
  "rebuild",
];

export function normalizeSkillName(raw: string, fallback = "generic_task_apply"): string {
  const cleaned = slug(raw);
  const source = cleaned.length > 0 ? cleaned : fallback;
  const parts = source.split("_").filter(Boolean);
  const normalized = enforceSkeleton(parts);
  return fitName(normalized.join("_"), 48);
}

export function buildStructuredName(input: {
  domain?: string;
  task?: string;
  action?: string;
  fallback?: string;
}): string {
  const domain = slug(input.domain ?? "");
  const task = slug(input.task ?? "");
  const action = canonicalAction(input.action ?? "");
  return normalizeSkillName(
    [domain || "generic", task || "task", action || "apply"].join("_"),
    input.fallback ?? "generic_task_apply",
  );
}

export function deriveNameFromText(title: string, hint: string): string {
  const t = tokens(title);
  const h = tokens(hint);
  const domain = t[0] ?? h[0] ?? "generic";
  const action = findAction([...h, ...t]) ?? "apply";
  const taskTokens = [...t.slice(1), ...h].filter((x) => x !== action);
  const task = taskTokens.slice(0, 3).join("_") || "task";
  return buildStructuredName({ domain, task, action });
}

export function uniquifySkillName(base: string, existing: ReadonlySet<string>): string {
  const normalizedBase = normalizeSkillName(base);
  if (!existing.has(normalizedBase)) return normalizedBase;
  for (let i = 2; i < 200; i++) {
    const suffix = `_${i}`;
    const fitted = fitName(normalizedBase, 48 - suffix.length) + suffix;
    if (!existing.has(fitted)) return fitted;
  }
  return fitName(normalizedBase, 44) + "_x";
}

function enforceSkeleton(parts: string[]): string[] {
  const out = parts.filter((p) => p.length > 0);
  if (out.length >= 3) return out;
  if (out.length === 2) return [out[0], out[1], "apply"];
  if (out.length === 1) return [out[0], "task", "apply"];
  return ["generic", "task", "apply"];
}

function fitName(name: string, max: number): string {
  if (name.length <= max) return name;
  const parts = name.split("_").filter(Boolean);
  if (parts.length < 3) return name.slice(0, max).replace(/_+$/g, "");
  const domain = parts[0];
  const action = canonicalAction(parts[parts.length - 1]) || "apply";
  let taskParts = parts.slice(1, -1).filter((p) => !STOPWORDS.has(p));
  if (taskParts.length === 0) taskParts = ["task"];
  while ([domain, ...taskParts, action].join("_").length > max && taskParts.length > 1) {
    taskParts.pop();
  }
  let candidate = [domain, ...taskParts, action].join("_");
  if (candidate.length <= max) return candidate;
  const remaining = Math.max(1, max - (domain.length + action.length + 2));
  const compactTask = taskParts.join("_").slice(0, remaining).replace(/_+$/g, "");
  candidate = [domain, compactTask || "task", action].join("_");
  return candidate.slice(0, max).replace(/_+$/g, "");
}

function tokens(raw: string): string[] {
  return slug(raw)
    .split("_")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .slice(0, 8);
}

function canonicalAction(raw: string): string {
  const s = slug(raw);
  if (!s) return "";
  const first = s.split("_")[0] ?? s;
  return ACTION_WORDS.find((w) => first === w) ?? first;
}

function findAction(words: string[]): string | null {
  for (const w of words) {
    const action = canonicalAction(w);
    if (ACTION_WORDS.includes(action)) return action;
  }
  return null;
}

function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
