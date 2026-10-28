import type {
  HostLlmBridge,
  HostLlmCompletion,
} from "../core/llm/host-bridge.js";
import type { StdioServerHandle } from "./stdio.js";

type ServerRequestTransport = Pick<StdioServerHandle, "serverRequest">;

export function createStdioHostLlmBridge(
  id: string,
  getTransport: () => ServerRequestTransport | null,
): HostLlmBridge {
  return {
    id,
    async complete(input) {
      const transport = getTransport();
      if (!transport) {
        throw new Error("host LLM bridge invoked before stdio server was ready");
      }

      const configuredTimeoutMs = input.timeoutMs ?? 60_000;
      const remainingDeadlineMs =
        input.deadlineAt === undefined
          ? configuredTimeoutMs
          : input.deadlineAt - Date.now();
      if (remainingDeadlineMs <= 0) {
        throw new Error("host LLM request deadline has passed");
      }
      const timeoutMs = Math.min(configuredTimeoutMs, remainingDeadlineMs);

      const result = await transport.serverRequest<Partial<HostLlmCompletion>>(
        "host.llm.complete",
        {
          messages: input.messages,
          model: input.model,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          timeoutMs,
        },
        { timeoutMs, signal: input.signal },
      );
      return {
        text: typeof result?.text === "string" ? result.text : "",
        model:
          typeof result?.model === "string"
            ? result.model
            : input.model ?? "",
        usage: result?.usage,
        durationMs:
          typeof result?.durationMs === "number" ? result.durationMs : 0,
      };
    },
  };
}
