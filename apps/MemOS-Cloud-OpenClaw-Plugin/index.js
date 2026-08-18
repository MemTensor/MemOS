#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  addMessage,
  buildConfig,
  extractResultData,
  extractText,
  formatRecallHookResult,
  isAgentAllowed,
  isOpenClawSystemPrompt,
  resolveAgentConfig,
  searchMemory,
  stripOpenClawInjectedPrefix,
} from "./lib/memos-cloud-api.js";
import { reportRumEvent } from "./lib/arms-reporter.js";
import { startUpdateChecker } from "./lib/check-update.js";
import {
  closeConfigUiService,
  compareVersionStrings,
  detectHostVersion,
  ensureConfigUiService,
  ensurePluginHookPolicy,
  isGatewayRuntimeStartup,
  waitForGatewayReady,
} from "./lib/config-ui-server.js";
let lastCaptureTime = 0;
// ponytail: in-process cache; replace with server idempotency for cross-restart or multi-instance guarantees.
const recentCaptureKeys = new Set();
const MAX_CAPTURE_KEYS = 1000;
const conversationCounters = new Map();
const API_KEY_HELP_URL = "https://memos-dashboard.openmem.net/cn/apikeys/";
const ENV_FILE_SEARCH_HINTS = ["~/.openclaw/.env", "~/.moltbot/.env", "~/.clawdbot/.env"];
const MEMOS_SOURCE = (() => {
  const platform = process.platform;
  if (platform === "win32") return "openclaw_win";
  if (platform === "darwin") return "openclaw_mac";
  if (platform === "linux") return "openclaw_linux";
  return "openclaw";
})();

// Heartbeat prompts are always injected at the very beginning of the user
// content by the host (OpenClaw). Anchoring at start prevents false positives
// when a legitimate user message happens to mention these phrases.
const HEARTBEAT_PROMPT_PATTERN =
  /^\s*(?:Read HEARTBEAT\.md if it exists\b|\[OpenClaw heartbeat poll\])/i;
const SYSTEM_COMMAND_PATTERN = /^\/(?:new|reset|clear|stop|status|help|dock_|undock)\b/i;
const INTERNAL_SYSTEM_PROMPT_PATTERNS = [
  /^A new session was started via \/new or \/reset\./i,
  /^Based on this conversation, generate a short 1-2 word filename slug\b[\s\S]*\bReply with ONLY the slug\b/i,
];

function isHeartbeatPrompt(text) {
  return typeof text === "string" && HEARTBEAT_PROMPT_PATTERN.test(text);
}

export function isSystemCommandPrompt(text) {
  if (typeof text !== "string") return false;
  const prompt = text.trimStart();
  return SYSTEM_COMMAND_PATTERN.test(prompt) || INTERNAL_SYSTEM_PROMPT_PATTERNS.some((pattern) => pattern.test(prompt));
}

function warnMissingApiKey(log, context) {
  const heading = "[memos-cloud] Missing MEMOS_API_KEY (Token auth)";
  const header = `${heading}${context ? `; ${context} skipped` : ""}. Configure it with:`;
  log.warn?.(
    [
      header,
      "echo 'export MEMOS_API_KEY=\"mpg-...\"' >> ~/.zshrc",
      "source ~/.zshrc",
      "or",
      "echo 'export MEMOS_API_KEY=\"mpg-...\"' >> ~/.bashrc",
      "source ~/.bashrc",
      "or",
      "[System.Environment]::SetEnvironmentVariable(\"MEMOS_API_KEY\", \"mpg-...\", \"User\")",
      `Get API key: ${API_KEY_HELP_URL}`,
    ].join("\n"),
  );
}

function getCounterSuffix(sessionKey) {
  if (!sessionKey) return "";
  const current = conversationCounters.get(sessionKey) ?? 0;
  return current > 0 ? `#${current}` : "";
}

function bumpConversationCounter(sessionKey) {
  if (!sessionKey) return;
  const current = conversationCounters.get(sessionKey) ?? 0;
  conversationCounters.set(sessionKey, current + 1);
}

