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
import type { JSX } from "preact";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
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
  // Walk the messages once and emit either a standalone `<ChatBubble>`
  // or a `<ParallelBatchGroup>` wrapper around a contiguous run of
  // tool calls that share the same `parallelBatchKey` (set by
  // `assignParallelBatches` in the data layer). Solo tools and all
  // non-tool roles fall through to the unchanged single-bubble path.
  const items: JSX.Element[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (
      m.role === "tool" &&
      m.parallelBatchKey != null &&
      (m.parallelBatchSize ?? 0) >= 2
    ) {
      const groupKey = m.parallelBatchKey;
      const batch: ChatMsg[] = [];
      while (
        i < messages.length &&
        messages[i]!.parallelBatchKey === groupKey
      ) {
        batch.push(messages[i]!);
        i++;
      }
      i--; // for-loop will i++; we already advanced past the run
      items.push(
        <ParallelBatchGroup
          key={groupKey}
          tools={batch}
          totalMs={m.parallelBatchTotalMs ?? 0}
        />,
      );
      continue;
    }
    items.push(<ChatBubble key={m.key} msg={m} />);
  }
  return <div class="chat-log">{items}</div>;
}

/**
 * Wrap a contiguous run of parallel-batch tool calls in a single card
 * so users can tell at a glance that "these N tools ran concurrently"
 * — distinct from the visually identical "one tool finished, LLM
 * thought for a sec, called the next" sequential case.
 *
 * The header surfaces the wall-clock span of the batch (= max(endedAt)
 * − min(startedAt)). For typical multi-tool turns this is ~1/N of the
 * naïve sum, which makes the parallelism payoff legible.
 */
function ParallelBatchGroup({
  tools,
  totalMs,
}: {
  tools: readonly ChatMsg[];
  totalMs: number;
}) {
  const sumMs = tools.reduce((acc, t) => acc + (t.toolDurationMs ?? 0), 0);
  const headerLabel = t("tasks.chat.tool.parallelBatch", {
    n: tools.length,
    ms: totalMs,
  });
  const sequentialHint =
    sumMs > totalMs && totalMs > 0
      ? t("tasks.chat.tool.parallelBatch.savings", { sum: sumMs })
      : "";
  return (
    <div class="chat-item__tool-batch" role="group" aria-label={headerLabel}>
      <div class="chat-item__tool-batch-header">
        <Icon name="zap" size={14} />
        <span>{headerLabel}</span>
        {sequentialHint && (
          <span class="chat-item__tool-batch-hint muted">
            {sequentialHint}
          </span>
        )}
      </div>
      <div class="chat-item__tool-batch-body">
        {tools.map((m) => (
          <ChatBubble key={m.key} msg={m} />
        ))}
      </div>
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
            <Markdown text={msg.text} />
          </div>
        ) : (
          <div class="chat-item__bubble">
            <Markdown text={msg.text} />
          </div>
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
