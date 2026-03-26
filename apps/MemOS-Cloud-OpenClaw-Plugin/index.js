#!/usr/bin/env node
import {
  addMessage,
  buildConfig,
  extractResultData,
  extractText,
  formatRecallHookResult,
  USER_QUERY_MARKER,
  searchMemory,
} from "./lib/memos-cloud-api.js";
import { startUpdateChecker } from "./lib/check-update.js";
let lastCaptureTime = 0;
const conversationCounters = new Map();
const API_KEY_HELP_URL = "https://memos-dashboard.openmem.net/cn/apikeys/";
const ENV_FILE_SEARCH_HINTS = ["~/.openclaw/.env", "~/.moltbot/.env", "~/.clawdbot/.env"];
const MEMOS_SOURCE = "openclaw";

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

function stripPrependedPrompt(content) {
  if (!content) return content;
  const idx = content.lastIndexOf(USER_QUERY_MARKER);
  if (idx === -1) return content;
  return content.slice(idx + USER_QUERY_MARKER.length).trimStart();
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

function buildSearchPayload(cfg, prompt, ctx) {
  const queryRaw = `${cfg.queryPrefix || ""}${prompt}`;
  const query =
    Number.isFinite(cfg.maxQueryChars) && cfg.maxQueryChars > 0
      ? queryRaw.slice(0, cfg.maxQueryChars)
      : queryRaw;

  const payload = {
    user_id: cfg.userId,
    query,
    source: MEMOS_SOURCE,
  };

  if (!cfg.recallGlobal) {
    const conversationId = resolveConversationId(cfg, ctx);
    if (conversationId) payload.conversation_id = conversationId;
  }

  let filterObj = cfg.filter ? JSON.parse(JSON.stringify(cfg.filter)) : null;
  const agentId = getEffectiveAgentId(cfg, ctx);

  if (agentId) {
    if (filterObj) {
      if (Array.isArray(filterObj.and)) {
        filterObj.and.push({ agent_id: agentId });
      } else {
        filterObj = { and: [filterObj, { agent_id: agentId }] };
      }
    } else {
      filterObj = { agent_id: agentId };
    }
  }

  if (filterObj) payload.filter = filterObj;

  if (cfg.knowledgebaseIds?.length) payload.knowledgebase_ids = cfg.knowledgebaseIds;

  payload.memory_limit_number = cfg.memoryLimitNumber;
  payload.include_preference = cfg.includePreference;
  payload.preference_limit_number = cfg.preferenceLimitNumber;
  payload.include_tool_memory = cfg.includeToolMemory;
  payload.tool_memory_limit_number = cfg.toolMemoryLimitNumber;
  payload.relativity = cfg.relativity;

  return payload;
}

function buildAddMessagePayload(cfg, messages, ctx) {
  const payload = {
    user_id: cfg.userId,
    conversation_id: resolveConversationId(cfg, ctx),
    messages,
    source: MEMOS_SOURCE,
  };

  const agentId = getEffectiveAgentId(cfg, ctx);
  if (agentId) payload.agent_id = agentId;
  if (cfg.appId) payload.app_id = cfg.appId;
  if (cfg.tags?.length) payload.tags = cfg.tags;

  const info = {
    source: "openclaw",
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

function pickLastTurnMessages(messages, cfg) {
  const lastUserIndex = messages
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m?.role === "user")
    .map(({ idx }) => idx)
    .pop();

  if (lastUserIndex === undefined) return [];

  const slice = messages.slice(lastUserIndex);
  const results = [];

  for (const msg of slice) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = stripPrependedPrompt(extractText(msg.content));
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
      continue;
    }
    if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }

  return results;
}

function pickFullSessionMessages(messages, cfg) {
  const results = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = stripPrependedPrompt(extractText(msg.content));
      if (content) results.push({ role: "user", content: truncate(content, cfg.maxMessageChars) });
    }
    if (msg.role === "assistant" && cfg.includeAssistant) {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }
  return results;
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
  const retries = Number.isFinite(cfg.recallFilterRetries) ? Math.max(0, cfg.recallFilterRetries) : 0;
  const timeoutMs = Number.isFinite(cfg.recallFilterTimeoutMs) ? Math.max(1000, cfg.recallFilterTimeoutMs) : 6000;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${cfg.recallFilterBaseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
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
      lastError = err;
      if (attempt < retries) {
        await sleep(120 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

async function maybeFilterRecallData(cfg, data, userPrompt, log) {
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
    const decision = await callRecallFilterModel(cfg, userPrompt, lists.candidatePayload);
    return applyRecallDecision(data, decision, lists);
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

    // Start 12-hour background update interval
    startUpdateChecker(log);

    if (!cfg.envFileStatus?.found) {
      const searchPaths = cfg.envFileStatus?.searchPaths?.join(", ") ?? ENV_FILE_SEARCH_HINTS.join(", ");
      log.warn?.(`[memos-cloud] No .env found in ${searchPaths}; falling back to process env or plugin config.`);
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

    api.on("before_agent_start", async (event, ctx) => {
      if (!cfg.recallEnabled) return;
      if (!event?.prompt || event.prompt.length < 3) return;
      if (!cfg.apiKey) {
        warnMissingApiKey(log, "recall");
        return;
      }

      try {
        const payload = buildSearchPayload(cfg, event.prompt, ctx);
        const result = await searchMemory(cfg, payload);
        const resultData = extractResultData(result);
        if (!resultData) return;
        const filteredData = await maybeFilterRecallData(cfg, resultData, event.prompt, log);
        const hookResult = formatRecallHookResult({ data: filteredData }, {
          wrapTagBlocks: true,
          relativity: payload.relativity,
          maxItemChars: cfg.maxItemChars,
        });
        if (!hookResult.appendSystemContext && !hookResult.prependContext) return;

        return hookResult;
      } catch (err) {
        log.warn?.(`[memos-cloud] recall failed: ${String(err)}`);
      }
    });

    api.on("agent_end", async (event, ctx) => {
      if (!cfg.addEnabled) return;
      if (!event?.success || !event?.messages?.length) return;
      if (!cfg.apiKey) {
        warnMissingApiKey(log, "add");
        return;
      }

      const now = Date.now();
      if (cfg.throttleMs && now - lastCaptureTime < cfg.throttleMs) {
        return;
      }
      lastCaptureTime = now;

      try {
        const messages =
          cfg.captureStrategy === "full_session"
            ? pickFullSessionMessages(event.messages, cfg)
            : pickLastTurnMessages(event.messages, cfg);

        if (!messages.length) return;

        const payload = buildAddMessagePayload(cfg, messages, ctx);
        await addMessage(cfg, payload);
      } catch (err) {
        log.warn?.(`[memos-cloud] add failed: ${String(err)}`);
      }
    });
  },
};
