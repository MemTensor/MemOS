#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const PRODUCT_PATH = "apps/memos-local-plugin";
const PRODUCT_ID = "openclaw-local-plugin";
const PRODUCT_TITLE = {
  zh: "OpenClaw 本地插件",
  en: "OpenClaw Local Plugin",
};
export const RELEASE_NOTE_GUIDANCE = {
  category_policy: {
    Added:
      "Use for newly exposed user-facing capabilities, configuration entries, model slots, language support, or workflow modes.",
    Improved:
      "Use for performance optimization, context formatting, compatibility hardening, startup/link/install robustness, or reliability improvements when the evidence is not primarily a broken-behavior fix.",
    Fixed:
      "Use for concrete broken behavior, regressions, data recovery bugs, failed retries, endpoint probing anomalies, or configuration that existed but did not take effect.",
  },
  quality_policy: [
    "Prefer Added / Improved / Fixed sections when the evidence supports all three; omit a section only when evidence is insufficient.",
    "Do not collapse a new configuration capability and a bug fix in the same subsystem into one Fixed item; keep the added capability and the fixed behavior separate when both are evidenced.",
    "Map vector scan CPU reductions, XML memory-context boundaries, and Hermes provider startup/link/install compatibility to Improved unless the evidence clearly describes a user-visible regression.",
    "Keep bullets short, product-facing, and evidence-backed; do not mention internal file names unless they are the feature name users recognize.",
  ],
  translation_policy: [
    "Treat text_cn as the canonical release-note wording first, then translate text_cn into text_en.",
    "Do not independently invent English facts beyond the Chinese canonical bullet and its source_refs.",
    "Keep category and source_refs identical between Chinese and English outputs.",
    "text_cn must contain Chinese text; text_en must not contain Chinese/CJK characters.",
  ],
};
const CURRENT_TAG_PREFIX = "memos-local-plugin-v";
const TAG_PREFIXES = [CURRENT_TAG_PREFIX, "openclaw-local-plugin-v"];
const RELEASE_NOTES_MARKER = "doc-agent-release-notes-json";
const RELEASE_CATEGORY_ORDER = ["Added", "Improved", "Fixed"];
const MAX_DRAFT_REPAIR_ATTEMPTS = 2;
const RELEASE_TO_DOC_CATEGORY = {
  Added: "New Features",
  Improved: "Improvements",
  Fixed: "Bug Fixes",
};
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

function fail(message) {
  throw new Error(String(message));
}

function warn(message) {
  console.error(`::warning::${message}`);
}

function sh(args, options = {}) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function cleanVersion(raw) {
  const value = String(raw || "").trim();
  return value.startsWith("v") ? value.slice(1) : value;
}

export function displayVersion(raw) {
  const value = cleanVersion(raw);
  return value ? `v${value}` : "";
}

export function versionFromTag(tag) {
  for (const prefix of TAG_PREFIXES) {
    if (tag.startsWith(prefix)) {
      return cleanVersion(tag.slice(prefix.length));
    }
  }
  return "";
}

export function parseSemver(version) {
  const cleaned = cleanVersion(version);
  const match = cleaned.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const leftNumeric = /^(0|[1-9]\d*)$/.test(left);
  const rightNumeric = /^(0|[1-9]\d*)$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrerelease(left, right) {
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;

  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const order = comparePrereleaseIdentifiers(leftPart, rightPart);
    if (order !== 0) return order;
  }
  return 0;
}

export function compareSemver(a, b) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return String(a).localeCompare(String(b));
  for (const key of ["major", "minor", "patch"]) {
    if (av[key] !== bv[key]) return av[key] - bv[key];
  }
  return comparePrerelease(av.prerelease, bv.prerelease);
}