function getEffectiveAgentId(cfg, ctx) {
  if (!cfg.multiAgentMode) {
    return cfg.agentId;
  }
  const agentId = ctx?.agentId || cfg.agentId;
  return agentId === "main" ? undefined : agentId;
}

export function extractDirectSessionUserId(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") return "";
  const parts = sessionKey.split(":");
  const directIndex = parts.lastIndexOf("direct");
  if (directIndex === -1) return "";
  return parts[directIndex + 1] || "";
}

export function resolveMemosUserId(cfg, ctx) {
  const fallback = cfg?.userId || "openclaw-user";
  if (!cfg?.useDirectSessionUserId) return fallback;
  const directUserId = extractDirectSessionUserId(ctx?.sessionKey);
  return directUserId || fallback;
}

function resolveConversationId(cfg, ctx) {
  if (cfg.conversationId) return cfg.conversationId;
  // TODO: consider binding conversation_id directly to OpenClaw sessionId (prefer ctx.sessionId).
  const agentId = getEffectiveAgentId(cfg, ctx);
  const base = ctx?.sessionKey || ctx?.sessionId || (agentId ? `openclaw:${agentId}` : "");
  const dynamicSuffix = cfg.conversationSuffixMode === "counter" ? getCounterSuffix(ctx?.sessionKey) : "";
  const prefix = cfg.conversationIdPrefix || "";
  const suffix = cfg.conversationIdSuffix || "";
  if (base) return `${prefix}${base}${dynamicSuffix}${suffix}`;
  return `${prefix}openclaw-${Date.now()}${dynamicSuffix}${suffix}`;
}

export function buildSearchPayload(cfg, prompt, ctx) {
  const cleanPrompt = stripOpenClawInjectedPrefix(prompt);
  const queryRaw = `${cfg.queryPrefix || ""}${cleanPrompt}`;
  const query =
    Number.isFinite(cfg.maxQueryChars) && cfg.maxQueryChars > 0
      ? queryRaw.slice(0, cfg.maxQueryChars)
      : queryRaw;

  const payload = {
    user_id: resolveMemosUserId(cfg, ctx),
    query,
    source: MEMOS_SOURCE,
  };

  if (!cfg.recallGlobal) {
    const conversationId = resolveConversationId(cfg, ctx);
    if (conversationId) payload.conversation_id = conversationId;
  }

  let filterObj = cfg.filter ? JSON.parse(JSON.stringify(cfg.filter)) : null;
  const agentId = getEffectiveAgentId(cfg, ctx);

  // Check if the filter is already in the categorized format (filter1)
  const isCategorized = filterObj && (filterObj.user !== undefined || filterObj.knowledgebase !== undefined || filterObj.public !== undefined);
  let userFilter = isCategorized ? (filterObj.user || null) : filterObj;

  if (agentId) {
    if (userFilter && Object.keys(userFilter).length > 0) {
      if (Array.isArray(userFilter.and)) {
        userFilter.and.push({ agent_id: agentId });
      } else {
        userFilter = { and: [userFilter, { agent_id: agentId }] };
      }
    } else {
      userFilter = { and: [{ agent_id: agentId }] };
    }
  }

  if (isCategorized) {
    if (userFilter && Object.keys(userFilter).length > 0) filterObj.user = userFilter;
    if (Object.keys(filterObj).length > 0) payload.filter = filterObj;
  } else if (userFilter && Object.keys(userFilter).length > 0) {
    // If not categorized, wrap it in 'user' so knowledgebase is not filtered
    payload.filter = { user: userFilter };
  }

  if (cfg.knowledgebaseIds?.length) payload.knowledgebase_ids = cfg.knowledgebaseIds;

  payload.memory_limit_number = cfg.memoryLimitNumber;
  payload.include_preference = cfg.includePreference;
  payload.preference_limit_number = cfg.preferenceLimitNumber;
  payload.include_tool_memory = cfg.includeToolMemory;
  payload.tool_memory_limit_number = cfg.toolMemoryLimitNumber;
  payload.relativity = cfg.relativity;

  return payload;
}

