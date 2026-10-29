/** Producer attribution accepted by both extensible V3 and native V4 sessions. */
export interface MemOSMessageSource {
  kind: "plugin:memos-local-memory";
  plugin: "memos-local-memory";
  form?: "recall";
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "plugin:memos-local-memory": MemOSMessageSource;
  }
}

export function memosMessageSource(form?: "recall"): MemOSMessageSource {
  return {
    kind: "plugin:memos-local-memory",
    plugin: "memos-local-memory",
    ...(form ? { form } : {}),
  };
}