function gitShowJson(ref, path) {
  try {
    return JSON.parse(sh(["show", `${ref}:${path}`]));
  } catch {
    return {};
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function tagInfo(ref) {
  const text = sh(["show", "--no-patch", "--format=%H%n%ci%n%s", ref]);
  const [sha = "", date = "", subject = ""] = text.split("\n");
  return { tag: ref, sha, date, subject };
}

function refInfo(ref, tagLabel) {
  const info = tagInfo(ref);
  return { ...info, tag: tagLabel || ref, ref };
}

function refExists(ref) {
  try {
    sh(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function resolveCurrentRef(
  currentTag,
  { requestedRef = process.env.RELEASE_EVIDENCE_REF || "", refExistsImpl = refExists } = {},
) {
  const explicit = String(requestedRef || "").trim();
  if (explicit) {
    if (!refExistsImpl(explicit)) {
      fail(`RELEASE_EVIDENCE_REF does not exist or is not a commit: ${explicit}`);
    }
    return explicit;
  }
  if (currentTag && refExistsImpl(currentTag)) return currentTag;
  return "HEAD";
}

function listProductTags() {
  try {
    sh(["fetch", "--tags", "--force", "origin"], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    warn("Failed to fetch tags from origin; using locally available tags.");
  }

  const text = sh(["tag", "--list"]);
  return text
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => ({ tag, version: versionFromTag(tag) }))
    .filter((item) => item.version && parseSemver(item.version));
}

export function findPreviousTag(targetVersion, currentTag) {
  const candidates = listProductTags()
    .filter((item) => item.tag !== currentTag)
    .filter((item) => compareSemver(item.version, targetVersion) < 0)
    .sort((a, b) => {
      const versionOrder = compareSemver(b.version, a.version);
      if (versionOrder !== 0) return versionOrder;
      const aPreferred = a.tag.startsWith(CURRENT_TAG_PREFIX) ? 1 : 0;
      const bPreferred = b.tag.startsWith(CURRENT_TAG_PREFIX) ? 1 : 0;
      return bPreferred - aPreferred;
    });
  return candidates[0]?.tag || "";
}

function parseCommits(previousTag, currentRef) {
  const text = sh([
    "log",
    "--format=%H%x09%h%x09%s",
    "--no-merges",
    `${previousTag}..${currentRef}`,
    "--",
    PRODUCT_PATH,
  ]);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", shortSha = "", subject = ""] = line.split("\t");
      return { sha, short_sha: shortSha, subject };
    });
}

function parseChangedFiles(previousTag, currentRef) {
  const text = sh(["diff", "--name-status", `${previousTag}..${currentRef}`, "--", PRODUCT_PATH]);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const item = { status: parts[0], path: parts[parts.length - 1] };
      if (parts.length === 3) item.old_path = parts[1];
      return item;
    });
}

function packageChanges(previousTag, currentRef) {
  const path = `${PRODUCT_PATH}/package.json`;
  const before = gitShowJson(previousTag, path);
  const after = currentRef === "HEAD" ? readJsonFile(path) : gitShowJson(currentRef, path);
  return ["name", "version"]
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

function extractPullRequests(commits, repo = process.env.GITHUB_REPOSITORY || "MemTensor/MemOS") {
  const seen = new Set();
  for (const commit of commits) {
    for (const match of String(commit.subject || "").matchAll(/#(\d+)/g)) {
      seen.add(match[1]);
    }
  }
  return [...seen].map((number) => ({
    number,
    url: `https://github.com/${repo}/pull/${number}`,
  }));
}

function refsForGuidance(commit) {
  const refs = [];
  if (commit.short_sha) refs.push(commit.short_sha);
  for (const match of String(commit.subject || "").matchAll(/#(\d+)/g)) {
    const value = `#${match[1]}`;
    if (!refs.includes(value)) refs.push(value);
  }
  return refs;
}

function categoryHintForSubject(subject) {
  const value = String(subject || "");
  const lower = value.toLowerCase();
  if (
    lower.startsWith("release:") ||
    /^fix(\([^)]+\))?:\s*ruff\b/i.test(value) ||
    /review feedback/i.test(value)
  ) {
    return null;
  }
  if (/^(feat|feature|add)(\([^)]+\))?:|^add\s+/i.test(value)) {
    return {
      category: "Added",
      reason: "new user-facing capability or configuration support",
    };
  }
  if (
    /cpu|full-table vector scan|vector scan|xml boundary|memory context with xml|hermes|provider link|bridge package version|startup poll|double-spawn/i.test(
      value,
    )
  ) {
    return {
      category: "Improved",
      reason: "performance, context-boundary, or integration robustness improvement",
    };
  }
  if (/^(perf|performance|refactor)(\([^)]+\))?:/i.test(value)) {
    return {
      category: "Improved",
      reason: "performance or implementation improvement",
    };
  }
  if (
    /lightweightmemory|skip evolution|endpoint paths|openai_compatible|empty response|error response|dirty-reward|orphan trace|session exemption|loopback/i.test(
      lower,
    )
  ) {
    return {
      category: "Fixed",
      reason: "specific broken behavior, recovery boundary, retry, auth, or endpoint probing fix",
    };
  }
  if (/^(fix|hotfix|bugfix)(\([^)]+\))?:|^fix\s+#\d+/i.test(value)) {
    return {
      category: "Fixed",
      reason: "specific bug fix",
    };
  }
  return null;
}

export function categoryHintsForCommits(commits) {
  return commits
    .map((commit) => {
      const hint = categoryHintForSubject(commit.subject);
      const sourceRefs = refsForGuidance(commit);
      if (!hint || sourceRefs.length === 0) return null;
      return {
        ...hint,
        source_refs: sourceRefs,
        subject: commit.subject,
      };
    })
    .filter(Boolean);
}

export function releaseNoteGuidanceForCommits(commits) {
  return {
    ...RELEASE_NOTE_GUIDANCE,
    source_ref_category_hints: categoryHintsForCommits(commits),
    source_ref_hint_policy:
      "Treat source_ref_category_hints as advisory classification hints grounded in evidence. " +
      "Use them to avoid moving performance/compatibility work into Fixed merely because the commit subject starts with fix.",
  };
}

export function collectEvidence({ targetVersion, currentTag, previousTag, currentRef = "HEAD" }) {
  const commits = parseCommits(previousTag, currentRef);
  const changedFiles = parseChangedFiles(previousTag, currentRef);
  const diffRange = `${previousTag}..${currentRef}`;
  const repo = process.env.GITHUB_REPOSITORY || "MemTensor/MemOS";
  const importantDiff = sh([
    "diff",
    "--unified=2",
    diffRange,
    "--",
    PRODUCT_PATH,
  ]).slice(0, 24000);

  return {
    product_id: PRODUCT_ID,
    product_title: PRODUCT_TITLE,
    release_note_guidance: releaseNoteGuidanceForCommits(commits),
    repo,
    previous_tag: previousTag,
    current_tag: currentTag,
    current_ref: currentRef,
    diff_range: diffRange,
    target_version: displayVersion(targetVersion),
    git_ref: sh(["rev-parse", "--short=12", currentRef]),
    previous: tagInfo(previousTag),
    current: refInfo(currentRef, currentTag),
    commits,
    pull_requests: extractPullRequests(commits, repo),
    changed_files: changedFiles,
    diff_stat: sh(["diff", "--stat", diffRange, "--", PRODUCT_PATH]),
    important_diff: {
      [`${PRODUCT_PATH}/**`]: importantDiff,
    },
    package_changes: packageChanges(previousTag, currentRef),
    test_changes: changedFiles.filter((item) => item.path.includes("/tests/")),
    docs_changes: changedFiles.filter((item) => item.path.includes("/docs/")),
  };
}

export function evidenceForInspection(evidence) {
  const guidance = evidence?.release_note_guidance || {};
  const {
    release_note_guidance: _releaseNoteGuidance,
    important_diff: _importantDiff,
    ...publicEvidence
  } = evidence || {};
  return {
    ...publicEvidence,
    release_note_guidance: {
      source_ref_category_hints: Array.isArray(guidance.source_ref_category_hints)
        ? guidance.source_ref_category_hints
        : [],
    },
    redactions: {
      important_diff: "omitted from public workflow artifacts; sent only to the configured draft service",
      release_note_prompt_guidance: "omitted from public workflow artifacts",
    },
  };
}

