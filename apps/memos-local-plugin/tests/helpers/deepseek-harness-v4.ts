import { releasedV4SessionFormatCodec } from "@deepseek-ai/dsh-session-format-v3-to-v4";

/** Use the same JSON boundary as durable DSH events, without a desktop install. */
export function dshV4Event(
  type: string,
  data: unknown,
): Parameters<typeof releasedV4SessionFormatCodec.encodeEvent>[0] {
  return JSON.parse(JSON.stringify({ type, seq: 1, time: 1, data }));
}