export function buildAddMessagePayload(cfg, messages, ctx) {
  const payload = {
    user_id: resolveMemosUserId(cfg, ctx),
    conversation_id: resolveConversationId(cfg, ctx),
    messages,
    source: MEMOS_SOURCE,
  };

  const agentId = getEffectiveAgentId(cfg, ctx);
  if (agentId) payload.agent_id = agentId;
  if (cfg.appId) payload.app_id = cfg.appId;
  if (cfg.tags?.length) payload.tags = cfg.tags;

  const info = {
    source: MEMOS_SOURCE,
    sessionKey: ctx?.sessionKey,
    agentId: ctx?.agentId,
    ...(cfg.info || {}),
  };
  if (Object.keys(info).length > 0) payload.info = info;

  payload.allow_public = cfg.allowPublic;
  if (cfg.allowKnowledgebaseIds?.length) payload.allow_knowledgebase_ids = cfg.allowKnowledgebaseIds;
  payload.async_mode = cfg.asyncMode;

  return payload;
}

function convertAssistantMessage(msg, cfg) {
  const contentArr = Array.isArray(msg.content)
    ? msg.content
    : msg.content
      ? [{ type: "text", text: String(msg.content) }]
      : [];

  const textContent = contentArr
    .filter((c) => c?.type === "text")
    .map((c) => c.text || "")
    .filter(Boolean)
    .join("\n");

  const toolCallItems = contentArr.filter((c) => c?.type === "toolCall");

  const result = { role: "assistant" };

  if (textContent) {
    result.content = truncate(textContent, cfg.maxMessageChars);
  }

  if (cfg.includeToolMemory && toolCallItems.length > 0) {
    result.tool_calls = toolCallItems.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
      },
    }));
  }

  if (!result.content && !result.tool_calls) return null;
  return result;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

// 把单个附件值（URL / data URI / 裸 base64）统一描述成可读 text：
// - http(s):// / 其它协议 URL：[<kind>: <url>]
// - data:<mediaType>;base64,...：[<kind> (<mediaType> base64, ~<size> chars)]
// - 其它（视为裸 base64）：[<kind> (base64, ~<size> chars)]
function describeAttachment(kind, value) {
  const dataMatch = /^data:([^;,]+)/i.exec(value);
  if (dataMatch) {
    return `[${kind} (${dataMatch[1] || kind} base64, ~${value.length} chars)]`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return `[${kind}: ${value}]`;
  }
  return `[${kind} (base64, ~${value.length} chars)]`;
}

