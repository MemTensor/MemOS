import { describe, expect, it } from "vitest";

import { CORE_EVENTS, isCoreEventType } from "../../../agent-contract/events.js";
import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import type {
  InjectionPacket,
  RepairCtx,
  RetrievalReason,
  ToolDrivenCtx,
  TurnStartCtx,
} from "../../../agent-contract/dto.js";
import { RPC_METHODS, isRpcMethodName, rpcCodeForError } from "../../../agent-contract/jsonrpc.js";
import { LOG_LEVELS } from "../../../agent-contract/log-record.js";

describe("agent-contract", () => {
  it("CORE_EVENTS has no duplicates and only lowercase-dot-format", () => {
    expect(new Set(CORE_EVENTS).size).toBe(CORE_EVENTS.length);
    for (const e of CORE_EVENTS) {
      expect(e).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it("isCoreEventType narrows correctly", () => {
    expect(isCoreEventType("trace.created")).toBe(true);
    expect(isCoreEventType("not.an.event")).toBe(false);
  });

  it("RPC_METHODS values are unique and isRpcMethodName works", () => {
    const values = Object.values(RPC_METHODS);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(isRpcMethodName(v)).toBe(true);
    expect(isRpcMethodName("nope")).toBe(false);
  });

  it("rpcCodeForError maps stable codes", () => {
    expect(rpcCodeForError(ERROR_CODES.INVALID_ARGUMENT)).toBe(-32602);
    expect(rpcCodeForError(ERROR_CODES.UNKNOWN_METHOD)).toBe(-32601);
    expect(rpcCodeForError(ERROR_CODES.LLM_UNAVAILABLE)).toBe(-32000);
    expect(rpcCodeForError(undefined)).toBe(-32603);
  });

  it("MemosError serializes to the stable wire shape", () => {
    const e = new MemosError(ERROR_CODES.CONFIG_INVALID, "bad", { path: "viewer.port" });
    const j = e.toJSON();
    expect(j).toEqual({
      name: "MemosError",
      code: "config_invalid",
      message: "bad",
      details: { path: "viewer.port" },
    });
    expect(MemosError.is(e)).toBe(true);
    expect(MemosError.is(j)).toBe(true);
    expect(MemosError.is(new Error("plain"))).toBe(false);
  });

  it("LOG_LEVELS lists exactly the six canonical levels", () => {
    expect(LOG_LEVELS).toEqual(["trace", "debug", "info", "warn", "error", "fatal"]);
  });

  it("retrieval trigger DTOs have the documented shape", () => {
    // Compile-time check (as type assertions). Runtime sanity: construct one
    // of each and make sure TS accepts the intended fields.
    const ts = 0;
    const turnStart: TurnStartCtx = {
      agent: "openclaw",
      sessionId: "s1",
      userText: "hi",
      ts,
    };
    const toolDriven: ToolDrivenCtx = {
      agent: "openclaw",
      sessionId: "s1",
      tool: "memory_search",
      args: { q: "x" },
      ts,
    };
    const repair: RepairCtx = {
      agent: "openclaw",
      sessionId: "s1",
      failingTool: "shell",
      failureCount: 3,
      ts,
    };
    const reasons: RetrievalReason[] = [
      "turn_start",
      "tool_driven",
      "skill_invoke",
      "sub_agent",
      "decision_repair",
    ];
    const packet: InjectionPacket = {
      reason: "turn_start",
      snippets: [],
      rendered: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      packetId: "pkt_1",
      ts,
      sessionId: "sess_1",
      episodeId: "ep_1",
    };

    expect(turnStart.userText).toBe("hi");
    expect(toolDriven.tool).toBe("memory_search");
    expect(repair.failureCount).toBe(3);
    expect(reasons.length).toBe(5);
    expect(packet.packetId).toBe("pkt_1");
  });
});
