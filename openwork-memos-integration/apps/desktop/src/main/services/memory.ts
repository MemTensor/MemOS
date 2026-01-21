import type { TaskMessage } from '@accomplish/shared';
import { getMemoryUserId } from '../store/appSettings';
import { getApiKey } from '../store/secureStorage';

const DEFAULT_BASE_URL = 'https://memos.memtensor.cn/api/openmem/v1';
const DEFAULT_TOP_K = 5;
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_CONTEXT_LENGTH = 3000;
const DEFAULT_MAX_MESSAGE_COUNT = 8;
const DEFAULT_MAX_MESSAGE_LENGTH = 2000;

interface MemoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface MemoryConfig {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  apiKeyHeader: string;
  apiKeyScheme: string;
  searchPath: string;
  addPath: string;
  timeoutMs: number;
  topK: number;
  maxContextLength: number;
}

function getEnv(): Record<string, string | undefined> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env ?? {};
}

function resolveMemoryConfig(): MemoryConfig {
  const env = getEnv();
  const envBaseUrl = env.MEMOS_BASE_URL?.trim() || env.MEMOS_API_URL?.trim();
  const envApiKey = env.MEMOS_API_KEY?.trim();
  const storedKey = getApiKey('memos')?.trim();

  const baseUrl = envBaseUrl || DEFAULT_BASE_URL;
  const apiKey = envApiKey || storedKey || undefined;
  const apiKeyHeader = env.MEMOS_API_KEY_HEADER?.trim()
    || 'Authorization';
  const apiKeyScheme = env.MEMOS_API_KEY_SCHEME?.trim()
    || 'Token';
  const searchPath = env.MEMOS_SEARCH_PATH?.trim()
    || '/search/memory';
  const addPath = env.MEMOS_ADD_PATH?.trim()
    || '/add/message';
  const timeoutMs = Number(env.MEMOS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const topK = Number(env.MEMOS_TOP_K || DEFAULT_TOP_K);
  const maxContextLength = Number(env.MEMOS_MAX_CONTEXT_LENGTH || DEFAULT_MAX_CONTEXT_LENGTH);
  const enabled = Boolean(baseUrl && apiKey);

  return {
    enabled,
    baseUrl,
    apiKey,
    apiKeyHeader,
    apiKeyScheme,
    searchPath,
    addPath,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
    topK: Number.isFinite(topK) ? topK : DEFAULT_TOP_K,
    maxContextLength: Number.isFinite(maxContextLength) ? maxContextLength : DEFAULT_MAX_CONTEXT_LENGTH,
  };
}

function resolveMemoryUserId(): string {
  const env = getEnv();
  const fromEnv = env.MEMOS_USER_ID?.trim();
  return fromEnv || getMemoryUserId();
}

function buildUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function buildAuthHeaders(config: MemoryConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (!config.apiKey) return headers;

  const headerKey = config.apiKeyHeader;
  const headerValue = headerKey.toLowerCase() === 'authorization'
    ? `${config.apiKeyScheme} ${config.apiKey}`
    : config.apiKey;

  headers[headerKey] = headerValue;
  return headers;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractMemoryTexts(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];

  const root = payload as Record<string, unknown>;
  const data = (root.data && typeof root.data === 'object')
    ? (root.data as Record<string, unknown>)
    : root;
  const candidates =
    (Array.isArray(data.memory_detail_list) && data.memory_detail_list) ||
    (Array.isArray(data.text_mem) && data.text_mem) ||
    (Array.isArray(data.memories) && data.memories) ||
    (Array.isArray(data.data) && data.data) ||
    [];

  const preferenceCandidates =
    (Array.isArray(data.preference_detail_list) && data.preference_detail_list) || [];
  const toolCandidates =
    (Array.isArray(data.tool_memory_detail_list) && data.tool_memory_detail_list) || [];
  const preferenceNote = normalizeText(data.preference_note);

  const texts: string[] = [];
  for (const entry of candidates) {
    if (typeof entry === 'string') {
      const normalized = normalizeText(entry);
      if (normalized) texts.push(normalized);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const entryObj = entry as Record<string, unknown>;
      const memoryKey = normalizeText(entryObj.memory_key);
      const memoryValue =
        normalizeText(entryObj.memory_value) ||
        normalizeText(entryObj.text) ||
        normalizeText(entryObj.content) ||
        normalizeText(entryObj.memory);
      if (memoryValue && memoryKey) {
        texts.push(`${memoryKey}: ${memoryValue}`);
      } else if (memoryValue) {
        texts.push(memoryValue);
      }
    }
  }

  for (const entry of preferenceCandidates) {
    if (!entry || typeof entry !== 'object') continue;
    const entryObj = entry as Record<string, unknown>;
    const preference = normalizeText(entryObj.preference);
    const reasoning = normalizeText(entryObj.reasoning);
    if (preference && reasoning) {
      texts.push(`Preference: ${preference} (reason: ${reasoning})`);
    } else if (preference) {
      texts.push(`Preference: ${preference}`);
    }
  }

  for (const entry of toolCandidates) {
    if (!entry || typeof entry !== 'object') continue;
    const entryObj = entry as Record<string, unknown>;
    const toolValue = normalizeText(entryObj.tool_value);
    const experience = normalizeText(entryObj.experience);
    if (toolValue && experience) {
      texts.push(`Tool memory: ${toolValue} (experience: ${experience})`);
    } else if (toolValue) {
      texts.push(`Tool memory: ${toolValue}`);
    } else if (experience) {
      texts.push(`Tool experience: ${experience}`);
    }
  }

  if (preferenceNote) {
    texts.push(preferenceNote);
  }
  return texts;
}

function formatMemoryContext(entries: string[], maxLength: number): string | null {
  if (entries.length === 0) return null;

  const lines = [
    'Relevant memories (treat as factual context; use when the user asks):',
  ];
  for (const entry of entries) {
    lines.push(`- ${entry}`);
  }
  const combined = lines.join('\n');
  if (combined.length <= maxLength) return combined;

  return combined.slice(0, Math.max(0, maxLength - 3)) + '...';
}

function toMemoryMessages(messages: TaskMessage[], taskPrompt?: string, summary?: string): MemoryMessage[] {
  const filtered: MemoryMessage[] = messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .map((message): MemoryMessage => ({
      role: message.type === 'user' ? 'user' : 'assistant',
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);

  const recent = filtered.slice(-DEFAULT_MAX_MESSAGE_COUNT);
  const normalized: MemoryMessage[] = recent.map((message): MemoryMessage => ({
    role: message.role,
    content: message.content.slice(0, DEFAULT_MAX_MESSAGE_LENGTH),
  }));

  if (normalized.length === 0 && taskPrompt) {
    normalized.push({ role: 'user', content: taskPrompt.slice(0, DEFAULT_MAX_MESSAGE_LENGTH) });
  }

  if (summary) {
    normalized.push({
      role: 'assistant',
      content: `Summary: ${summary.slice(0, DEFAULT_MAX_MESSAGE_LENGTH)}`,
    });
  }

  return normalized;
}

export async function getMemoryContextForPrompt(
  prompt: string,
  conversationId?: string
): Promise<string | null> {
  const config = resolveMemoryConfig();
  if (!config.enabled || !config.baseUrl) return null;

  const payload = {
    user_id: resolveMemoryUserId(),
    query: prompt,
    top_k: config.topK,
    conversation_id: conversationId,
  };

  try {
    const response = await fetchWithTimeout(
      buildUrl(config.baseUrl, config.searchPath),
      {
        method: 'POST',
        headers: buildAuthHeaders(config),
        body: JSON.stringify(payload),
      },
      config.timeoutMs
    );

    if (!response.ok) {
      console.warn('[Memory] Search failed:', response.status, response.statusText);
      return null;
    }

    const data = await response.json().catch(() => null);
    const entries = extractMemoryTexts(data);
    return formatMemoryContext(entries.slice(0, config.topK), config.maxContextLength);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[Memory] Search timed out');
      return null;
    }
    console.warn('[Memory] Search failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function rememberTask(task: {
  id: string;
  prompt: string;
  messages?: TaskMessage[];
  summary?: string;
  status?: string;
  createdAt?: string;
  completedAt?: string;
}): Promise<void> {
  const config = resolveMemoryConfig();
  if (!config.enabled || !config.baseUrl) return;

  const messages = toMemoryMessages(task.messages ?? [], task.prompt, task.summary);
  if (messages.length === 0) return;

  const payload = {
    user_id: resolveMemoryUserId(),
    conversation_id: task.id,
    messages,
    metadata: {
      taskId: task.id,
      status: task.status,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    },
  };

  try {
    const response = await fetchWithTimeout(
      buildUrl(config.baseUrl, config.addPath),
      {
        method: 'POST',
        headers: buildAuthHeaders(config),
        body: JSON.stringify(payload),
      },
      config.timeoutMs
    );

    if (!response.ok) {
      console.warn('[Memory] Add failed:', response.status, response.statusText);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[Memory] Add timed out');
      return;
    }
    console.warn('[Memory] Add failed:', error instanceof Error ? error.message : String(error));
  }
}