// MemOS 是文本记忆服务，召回路径上图片/文件 block 几乎只有文本价值。
// 这里把所有 block 一律归一成 [{type:"text", text}]，但**保留 URL 文字本身**：
// - text block：透传文本（按 cfg.maxMessageChars 截头）
// - URL 形态：输出 "[image: <url>]" / "[file: <url>]"，URL 作为可检索文字保留
// - data URI / base64 形态：输出 "[image (<media_type> base64, ~<size> chars)]" 元数据描述，永不 inline base64
// - 未识别 type：含 url 字段则 "[<type>: <url>]"，否则 JSON.stringify 兜底
function normalizeToolResultContent(content, cfg) {
  const blocks = [];

  const pushText = (raw) => {
    const text = truncate(String(raw ?? ""), cfg.maxMessageChars);
    if (text) blocks.push({ type: "text", text });
  };

  // 解析所有协议下的 image 类 block，提取出统一的"附件值"再交给 describeAttachment 描述。
  // 覆盖：
  //   {type:"image_url", image_url:{url}} / {image_url:"<str>"} / 顶层 url   （OpenAI 风格）
  //   {type:"image", data, media_type} / {type:"image", source:{data, media_type}} （Claude 风格）
  //   {type:"image", url}                                                        （少见）
  const tryPushImageBlock = (block) => {
    const claudeData =
      (block.source && typeof block.source === "object" && block.source.data) || block.data || "";
    if (claudeData) {
      const mediaType =
        (block.source && typeof block.source === "object" && block.source.media_type) ||
        block.media_type ||
        block.mimeType ||
        "image";
      pushText(describeAttachment("image", `data:${mediaType};base64,${String(claudeData)}`));
      return true;
    }
    const url =
      (block.image_url && typeof block.image_url === "object" && block.image_url.url) ||
      (typeof block.image_url === "string" ? block.image_url : "") ||
      block.url ||
      "";
    if (!url) return false;
    pushText(describeAttachment("image", String(url)));
    return true;
  };

  // MemOS schema 标准 file block：{type:"file", file:{file_data}}，兼容顶层 file_data。
  const tryPushFileBlock = (block) => {
    const fileData =
      (block.file && typeof block.file === "object" && block.file.file_data) ||
      block.file_data ||
      "";
    if (!fileData) return false;
    pushText(describeAttachment("file", String(fileData)));
    return true;
  };

  const tryPushTypedBlock = (block) => {
    if (!block || typeof block !== "object") return false;
    if (block.type === "text") {
      pushText(block.text);
      return true;
    }
    if (block.type === "image_url" || block.type === "image") return tryPushImageBlock(block);
    if (block.type === "file") return tryPushFileBlock(block);
    return false;
  };

  // 未识别 type：有 url 字段则给可读占位，否则整体 stringify。
  const fallbackSerialize = (block) => {
    if (
      block &&
      typeof block === "object" &&
      typeof block.type === "string" &&
      typeof block.url === "string" &&
      block.url
    ) {
      pushText(`[${block.type}: ${block.url}]`);
      return;
    }
    const serialized = safeStringify(block);
    if (serialized) pushText(serialized);
  };

  if (content == null || content === "") return blocks;

  if (typeof content === "string") {
    pushText(content);
    return blocks;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block == null) continue;
      if (typeof block === "string") {
        pushText(block);
        continue;
      }
      if (typeof block !== "object") continue;
      if (tryPushTypedBlock(block)) continue;
      fallbackSerialize(block);
    }
    return blocks;
  }

  if (typeof content === "object") {
    if (!tryPushTypedBlock(content)) {
      fallbackSerialize(content);
    }
    return blocks;
  }

  return blocks;
}

function convertToolResultMessage(msg, cfg) {
  const toolCallId = msg.toolCallId || msg.tool_call_id;
  if (!toolCallId) return null;
  const blocks = normalizeToolResultContent(msg.content, cfg);
  if (blocks.length === 0) return null;
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: blocks,
  };
}

// 把 OpenClaw 的单条原始消息转成 MemOS /add/message 接受的形态。
// 三类 role 分发：user / assistant / toolResult，其它 role（system/...）直接丢弃返 null。
function convertSessionMessage(msg, cfg) {
  if (!msg || !msg.role) return null;
  if (msg.role === "user") {
    const content = stripOpenClawInjectedPrefix(extractText(msg.content));
    if (!content) return null;
    return { role: "user", content: truncate(content, cfg.maxMessageChars) };
  }
  if (msg.role === "assistant" && cfg.includeAssistant) {
    return convertAssistantMessage(msg, cfg);
  }
  if (msg.role === "toolResult" && cfg.includeToolMemory) {
    return convertToolResultMessage(msg, cfg);
  }
  return null;
}

function pickLastTurnMessages(messages, cfg) {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return [];
  if (isOpenClawSystemPrompt(extractText(messages[lastUserIndex]?.content || ""))) return [];
  return messages
    .slice(lastUserIndex)
    .map((m) => convertSessionMessage(m, cfg))
    .filter(Boolean);
}

function pickFullSessionMessages(messages, cfg) {
  const out = [];
  let skipSystemTurn = false;
  for (const message of messages) {
    if (message?.role === "user") {
      skipSystemTurn = isOpenClawSystemPrompt(extractText(message.content || ""));
    } else if (skipSystemTurn) {
      continue;
    }
    const converted = convertSessionMessage(message, cfg);
    if (converted) out.push(converted);
  }
  return out;
}