export function draftForInspection(draft) {
  return {
    ok: Boolean(draft?.ok),
    needs_review: Boolean(draft?.needs_review),
    confidence: draft?.confidence || "",
    release_items: Array.isArray(draft?.release_items) ? draft.release_items : [],
    coverage: {
      needs_review: Boolean(draft?.coverage?.needs_review),
      required_count: Number(draft?.coverage?.required_count || 0),
      covered_required_count: Number(draft?.coverage?.covered_required_count || 0),
      missing_required_count: Number(draft?.coverage?.missing_required_count || 0),
      covered_refs: Array.isArray(draft?.coverage?.covered_refs) ? draft.coverage.covered_refs : [],
      missing_required: Array.isArray(draft?.coverage?.missing_required) ? draft.coverage.missing_required : [],
      invalid_item_refs: Array.isArray(draft?.coverage?.invalid_item_refs) ? draft.coverage.invalid_item_refs : [],
    },
    warnings: Array.isArray(draft?.warnings) ? draft.warnings : [],
    language_issues: Array.isArray(draft?.language_issues) ? draft.language_issues : [],
    postprocess: draft?.postprocess || {},
    validation_report: draft?.validation_report || {},
    validation_attempt_count: Number(draft?.validation_attempt_count || 0),
    repair_attempt_count: Number(draft?.repair_attempt_count || 0),
    repair_attempts: Array.isArray(draft?.repair_attempts) ? draft.repair_attempts : [],
    redactions: {
      server_debug_fields: "omitted from public workflow artifacts",
      model_and_prompt_details: "omitted from public workflow artifacts",
    },
  };
}

function appendOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  writeFileSync(outputPath, `${name}<<__DOC_AGENT_EOF__\n${value}\n__DOC_AGENT_EOF__\n`, {
    flag: "a",
  });
}

export function ensureSourceHint(notes) {
  const hint = `<!-- doc-agent: source-id=${PRODUCT_ID} -->`;
  return notes.includes("doc-agent: source-id=") ? notes : `${notes.trim()}\n\n${hint}\n`;
}

function normalizeReleaseCategory(value) {
  const text = String(value || "").trim();
  return RELEASE_CATEGORY_ORDER.includes(text) ? text : "";
}

function normalizeSourceRef(value) {
  const text = String(value || "").trim().replace(/^[`[(\s]+|[`)\],.;\s]+$/g, "");
  if (/^\d{2,}$/.test(text)) return `#${text}`;
  if (/^#\d+$/.test(text)) return text;
  if (/^[a-fA-F0-9]{7,40}$/.test(text)) return text.toLowerCase();
  return "";
}

