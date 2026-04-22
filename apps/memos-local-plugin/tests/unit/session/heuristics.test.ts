import { describe, expect, it } from "vitest";

import {
  HEURISTIC_RULES,
  matchFirst,
  retrievalFor,
} from "../../../core/session/heuristics.js";

describe("session/heuristics", () => {
  it("every rule has a unique id", () => {
    const ids = HEURISTIC_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ["/memos status", "meta"],
    ["/memory export", "meta"],
    ["/MEMOS help", "meta"],
  ])("matches meta command: %s", (input, kind) => {
    const m = matchFirst(input);
    expect(m?.kind).toBe(kind);
    expect(m?.rule.id).toBe("meta.command_prefix");
  });

  it.each([
    ["thanks", "chitchat"],
    ["ok", "chitchat"],
    ["hi!", "chitchat"],
    ["你好", "chitchat"],
    ["谢谢", "chitchat"],
    ["收到", "chitchat"],
  ])("matches chitchat: %s", (input, kind) => {
    expect(matchFirst(input)?.kind).toBe(kind);
  });

  it.each([
    ["what did we discuss last time?", "memory_probe"],
    ["do you remember that fix?", "memory_probe"],
    ["我们之前聊过这个API吗", "memory_probe"],
    ["你还记得上次那个bug吗", "memory_probe"],
    ["回忆一下我们的讨论", "memory_probe"],
  ])("matches memory probe: %s", (input, kind) => {
    expect(matchFirst(input)?.kind).toBe(kind);
  });

  it.each([
    ["please write a function that sorts", "task"],
    ["fix the failing test", "task"],
    ["帮我写一个 python 脚本", "task"],
    ["请实现这个接口", "task"],
  ])("matches task imperative: %s", (input, kind) => {
    expect(matchFirst(input)?.kind).toBe(kind);
  });

  it("long free-form text lands as task via length rule", () => {
    const words = "analyze the complexity of this function and suggest refactors considering performance memory and readability across a variety of inputs we care about including unicode and boundary conditions".split(
      " ",
    );
    expect(words.length).toBeGreaterThan(25);
    const m = matchFirst(words.join(" "));
    expect(m?.kind).toBe("task");
  });

  it("empty or whitespace → null", () => {
    expect(matchFirst("")).toBeNull();
    expect(matchFirst("   \n  ")).toBeNull();
  });

  it("short ambiguous question returns null (kicks LLM tiebreaker)", () => {
    // "what's up?" is a short greeting/question, heuristics shouldn't commit
    expect(matchFirst("whats up with that config?")).toBeNull();
  });

  it("meta wins over chitchat when both could apply", () => {
    // "/memos hello" should still be meta, not chitchat
    expect(matchFirst("/memos hello")?.kind).toBe("meta");
  });

  it.each([
    ["task", { tier1: true, tier2: true, tier3: true }],
    ["memory_probe", { tier1: true, tier2: true, tier3: false }],
    ["chitchat", { tier1: false, tier2: false, tier3: false }],
    ["meta", { tier1: false, tier2: false, tier3: false }],
    ["unknown", { tier1: true, tier2: true, tier3: true }],
  ] as const)("retrievalFor(%s)", (kind, expected) => {
    expect(retrievalFor(kind)).toEqual(expected);
  });
});