function reserveCapture(payload, rawMessages, ctx, runId) {
  const sessionIdentity = ctx?.sessionId || ctx?.sessionKey;
  const stableMessageIdentities = rawMessages
    .map(
      (message) =>
        message?.idempotencyKey ??
        message?.id ??
        message?.messageId ??
        message?.timestamp,
    )
    .filter((identity) => identity !== undefined && identity !== null && identity !== "");
  const eventIdentity = stableMessageIdentities.length
    ? ["messages", stableMessageIdentities]
    : runId;
  if (!sessionIdentity || eventIdentity === undefined || eventIdentity === null || eventIdentity === "") {
    return null;
  }

  let captureSnapshot;
  try {
    captureSnapshot = JSON.stringify(payload.messages);
  } catch {
    return null;
  }
  if (!captureSnapshot) return null;

  const key = createHash("sha256")
    .update(
      JSON.stringify([
        payload.user_id,
        payload.conversation_id,
        payload.agent_id,
        payload.app_id,
        sessionIdentity,
        eventIdentity,
        captureSnapshot,
      ]),
    )
    .digest("hex");
  if (recentCaptureKeys.delete(key)) {
    recentCaptureKeys.add(key);
    return { duplicate: true };
  }

  recentCaptureKeys.add(key);
  if (recentCaptureKeys.size > MAX_CAPTURE_KEYS) {
    recentCaptureKeys.delete(recentCaptureKeys.keys().next().value);
  }
  return { duplicate: false, key };
}

function truncate(text, maxLen) {
  if (!text) return "";
  if (!maxLen) return text;
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseModelJson(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some models wrap JSON in markdown code fences.
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      return null;
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeIndexList(value, maxLen) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const v of value) {
    if (!Number.isInteger(v)) continue;
    if (v < 0 || v >= maxLen) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function buildRecallCandidates(data, cfg) {
  const limit = Number.isFinite(cfg.recallFilterCandidateLimit) ? Math.max(0, cfg.recallFilterCandidateLimit) : 30;
  const maxChars = Number.isFinite(cfg.recallFilterMaxItemChars) ? Math.max(80, cfg.recallFilterMaxItemChars) : 500;
  const memoryList = Array.isArray(data?.memory_detail_list) ? data.memory_detail_list : [];
  const preferenceList = Array.isArray(data?.preference_detail_list) ? data.preference_detail_list : [];
  const toolList = Array.isArray(data?.tool_memory_detail_list) ? data.tool_memory_detail_list : [];

  const memoryCandidates = memoryList.slice(0, limit).map((item, idx) => ({
    idx,
    text: truncate(item?.memory_value || item?.memory_key || "", maxChars),
    relativity: item?.relativity,
  }));
  const preferenceCandidates = preferenceList.slice(0, limit).map((item, idx) => ({
    idx,
    text: truncate(item?.preference || "", maxChars),
    relativity: item?.relativity,
    preference_type: item?.preference_type || "",
  }));
  const toolCandidates = toolList.slice(0, limit).map((item, idx) => ({
    idx,
    text: truncate(item?.tool_value || "", maxChars),
    relativity: item?.relativity,
  }));

  return {
    memoryList,
    preferenceList,
    toolList,
    candidatePayload: {
      memory: memoryCandidates,
      preference: preferenceCandidates,
      tool_memory: toolCandidates,
    },
  };
}

function applyRecallDecision(data, decision, lists) {
  const keep = decision?.keep || {};
  const memoryIdx = normalizeIndexList(keep.memory, lists.memoryList.length);
  const preferenceIdx = normalizeIndexList(keep.preference, lists.preferenceList.length);
  const toolIdx = normalizeIndexList(keep.tool_memory, lists.toolList.length);

  return {
    ...data,
    memory_detail_list: memoryIdx.map((idx) => lists.memoryList[idx]),
    preference_detail_list: preferenceIdx.map((idx) => lists.preferenceList[idx]),
    tool_memory_detail_list: toolIdx.map((idx) => lists.toolList[idx]),
  };
}

async function callRecallFilterModel(cfg, userPrompt, candidatePayload) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (cfg.recallFilterApiKey) {
    headers.Authorization = `Bearer ${cfg.recallFilterApiKey}`;
  }

  const modelInput = {
    user_query: userPrompt,
    candidate_memories: candidatePayload,
    output_schema: {
      keep: {
        memory: ["number index"],
        preference: ["number index"],
        tool_memory: ["number index"],
      },
      reason: "optional short string",
    },
  };

  const body = {
    model: cfg.recallFilterModel,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a strict memory relevance judge. Return JSON only. Keep only items directly useful for answering current user query. If unsure, do not keep.",
      },
      {
        role: "user",
        content: JSON.stringify(modelInput),
      },
    ],
  };

  let lastError;
  const retries = Number.isFinite(cfg.recallFilterRetries) ? Math.max(0, cfg.recallFilterRetries) : 1;
  const timeoutMs = Number.isFinite(cfg.recallFilterTimeoutMs) ? Math.max(1000, cfg.recallFilterTimeoutMs) : 30000;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let timeoutId;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${cfg.recallFilterBaseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content || "";
      const parsed = parseModelJson(text);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("invalid JSON output from recall filter model");
      }
      return parsed;
    } catch (err) {
      const isAbort = err?.name === "AbortError" || /aborted/i.test(String(err?.message ?? err));
      lastError = isAbort
        ? new Error(
            `timed out after ${timeoutMs}ms (raise recallFilterTimeoutMs; local LLMs often need 30s+ on cold start)`,
          )
        : err;
      if (attempt < retries) {
        await sleep(120 * (attempt + 1));
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }
  throw lastError;
}