function normalizeSourceRefs(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || "").match(/#\d+|[a-fA-F0-9]{7,40}/g) || [];
  const refs = [];
  for (const value of values) {
    const ref = normalizeSourceRef(value);
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function refsForCommit(commit) {
  const refs = [];
  for (const ref of [commit?.short_sha, commit?.sha]) {
    const normalized = normalizeSourceRef(ref);
    if (normalized && !refs.includes(normalized)) refs.push(normalized);
  }
  for (const match of String(commit?.subject || "").matchAll(/#(\d+)/g)) {
    const ref = `#${match[1]}`;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function normalizeReleaseItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const category = normalizeReleaseCategory(raw.category);
  const textCn = String(raw.text_cn || "").trim().replace(/^-+\s*/, "");
  const textEn = String(raw.text_en || "").trim().replace(/^-+\s*/, "");
  const sourceRefs = normalizeSourceRefs(raw.source_refs);
  if (!category || !textCn || !textEn || sourceRefs.length === 0) return null;
  return {
    category,
    text_cn: textCn,
    text_en: textEn,
    source_refs: sourceRefs,
  };
}

function buildSourceRefIndex(evidence) {
  const refToGroup = new Map();
  const groups = new Map();
  const knownRefs = new Set();

  for (const commit of evidence?.commits || []) {
    for (const ref of refsForCommit(commit)) knownRefs.add(ref);
  }

  for (const hint of evidence?.release_note_guidance?.source_ref_category_hints || []) {
    const refs = normalizeSourceRefs(hint.source_refs);
    const category = normalizeReleaseCategory(hint.category);
    if (refs.length === 0 || !category) continue;
    const groupKey = refs[0];
    for (const ref of refs) {
      knownRefs.add(ref);
      refToGroup.set(ref, groupKey);
    }
    groups.set(groupKey, {
      key: groupKey,
      category,
      refs,
      subject: String(hint.subject || ""),
      reason: String(hint.reason || ""),
    });
  }

  return { refToGroup, groups, knownRefs };
}

function groupKeyForRef(ref, refToGroup) {
  return refToGroup.get(ref) || ref;
}

function groupKeysForItem(item, refToGroup) {
  const keys = [];
  for (const ref of item.source_refs || []) {
    const key = groupKeyForRef(ref, refToGroup);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function bestHintCategoryForItem(item, index) {
  const categories = [];
  for (const key of groupKeysForItem(item, index.refToGroup)) {
    const category = index.groups.get(key)?.category;
    if (category && !categories.includes(category)) categories.push(category);
  }
  if (categories.length === 1) return categories[0];
  return "";
}

function subjectsForItem(item, index) {
  return groupKeysForItem(item, index.refToGroup)
    .map((key) => index.groups.get(key)?.subject || "")
    .filter(Boolean)
    .join(" ");
}

function rewriteKnownReleaseItem(item, index) {
  const subjectBlob = subjectsForItem(item, index).toLowerCase();
  const currentBlob = `${item.text_cn || ""} ${item.text_en || ""}`.toLowerCase();
  const blob = `${subjectBlob} ${currentBlob}`;

  if (item.category === "Added") {
    if (/l3|l3llm|abstraction/.test(blob)) {
      return {
        ...item,
        text_cn: "**L3 抽象模型配置**：新增专用的 L3 LLM 配置入口，用于独立管理抽象总结阶段的模型调用。",
        text_en:
          "**L3 Abstraction Model Configuration**: Added a dedicated L3 LLM configuration entry for abstraction-stage model calls.",
      };
    }
    if (/cjk|keyword tokenization|关键词|分词/.test(blob)) {
      return {
        ...item,
        text_cn: "**中文关键词召回支持**：增强 CJK 关键词分词能力，提升中文内容的检索与召回效果。",
        text_en:
          "**Chinese Keyword Recall**: Improved CJK keyword tokenization to strengthen retrieval and recall for Chinese content.",
      };
    }
  }

  if (item.category === "Improved") {
    if (/cpu|full-table vector scan|vector scan|向量/.test(blob)) {
      return {
        ...item,
        text_cn: "**向量扫描性能优化**：优化同步全表向量扫描路径，降低大数据量场景下的网关 CPU 压力。",
        text_en:
          "**Vector Scan Performance**: Optimized synchronous full-table vector scanning to reduce gateway CPU pressure at larger data sizes.",
      };
    }
    if (/xml boundary|memory context with xml|context boundary|上下文/.test(blob)) {
      return {
        ...item,
        text_cn: "**检索上下文边界优化**：使用更清晰的 XML 边界组织记忆上下文，降低模型误读上下文的概率。",
        text_en:
          "**Retrieval Context Boundaries**: Organized memory context with clearer XML boundaries to reduce model misreads.",
      };
    }
    if (/hermes|provider link|bridge package version|startup poll|double-spawn|bridge/.test(blob)) {
      return {
        ...item,
        text_cn:
          "**Hermes 集成稳定性增强**：优化 provider 启动等待、链接管理和桥接版本读取，提升本地插件与 Hermes 的兼容性。",
        text_en:
          "**Hermes Integration Stability**: Improved provider startup waits, link management, and bridge version loading for better Hermes compatibility.",
      };
    }
  }

  if (item.category === "Fixed") {
    if (/lightweightmemory|skip evolution|轻量记忆/.test(blob)) {
      return {
        ...item,
        text_cn:
          "**轻量记忆模式不生效**：修复 `algorithm.lightweightMemory.enabled=true` 时仍可能触发演化流水线的问题。",
        text_en:
          "**Lightweight Memory Mode**: Fixed cases where `algorithm.lightweightMemory.enabled=true` could still trigger the evolution pipeline.",
      };
    }
    if (/openai_compatible|endpoint paths|endpoint/.test(blob) && /session exemption|loopback|auth/.test(blob)) {
      return {
        ...item,
        text_cn: "**连接与鉴权边界修复**：修复 OpenAI-compatible endpoint 完整路径探测和本地 RPC 会话豁免边界问题。",
        text_en:
          "**Connection and Auth Boundaries**: Fixed full-path OpenAI-compatible endpoint probing and local RPC session exemption boundaries.",
      };
    }
    if (/openai_compatible|endpoint paths|endpoint/.test(blob)) {
      return {
        ...item,
        text_cn: "**OpenAI-compatible endpoint 探测异常**：修复完整 endpoint 路径下 provider 探测不稳定的问题。",
        text_en:
          "**OpenAI-compatible Endpoint Probing**: Fixed unstable provider probing when a full endpoint path is configured.",
      };
    }
    if (/session exemption|loopback|auth/.test(blob)) {
      return {
        ...item,
        text_cn: "**RPC 会话鉴权边界修复**：收紧本地 RPC 会话豁免范围，避免非 loopback 调用误入免鉴权路径。",
        text_en:
          "**RPC Session Auth Boundary**: Tightened local RPC session exemptions so non-loopback calls cannot bypass auth handling.",
      };
    }
    if (/empty response|error response|dirty-reward|orphan trace|llm|trace|recovery/.test(blob)) {
      return {
        ...item,
        text_cn: "**记忆恢复与采集边界问题**：修复脏数据恢复、孤立 trace 写入和 LLM 空响应重试等稳定性问题。",
        text_en:
          "**Memory Recovery and Capture Boundaries**: Fixed dirty-data recovery, orphan trace writes, and LLM empty-response retry stability issues.",
      };
    }
  }

  return item;
}

function scoreOwnerCandidate(item, group, sourceGroupCount, order) {
  let score = 0;
  if (item.category === group.category) score += 100;
  if (sourceGroupCount === 1) score += 20;
  score -= sourceGroupCount;
  score -= order / 1000;
  return score;
}

function dedupeSourceRefsByBestCategory(items, index) {
  const candidatesByGroup = new Map();
  for (const [order, item] of items.entries()) {
    for (const groupKey of groupKeysForItem(item, index.refToGroup)) {
      const group = index.groups.get(groupKey);
      if (!group) continue;
      const sourceGroupCount = groupKeysForItem(item, index.refToGroup).length;
      const candidates = candidatesByGroup.get(groupKey) || [];
      candidates.push({ item, order, sourceGroupCount });
      candidatesByGroup.set(groupKey, candidates);
    }
  }

  const ownerByGroup = new Map();
  for (const [groupKey, candidates] of candidatesByGroup.entries()) {
    const group = index.groups.get(groupKey);
    if (!group) continue;
    const sorted = [...candidates].sort((a, b) => {
      const scoreDelta =
        scoreOwnerCandidate(b.item, group, b.sourceGroupCount, b.order) -
        scoreOwnerCandidate(a.item, group, a.sourceGroupCount, a.order);
      return scoreDelta || a.order - b.order;
    });
    ownerByGroup.set(groupKey, sorted[0].item);
  }

  let removedDuplicateRefs = 0;
  let droppedItems = 0;
  const filtered = [];
  for (const item of items) {
    const refs = [];
    for (const ref of item.source_refs) {
      const groupKey = groupKeyForRef(ref, index.refToGroup);
      const owner = ownerByGroup.get(groupKey);
      if (!owner || owner === item) {
        if (!refs.includes(ref)) refs.push(ref);
      } else {
        removedDuplicateRefs += 1;
      }
    }
    if (refs.length === 0) {
      droppedItems += 1;
      continue;
    }
    filtered.push({ ...item, source_refs: refs });
  }
  return { items: filtered, removedDuplicateRefs, droppedItems };
}

function dedupeReleaseItems(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.category}\n${item.text_cn}\n${item.text_en}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, source_refs: [...item.source_refs] });
      continue;
    }
    for (const ref of item.source_refs) {
      if (!existing.source_refs.includes(ref)) existing.source_refs.push(ref);
    }
  }
  return [...byKey.values()];
}

function categoriesFromReleaseItems(items) {
  const releaseCategories = {};
  const docsCategories = { cn: {}, en: {} };
  for (const category of RELEASE_CATEGORY_ORDER) {
    const categoryItems = items.filter((item) => item.category === category);
    if (categoryItems.length === 0) continue;
    releaseCategories[category] = categoryItems.map((item) => item.text_cn);
    const docCategory = RELEASE_TO_DOC_CATEGORY[category];
    docsCategories.cn[docCategory] = categoryItems.map((item) => item.text_cn);
    docsCategories.en[docCategory] = categoryItems.map((item) => item.text_en);
  }
  return { releaseCategories, docsCategories };
}

function coverageFromReleaseItems(evidence, draft, items, index) {
  const coveredRefs = [];
  const coveredGroups = new Set();
  const invalidItemRefs = [];
  for (const item of items) {
    for (const ref of item.source_refs || []) {
      if (!coveredRefs.includes(ref)) coveredRefs.push(ref);
      const groupKey = groupKeyForRef(ref, index.refToGroup);
      if (index.groups.has(groupKey)) coveredGroups.add(groupKey);
      if (index.knownRefs.size > 0 && !index.knownRefs.has(ref)) {
        invalidItemRefs.push({
          ref,
          text_cn: item.text_cn,
          category: item.category,
        });
      }
    }
  }

  const required = [...index.groups.values()];
  const missingRequired = required
    .filter((group) => !coveredGroups.has(group.key))
    .map((group) => ({
      short_sha: group.refs.find((ref) => /^[a-f0-9]{7,40}$/.test(ref)) || "",
      subject: group.subject,
      refs: group.refs,
      reason: group.reason || "important local-plugin release source",
    }));
  const previousCoverage = draft.coverage || {};
  const requiredCount = required.length || Number(previousCoverage.required_count || 0);
  const missingRequiredCount = required.length
    ? missingRequired.length
    : Number(previousCoverage.missing_required_count || 0);
  const coveredRequiredCount = required.length
    ? required.length - missingRequired.length
    : Number(previousCoverage.covered_required_count || 0);
  const needsReview = missingRequiredCount > 0 || invalidItemRefs.length > 0 || items.length === 0;

  return {
    ...previousCoverage,
    needs_review: needsReview,
    required_count: requiredCount,
    covered_required_count: coveredRequiredCount,
    missing_required_count: missingRequiredCount,
    missing_required: missingRequired,
    invalid_item_refs: invalidItemRefs,
    covered_refs: coveredRefs.sort(),
    policy:
      previousCoverage.policy ||
      "important feat/fix/perf/refactor commits must be referenced by at least one bullet source_ref",
  };
}

function languageIssuesFromReleaseItems(items) {
  const issues = [];
  for (const [index, item] of items.entries()) {
    if (!CJK_RE.test(item.text_cn || "")) {
      issues.push({
        index,
        category: item.category,
        field: "text_cn",
        current_text: item.text_cn || "",
        reason: "Chinese release-note text must contain CJK characters.",
      });
    }
    if (CJK_RE.test(item.text_en || "")) {
      issues.push({
        index,
        category: item.category,
        field: "text_en",
        current_text: item.text_en || "",
        reason: "English release-note text must not contain CJK characters.",
      });
    }
  }
  return issues;
}

function summarizeCoverageForValidation(coverage) {
  const value = coverage || {};
  return {
    needs_review: Boolean(value.needs_review),
    required_count: Number(value.required_count || 0),
    covered_required_count: Number(value.covered_required_count || 0),
    missing_required_count: Number(value.missing_required_count || 0),
    missing_required: Array.isArray(value.missing_required) ? value.missing_required : [],
    invalid_item_refs: Array.isArray(value.invalid_item_refs) ? value.invalid_item_refs : [],
  };
}

function validationReportFromPostprocessedDraft(draft) {
  const coverage = summarizeCoverageForValidation(draft?.coverage);
  const languageIssues = Array.isArray(draft?.language_issues) ? draft.language_issues : [];
  const issues = [];
  for (const issue of languageIssues) {
    issues.push({
      kind: "language",
      index: issue.index,
      category: issue.category,
      field: issue.field,
      current_text: issue.current_text || "",
      reason: issue.reason,
    });
  }
  for (const item of coverage.missing_required) {
    issues.push({
      kind: "missing_required_source",
      refs: Array.isArray(item.refs) ? item.refs : [],
      short_sha: item.short_sha || "",
      subject: item.subject || "",
      reason: item.reason || "important local-plugin release source",
    });
  }
  for (const item of coverage.invalid_item_refs) {
    issues.push({
      kind: "invalid_source_ref",
      ref: item.ref || "",
      category: item.category || "",
      text_cn: item.text_cn || "",
      reason: "release note cites a source_ref that is not present in evidence",
    });
  }
  if (!Array.isArray(draft?.release_items) || draft.release_items.length === 0) {
    issues.push({
      kind: "empty_release_items",
      reason: "release_items must contain at least one evidence-backed item",
    });
  }

  const repairableKinds = new Set(["language", "missing_required_source"]);
  const repairable =
    issues.length > 0 &&
    issues.every((issue) => repairableKinds.has(issue.kind)) &&
    Array.isArray(draft?.release_items) &&
    draft.release_items.length > 0;

  return {
    ok: Boolean(draft?.ok) && !draft?.needs_review && issues.length === 0,
    needs_review: Boolean(draft?.needs_review),
    repairable,
    issue_count: issues.length,
    language_issue_count: languageIssues.length,
    invalid_item_ref_count: coverage.invalid_item_refs.length,
    missing_required_count: coverage.missing_required_count,
    issues,
    coverage,
    postprocess: draft?.postprocess || {},
  };
}

function repairContextFromValidation({ draft, validationReport, repairAttempt, maxRepairAttempts }) {
  return {
    schema: "memos.plugin.release_notes.repair.v1",
    repair_attempt: repairAttempt,
    max_repair_attempts: maxRepairAttempts,
    validation_report: validationReport,
    previous_release_items: (draft.release_items || []).map((item, index) => ({
      index,
      category: item.category,
      text_cn: item.text_cn,
      text_en: item.text_en,
      source_refs: item.source_refs,
    })),
    instructions: [
      "Repair only the issues listed in validation_report. Do not rewrite already valid release-note facts.",
      "For language issues, edit only the affected text_cn/text_en field: text_cn must contain Chinese, text_en must contain no Chinese/CJK characters.",
      "Treat text_cn as the canonical wording first; text_en must be a faithful translation of text_cn, not an independently invented summary.",
      "Keep existing valid category and source_refs unchanged. Do not add source_refs that are not present in the evidence.",
      "For missing_required_source issues, add a concise product-facing item or attach the listed refs to a semantically matching existing item, using only the listed evidence.",
      "Return the same release_items schema with category, text_cn, text_en, and source_refs.",
    ],
  };
}

function validationAttemptRecord({ stage, repairAttempt, draft, validationReport }) {
  return {
    stage,
    repair_attempt: repairAttempt,
    ok: validationReport.ok,
    needs_review: validationReport.needs_review,
    repairable: validationReport.repairable,
    issue_count: validationReport.issue_count,
    language_issue_count: validationReport.language_issue_count,
    missing_required_count: validationReport.missing_required_count,
    invalid_item_ref_count: validationReport.invalid_item_ref_count,
    coverage: validationReport.coverage,
    issues: validationReport.issues,
    postprocess: draft.postprocess || {},
  };
}

export async function requestValidatedDraft(
  evidence,
  {
    requestImpl = requestDraft,
    maxRepairAttempts = MAX_DRAFT_REPAIR_ATTEMPTS,
  } = {},
) {
  let rawDraft = await requestImpl(evidence);
  const attempts = [];
  let finalDraft = null;

  for (let repairAttempt = 0; repairAttempt <= maxRepairAttempts; repairAttempt += 1) {
    const stage = repairAttempt === 0 ? "draft" : "repair";
    const postprocessed = postprocessDraftFromEvidence(rawDraft, evidence);
    const validationReport = validationReportFromPostprocessedDraft(postprocessed);
    attempts.push(validationAttemptRecord({ stage, repairAttempt, draft: postprocessed, validationReport }));

    finalDraft = {
      ...postprocessed,
      validation_report: validationReport,
      repair_attempts: attempts,
      validation_attempt_count: attempts.length,
      repair_attempt_count: Math.max(0, attempts.length - 1),
    };

    if (validationReport.ok) {
      return finalDraft;
    }
    if (!validationReport.repairable || repairAttempt >= maxRepairAttempts) {
      return finalDraft;
    }

    const stageLabel =
      repairAttempt === 0 ? "initial draft validation" : `repair validation attempt ${repairAttempt}`;
    warn(
      `Release notes validation failed after ${stageLabel}; requesting draft repair ` +
        `${repairAttempt + 1}/${maxRepairAttempts}: ${validationReport.issues
          .map((issue) => issue.kind)
          .join(", ")}`,
    );
    rawDraft = await requestImpl({
      ...evidence,
      release_notes_repair_context: repairContextFromValidation({
        draft: finalDraft,
        validationReport,
        repairAttempt: repairAttempt + 1,
        maxRepairAttempts,
      }),
    });
  }

  return finalDraft;
}

function embeddedReleaseNotesPayload(items, coverage) {
  return {
    schema: "memos.plugin.release_notes.v1",
    items: items.map((item) => ({
      category: item.category,
      text_cn: item.text_cn,
      text_en: item.text_en,
      source_refs: item.source_refs,
    })),
    coverage: {
      needs_review: Boolean(coverage.needs_review),
      required_count: Number(coverage.required_count || 0),
      covered_required_count: Number(coverage.covered_required_count || 0),
      missing_required_count: Number(coverage.missing_required_count || 0),
    },
  };
}

function markdownFromReleaseItems(items, coverage) {
  const lines = ["## Changelog"];
  for (const category of RELEASE_CATEGORY_ORDER) {
    const categoryItems = items.filter((item) => item.category === category);
    if (categoryItems.length === 0) continue;
    lines.push("");
    lines.push(`### ${category}`);
    for (const item of categoryItems) {
      lines.push(`- ${item.text_cn}`);
    }
  }
  lines.push("");
  lines.push(`<!-- ${RELEASE_NOTES_MARKER}`);
  lines.push(JSON.stringify(embeddedReleaseNotesPayload(items, coverage), null, 2));
  lines.push("-->");
  return `${lines.join("\n").trim()}\n`;
}

export function postprocessDraftFromEvidence(draft, evidence) {
  const inputItems = Array.isArray(draft?.release_items)
    ? draft.release_items.map(normalizeReleaseItem).filter(Boolean)
    : [];
  if (inputItems.length === 0) return draft;

  const index = buildSourceRefIndex(evidence);
  let reclassifiedItems = 0;
  let items = inputItems.map((item) => {
    const hintedCategory = bestHintCategoryForItem(item, index);
    const category = hintedCategory || item.category;
    if (category !== item.category) reclassifiedItems += 1;
    return rewriteKnownReleaseItem({ ...item, category }, index);
  });

  const deduped = dedupeSourceRefsByBestCategory(items, index);
  items = dedupeReleaseItems(
    deduped.items.map((item) => {
      const hintedCategory = bestHintCategoryForItem(item, index);
      const category = hintedCategory || item.category;
      if (category !== item.category) reclassifiedItems += 1;
      return rewriteKnownReleaseItem({ ...item, category }, index);
    }),
  );

  const coverage = coverageFromReleaseItems(evidence, draft, items, index);
  const languageIssues = languageIssuesFromReleaseItems(items);
  if (languageIssues.length > 0) {
    coverage.needs_review = true;
  }
  const { releaseCategories, docsCategories } = categoriesFromReleaseItems(items);
  const postprocess = {
    applied: true,
    removed_duplicate_source_refs: deduped.removedDuplicateRefs,
    dropped_empty_source_items: deduped.droppedItems,
    reclassified_items: reclassifiedItems,
    final_item_count: items.length,
  };
  const warnings = Array.isArray(draft.warnings) ? [...draft.warnings] : [];
  if (
    postprocess.removed_duplicate_source_refs > 0 ||
    postprocess.dropped_empty_source_items > 0 ||
    postprocess.reclassified_items > 0
  ) {
    warnings.push("release notes were postprocessed to dedupe source_refs and apply evidence category hints");
  }
  if (languageIssues.length > 0) {
    warnings.push("release notes language validation failed; manual review is required");
  }

  return {
    ...draft,
    ok: Boolean(items.length) && !coverage.needs_review,
    needs_review: Boolean(coverage.needs_review),
    release_items: items,
    release_categories: releaseCategories,
    docs_categories: docsCategories,
    coverage,
    warnings,
    language_issues: languageIssues,
    postprocess,
    release_notes_markdown: markdownFromReleaseItems(items, coverage),
  };
}

export function validateManualNotes(notes) {
  const text = String(notes || "").trim();
  if (!/^## Changelog\s*$/m.test(text)) {
    fail("Manual release notes must contain a '## Changelog' heading.");
  }
  const match = text.match(/<!--\s*doc-agent-release-notes-json\s*\n([\s\S]*?)\n-->/);
  if (!match) {
    fail("Manual release notes must include the doc-agent-release-notes-json evidence block.");
  }
  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    fail("Manual release notes contain invalid doc-agent-release-notes-json.");
  }
  if (!Array.isArray(payload?.items) || payload.items.length === 0) {
    fail("Manual release notes evidence block must contain non-empty items.");
  }
  if (payload?.coverage?.needs_review !== false) {
    fail("Manual release notes evidence coverage must explicitly set needs_review=false.");
  }
  for (const item of payload.items) {
    if (!item?.text_cn || !item?.text_en || !Array.isArray(item?.source_refs) || item.source_refs.length === 0) {
      fail("Every manual release-note item must include text_cn, text_en, and source_refs.");
    }
    if (!CJK_RE.test(String(item.text_cn || ""))) {
      fail("Every manual release-note item text_cn must contain Chinese text.");
    }
    if (CJK_RE.test(String(item.text_en || ""))) {
      fail("Every manual release-note item text_en must not contain Chinese/CJK characters.");
    }
  }
  return text;
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function cleanError(value) {
  return String(value || "")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "https://***")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "***")
    .replace(/\s+/g, " ")
    .slice(0, 600);
}

function requiredUrlFromEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    fail(`${name} secret is required when release_notes input is empty.`);
  }
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) fail(`${name} must be an HTTP(S) URL.`);
  } catch {
    fail(`${name} must be an HTTP(S) URL.`);
  }
  return value;
}

function optionalUrlFromEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) fail(`${name} must be an HTTP(S) URL.`);
  } catch {
    fail(`${name} must be an HTTP(S) URL.`);
  }
  return value;
}

export async function reportFailure({ evidence, attempts, finalError, phase = "release-notes", fetchImpl = fetch }) {
  if (attempts.length < 3) return { skipped: true, reason: "fewer than three attempts" };
  const token = process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN || "";
  if (!token.trim()) return { skipped: true, reason: "missing configured token" };
  const url = optionalUrlFromEnv("DOC_AGENT_RELEASE_FAILURE_URL");
  if (!url) return { skipped: true, reason: "missing configured failure URL" };
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      product_id: PRODUCT_ID,
      repository: evidence.repo,
      version: evidence.target_version,
      phase,
      run_id: process.env.GITHUB_RUN_ID || `${evidence.current_tag}-local`,
      run_url: process.env.GITHUB_RUN_ID
        ? `https://github.com/${evidence.repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "",
      attempts: attempts.slice(0, 3).map((item, index) => ({
        attempt: index + 1,
        error_code: item.error_code || "DRAFT_FAILED",
        message: cleanError(item.message),
        retryable: Boolean(item.retryable),
      })),
      final_error: cleanError(finalError),
    }),
  });
  if (!response.ok) {
    throw new Error(`Failure-report endpoint returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function reportExternalFailureFromEnv({ fetchImpl = fetch } = {}) {
  const phase = String(process.env.RELEASE_FAILURE_PHASE || "").trim();
  const attemptDir = String(process.env.RELEASE_FAILURE_ATTEMPT_DIR || "").trim();
  if (!phase || !attemptDir) fail("RELEASE_FAILURE_PHASE and RELEASE_FAILURE_ATTEMPT_DIR are required.");
  const attempts = [1, 2, 3].map((attempt) => {
    let message = "attempt log is unavailable";
    try { message = readFileSync(join(attemptDir, `${attempt}.log`), "utf8"); } catch {}
    return { error_code: phase.toUpperCase().replace(/[^A-Z0-9]+/g, "_"), message: cleanError(message), retryable: true };
  });
  return reportFailure({
    evidence: {
      repo: process.env.GITHUB_REPOSITORY || "MemTensor/MemOS",
      target_version: displayVersion(process.env.RELEASE_VERSION),
      current_tag: process.env.RELEASE_TAG || `${CURRENT_TAG_PREFIX}${cleanVersion(process.env.RELEASE_VERSION)}`,
    },
    attempts,
    finalError: attempts[2].message,
    phase,
    fetchImpl,
  });
}

export async function requestDraft(
  evidence,
  { fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  const url = requiredUrlFromEnv("DOC_AGENT_RELEASE_NOTES_DRAFT_URL");
  const token = process.env.DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN || "";
  if (!token.trim()) {
    fail("DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN secret is required when release_notes input is empty.");
  }

  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ...evidence,
          workflow_retry_context: {
            attempt,
            previous_errors: attempts.map((item) => item.message),
          },
        }),
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw Object.assign(new Error(`non-JSON response: HTTP ${response.status}`), {
          retryable: isRetryableStatus(response.status),
          errorCode: `HTTP_${response.status}`,
        });
      }
      if (!response.ok) {
        throw Object.assign(
          new Error(`HTTP ${response.status} ${JSON.stringify(payload).slice(0, 400)}`),
          { retryable: isRetryableStatus(response.status), errorCode: `HTTP_${response.status}` },
        );
      }
      if (!payload.ok || payload.needs_review) {
        const serverAttempts = Array.isArray(payload.attempts) ? payload.attempts : [];
        const coverage = payload.coverage ? JSON.stringify(payload.coverage) : "";
        const warnings = Array.isArray(payload.warnings) ? payload.warnings.join("; ") : "";
        const message = `Release notes draft needs review. ${coverage} ${warnings}`.trim();
        if (serverAttempts.length >= 3) {
          await reportFailure({
            evidence,
            attempts: serverAttempts.map((item) => ({
              error_code: "DRAFT_VALIDATION",
              message: item.error || message,
              retryable: false,
            })),
            finalError: message,
            fetchImpl,
          });
        }
        fail(message);
      }
      if (!String(payload.release_notes_markdown || "").trim()) {
        fail("Release-notes draft service returned an empty release_notes_markdown.");
      }
      return payload;
    } catch (error) {
      const entry = {
        error_code: error?.errorCode || "DRAFT_REQUEST",
        message: cleanError(error?.message || error),
        retryable: Boolean(error?.retryable),
      };
      attempts.push(entry);
      if (!entry.retryable || attempt === 3) {
        if (attempts.length === 3) {
          await reportFailure({ evidence, attempts, finalError: entry.message, fetchImpl });
        }
        fail(`Release-notes draft request failed on attempt ${attempt}: ${entry.message}`);
      }
      warn(`Release-notes draft attempt ${attempt} failed; retrying: ${entry.message}`);
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
  fail("Release-notes draft failed after three attempts.");
}

