import type { EmbeddingConfig, ProviderLogger } from "../types.js";

/** Only model settings cross IPC: never forward API keys or the full runtime config. */
export type LocalProcessRequest =
  | {
      type: "embed";
      id: number;
      texts: string[];
      model: string;
      local?: EmbeddingConfig["local"];
    }
  | { type: "cancel"; id: number };
export type LocalProcessResponse =
  | { type: "result"; id: number; vectors: number[][] }
  | { type: "error"; id: number; message: string }
  | {
      type: "log";
      id: number;
      level: keyof ProviderLogger;
      message: string;
      data?: Record<string, unknown>;
    };