async function maybeFilterRecallData(cfg, data, userPrompt, log, ctx) {
  if (!cfg.recallFilterEnabled) return data;
  if (!cfg.recallFilterBaseUrl || !cfg.recallFilterModel) {
    log.warn?.("[memos-cloud] recall filter enabled but missing recallFilterBaseUrl/recallFilterModel; skip filter");
    return data;
  }
  const lists = buildRecallCandidates(data, cfg);
  const hasCandidates =
    lists.candidatePayload.memory.length > 0 ||
    lists.candidatePayload.preference.length > 0 ||
    lists.candidatePayload.tool_memory.length > 0;
  if (!hasCandidates) return data;

  try {
    reportRumEvent("recall_filter", { recall_filter_enable: cfg.recallFilterEnabled }, cfg, ctx, log);
    const decision = await callRecallFilterModel(cfg, userPrompt, lists.candidatePayload);
    const filtered = applyRecallDecision(data, decision, lists);
    log.info?.(
      `[memos-cloud] recall filter applied: memory ${lists.memoryList.length}->${filtered.memory_detail_list?.length ?? 0}, ` +
        `preference ${lists.preferenceList.length}->${filtered.preference_detail_list?.length ?? 0}, ` +
        `tool_memory ${lists.toolList.length}->${filtered.tool_memory_detail_list?.length ?? 0}`,
    );
    return filtered;
  } catch (err) {
    log.warn?.(`[memos-cloud] recall filter failed: ${String(err)}`);
    return cfg.recallFilterFailOpen ? data : { ...data, memory_detail_list: [], preference_detail_list: [], tool_memory_detail_list: [] };
  }
}