export async function main() {
  const targetVersion = cleanVersion(process.env.RELEASE_VERSION);
  if (!targetVersion) fail("RELEASE_VERSION is required.");

  const currentTag = process.env.RELEASE_TAG || `${CURRENT_TAG_PREFIX}${targetVersion}`;
  const notesPath =
    process.env.RELEASE_NOTES_FILE ||
    join(tmpdir(), `memos-local-plugin-${targetVersion}-release-notes.md`);
  mkdirSync(dirname(notesPath), { recursive: true });

  const manualNotes = String(process.env.MANUAL_RELEASE_NOTES || "").trim();
  if (manualNotes) {
    writeFileSync(notesPath, ensureSourceHint(validateManualNotes(manualNotes)), "utf8");
    appendOutput("release_notes_file", notesPath);
    appendOutput("draft_used", "false");
    console.log(`Using manually provided release notes: ${notesPath}`);
    return;
  }

  const previousTag = findPreviousTag(targetVersion, currentTag);
  if (!previousTag) {
    fail(`Cannot find a previous local plugin tag before ${currentTag}.`);
  }

  const currentRef = resolveCurrentRef(currentTag);
  const evidence = collectEvidence({ targetVersion, currentTag, previousTag, currentRef });
  const evidencePath = join(tmpdir(), `memos-local-plugin-${targetVersion}-evidence.json`);
  writeFileSync(evidencePath, JSON.stringify(evidenceForInspection(evidence), null, 2), "utf8");

  const draft = await requestValidatedDraft(evidence);
  if (!draft.ok || draft.needs_review) {
    fail(`Postprocessed release notes require review: ${JSON.stringify(draft.validation_report || draft.coverage || {})}`);
  }
  const draftPath = join(tmpdir(), `memos-local-plugin-${targetVersion}-release-notes-draft.json`);
  writeFileSync(draftPath, JSON.stringify(draftForInspection(draft), null, 2), "utf8");
  writeFileSync(notesPath, ensureSourceHint(draft.release_notes_markdown), "utf8");

  appendOutput("release_notes_file", notesPath);
  appendOutput("evidence_file", evidencePath);
  appendOutput("draft_file", draftPath);
  appendOutput("draft_used", "true");
  appendOutput("previous_tag", previousTag);
  appendOutput("current_tag", currentTag);
  appendOutput("current_ref", currentRef);
  appendOutput("draft_confidence", String(draft.confidence || ""));
  appendOutput("missing_required_count", String(draft.coverage?.missing_required_count ?? ""));
  appendOutput("validation_attempt_count", String(draft.validation_attempt_count ?? ""));
  appendOutput("repair_attempt_count", String(draft.repair_attempt_count ?? ""));

  console.log(`Drafted release notes with configured service: ${notesPath}`);
  console.log(`Previous tag: ${previousTag}`);
  console.log(`Current tag: ${currentTag}`);
  console.log(`Current evidence ref: ${currentRef}`);
  console.log(`Coverage: ${JSON.stringify(draft.coverage || {})}`);
  console.log(`Validation attempts: ${draft.validation_attempt_count ?? ""}`);
  console.log(`Repair attempts: ${draft.repair_attempt_count ?? ""}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const run = process.env.RELEASE_FAILURE_PHASE ? reportExternalFailureFromEnv : main;
  run().catch((error) => {
    console.error(`::error::${cleanError(error?.message || String(error))}`);
    process.exitCode = 1;
  });
}
