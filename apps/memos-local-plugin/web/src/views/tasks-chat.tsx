/**
 * Conversation log renderer for the Tasks drawer.
 *
 * Reads a flattened `ChatMsg[]` (built by `tasks-chat-data::flattenChat`)
 * and emits Cursor-style bubbles:
 *
 *     user query   →  tool calls (chronological)
 *                   →  reflection (model "thinking")
 *                   →  assistant reply
 *
 * Tool calls are folded inside collapsible `<details>` blocks so the
 * conversation stays scannable even on long episodes; clicking opens
 * the raw input / output. Reflection bubbles use a distinct purple
 * gradient + italic styling so they're visually separable from the
 * normal assistant turn.
 *
 * The pure data layer lives in `tasks-chat-data.ts`; that file ships
 * the `flattenChat` function tested in
 * `tests/unit/web/tasks-chat.test.ts` (no Preact dependency).
 */
import { Icon } from "../components/Icon";
import { t } from "../stores/i18n";
import type { ChatMsg, ChatRole } from "./tasks-chat-data";

export {
  flattenChat,
  type ChatMsg,
  type ChatRole,
  type TimelineToolCall,
  type TimelineTrace,
} from "./tasks-chat-data";

// ─── ChatLog / ChatBubble Preact components ──────────────────────────────

export function ChatLog({ messages }: { messages: readonly ChatMsg[] }) {
  if (messages.length === 0) return null;
  return (
    <div class="chat-log">
      {messages.map((msg) => (
        <ChatBubble key={msg.key} msg={msg} />
      ))}
    </div>
  );
}

function avatarFor(role: ChatRole): string {
  switch (role) {
    case "user":
      return "U";
    case "assistant":
      return "A";
    case "tool":
      return "T";
    case "thinking":
      return "R";
  }
}

export function ChatBubble({ msg }: { msg: ChatMsg }) {
  const time = formatTime(msg.ts);

  return (
    <div class={`chat-item chat-item--${msg.role}`}>
      <div class="chat-item__avatar" aria-hidden="true">
        {avatarFor(msg.role)}
      </div>
      <div class="chat-item__body">
        <div class="chat-item__meta">
          <span class="chat-item__role">{roleLabel(msg)}</span>
          <span class="chat-item__time">{time}</span>
          {msg.role === "tool" && msg.toolDurationMs != null && (
            <span class="chat-item__time mono">{msg.toolDurationMs}ms</span>
          )}
          {msg.role === "tool" && msg.errorCode && (
            <span class="pill pill--failed">{msg.errorCode}</span>
          )}
        </div>
        {msg.role === "tool" ? (
          <ToolBubble msg={msg} />
        ) : msg.role === "thinking" ? (
          <div class="chat-item__bubble chat-item__bubble--thinking">
            {msg.text}
          </div>
        ) : (
          <div class="chat-item__bubble">{msg.text}</div>
        )}
      </div>
    </div>
  );
}

function ToolBubble({ msg }: { msg: ChatMsg }) {
  const errored = !!msg.errorCode;
  const klass =
    "chat-item__bubble chat-item__bubble--tool" +
    (errored ? " chat-item__bubble--error" : "");
  return (
    <div class={klass}>
      <div class="chat-item__tool-header">
        <Icon name="cable" size={14} />
        <span class="chat-item__tool-name mono">{msg.toolName}</span>
        {!errored && <span class="pill pill--active">{t("tasks.chat.tool.ok")}</span>}
      </div>
      {msg.toolInput && (
        <details class="chat-item__tool-section">
          <summary class="chat-item__tool-summary">
            <Icon name="chevron-right" size={12} />
            <span class="chat-item__tool-label">
              {t("tasks.chat.tool.input")}
            </span>
          </summary>
          <pre class="chat-item__tool-pre">{msg.toolInput}</pre>
        </details>
      )}
      {msg.toolOutput && (
        <details class="chat-item__tool-section" open={errored}>
          <summary class="chat-item__tool-summary">
            <Icon name="chevron-right" size={12} />
            <span class="chat-item__tool-label">
              {t("tasks.chat.tool.output")}
            </span>
          </summary>
          <pre class="chat-item__tool-pre">{msg.toolOutput}</pre>
        </details>
      )}
      {!msg.toolInput && !msg.toolOutput && !errored && (
        <div class="chat-item__tool-empty">
          {t("tasks.chat.tool.noPayload")}
        </div>
      )}
    </div>
  );
}

function roleLabel(msg: ChatMsg): string {
  if (msg.role === "tool" && msg.toolName) {
    return `${t("tasks.chat.role.tool" as "tasks.chat.role.user")} · ${msg.toolName}`;
  }
  return t(`tasks.chat.role.${msg.role}` as "tasks.chat.role.user");
}

function formatTime(ts: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return String(ts);
  }
}