export default {
  id: "memos-cloud-openclaw-plugin",
  name: "MemOS Cloud OpenClaw Plugin",
  description: "MemOS Cloud recall + add memory via lifecycle hooks",
  kind: "lifecycle",

  register(api) {
    const cfg = buildConfig(api.pluginConfig);
    const log = api.logger ?? console;
    let configUiStartupCancelled = false;

    // Start 12-hour background update interval
    startUpdateChecker(log);

    // Detect the host CLI version once so every hook registration branch can reference it.
    const hostVersion = detectHostVersion();

    // Side effects below are only meaningful when the host CLI was actually
    // launched to run the gateway (`openclaw gateway run|start|restart`).
    // Other entry points (e.g. `plugins install`, `security audit`) also
    // load this plugin to inspect/register it, but:
    //   - `ensurePluginHookPolicy` writes to `openclaw.json` and would race
    //     against the install command's own commit (ConfigMutationConflictError).
    //   - `waitForGatewayReady` would keep the short-lived event loop alive
    //     for 45s probing a gateway that will never come up, then emit a
    //     misleading "probe timed out" warning before the process exits.
    // Gate them all in one place so the policy is explicit and discoverable.
    if (isGatewayRuntimeStartup()) {
      // `allowConversationAccess` hook policy was introduced in 2026.4.23;
      // older hosts do not understand the field and don't need it patched in.
      const HOOK_POLICY_MIN_VERSION = "2026.4.23";
      const needsHookPolicy =
        hostVersion === null ||
        compareVersionStrings(hostVersion, HOOK_POLICY_MIN_VERSION) >= 0;

      void (async () => {
        const ready = await waitForGatewayReady(api.config, log);
        if (!ready || configUiStartupCancelled) return;

        // Patch hook policy AFTER gateway is fully ready. Writing the config
        // file at this point triggers the gateway's built-in config-change
        // watcher which will auto-restart, making agent_end effective without
        // requiring the user to manually restart.
        if (needsHookPolicy) {
          try {
            const policyResult = ensurePluginHookPolicy(api.config, log);
            if (policyResult?.error) {
              log.warn?.(
                `[memos-cloud] hook policy check skipped due to error: ${String(policyResult.error?.message ?? policyResult.error)}`,
              );
            }
          } catch (error) {
            log.warn?.(
              `[memos-cloud] failed to ensure plugin hook policy: ${String(error?.message ?? error)}`,
            );
          }
        }

        await ensureConfigUiService(log);
      })().catch((error) => {
        log.warn?.(`[memos-cloud] config UI failed to start: ${String(error)}`);
      });
    }

    if (!cfg.envFileStatus?.found) {
      const searchPaths = cfg.envFileStatus?.searchPaths?.join(", ") ?? ENV_FILE_SEARCH_HINTS.join(", ");
      log.warn?.(`[memos-cloud] No .env found in ${searchPaths}; falling back to process env or plugin config.`);
    }

    if (cfg.multiAgentMode && cfg.allowedAgents?.length > 0) {
      log.info?.(`[memos-cloud] Multi-agent mode enabled. Allowed agents: [${cfg.allowedAgents.join(", ")}]`);
    }

    const overrideAgentIds = Object.keys(cfg._agentOverrides || {});
    if (overrideAgentIds.length > 0) {
      log.info?.(`[memos-cloud] Per-agent overrides configured for: [${overrideAgentIds.join(", ")}]`);
    }

    if (cfg.conversationSuffixMode === "counter" && cfg.resetOnNew) {
      if (api.config?.hooks?.internal?.enabled !== true) {
        log.warn?.("[memos-cloud] command:new hook requires hooks.internal.enabled = true");
      }
      api.registerHook(
        ["command:new"],
        (event) => {
          if (event?.type === "command" && event?.action === "new") {
            bumpConversationCounter(event.sessionKey);
          }
        },
        {
          name: "memos-cloud-conversation-new",
          description: "Increment MemOS conversation suffix on /new",
        },
      );
    }

    const runRecall = async (event, ctx) => {
      // Skip system events: heartbeat, /new, /reset, and other commands
      const prompt = event?.prompt || "";
      const isHeartbeat = isHeartbeatPrompt(prompt);
      const isSystemCommand = isSystemCommandPrompt(prompt);
      const isSystemPrompt = isOpenClawSystemPrompt(prompt);

      if (isHeartbeat || isSystemCommand || isSystemPrompt) {
        log.info?.(`[memos-cloud] recall skipped: system event detected (heartbeat=${isHeartbeat}, command=${isSystemCommand}, systemPrompt=${isSystemPrompt}, prompt="${prompt.substring(0, 50)}...")`);
        return;
      }

      if (!isAgentAllowed(cfg, ctx)) {
        log.info?.(`[memos-cloud] recall skipped: agent "${ctx?.agentId}" not in allowedAgents [${cfg.allowedAgents?.join(", ")}]`);
        return;
      }
      const agentCfg = resolveAgentConfig(cfg, ctx?.agentId);
      if (!agentCfg.recallEnabled) return;
      const userPrompt = stripOpenClawInjectedPrefix(event?.prompt || "");
      if (!userPrompt || userPrompt.length < 3) return;
      if (!agentCfg.apiKey) {
        warnMissingApiKey(log, "recall");
        return;
      }

      try {
        const payload = buildSearchPayload(agentCfg, userPrompt, ctx);
        reportRumEvent('search_memory', payload, agentCfg, ctx, log);
        const result = await searchMemory(agentCfg, payload);
        const resultData = extractResultData(result);
        if (!resultData) return;
        const filteredData = await maybeFilterRecallData(agentCfg, resultData, userPrompt, log, ctx);
        const hookResult = formatRecallHookResult({ data: filteredData }, {
          wrapTagBlocks: true,
          relativity: payload.relativity,
          maxItemChars: agentCfg.maxItemChars,
        });
        if (!hookResult.appendSystemContext && !hookResult.prependContext) return;

        return hookResult;
      } catch (err) {
        log.warn?.(`[memos-cloud] recall failed: ${String(err)}`);
      }
    };

    // Recall mutates prompt context only, so the phase-specific replacement for
    // legacy before_agent_start is before_prompt_build. Do not register both on
    // new hosts, otherwise the same memory block can be injected twice.
    const PROMPT_BUILD_HOOK_MIN_VERSION = "2026.5.7";
    const usesBeforePromptBuild =
      hostVersion !== null &&
      compareVersionStrings(hostVersion, PROMPT_BUILD_HOOK_MIN_VERSION) >= 0;

    if (usesBeforePromptBuild) {
      api.on("before_prompt_build", runRecall);
    } else {
      api.on("before_agent_start", runRecall);
    }

    api.on("agent_end", async (event, ctx) => {
      // Skip system events: heartbeat and commands
      // Check the last user message to determine if this was a system event
      const messages = event?.messages || [];
      const lastUserIndex = messages.findLastIndex((message) => message?.role === "user");
      const lastUserMsg = messages[lastUserIndex];
      const lastUserContent = extractText(lastUserMsg?.content || "");

      const isHeartbeat = isHeartbeatPrompt(lastUserContent);
      const isSystemCommand = isSystemCommandPrompt(lastUserContent);
      const isSystemPrompt = isOpenClawSystemPrompt(lastUserContent);

      if (isHeartbeat || isSystemCommand || isSystemPrompt) {
        log.info?.(`[memos-cloud] add skipped: system event detected (heartbeat=${isHeartbeat}, command=${isSystemCommand}, systemPrompt=${isSystemPrompt}, content="${lastUserContent.substring(0, 50)}...")`);
        return;
      }

      if (!isAgentAllowed(cfg, ctx)) {
        log.info?.(`[memos-cloud] add skipped: agent "${ctx?.agentId}" not in allowedAgents [${cfg.allowedAgents?.join(", ")}]`);
        return;
      }
      const agentCfg = resolveAgentConfig(cfg, ctx?.agentId);
      if (!agentCfg.addEnabled) return;
      if (!event?.success || !event?.messages?.length) return;
      if (!agentCfg.apiKey) {
        warnMissingApiKey(log, "add");
        return;
      }

      const now = Date.now();
      if (agentCfg.throttleMs && now - lastCaptureTime < agentCfg.throttleMs) {
        return;
      }

      try {
        const rawCaptureMessages =
          agentCfg.captureStrategy === "full_session"
            ? event.messages
            : event.messages.slice(lastUserIndex);
        const messages =
          agentCfg.captureStrategy === "full_session"
            ? pickFullSessionMessages(event.messages, agentCfg)
            : pickLastTurnMessages(event.messages, agentCfg);

        if (!messages.length) return;

        const payload = buildAddMessagePayload(agentCfg, messages, ctx);
        const captureReservation = reserveCapture(
          payload,
          rawCaptureMessages,
          ctx,
          event.runId ?? ctx?.runId,
        );
        if (captureReservation?.duplicate) {
          log.info?.("[memos-cloud] add skipped: duplicate agent_end snapshot");
          return;
        }
        lastCaptureTime = now;
        await addMessage(agentCfg, payload);
      } catch (err) {
        log.warn?.(`[memos-cloud] add failed: ${String(err)}`);
      }
    });

    return () => {
      configUiStartupCancelled = true;
      void closeConfigUiService();
    };
  },
};
