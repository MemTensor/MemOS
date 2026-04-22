import { describe, expect, it } from "vitest";

import {
  extractPatternTerms,
  prepareFtsMatch,
  reciprocalRankScore,
} from "../../../core/storage/keyword.js";

describe("storage/keyword.prepareFtsMatch", () => {
  it("returns null for empty input", () => {
    expect(prepareFtsMatch("")).toBeNull();
    expect(prepareFtsMatch("    ")).toBeNull();
  });

  it("AND-joins ASCII tokens, dropping ones below the trigram window", () => {
    const out = prepareFtsMatch("docker compose up");
    expect(out).toBe('"docker" "compose"');
    // "up" (length 2) is below trigram width → dropped from FTS
    // (caller should also build patternTerms for it).
  });

  it("emits CJK runs as standalone tokens when ≥3 chars", () => {
    const out = prepareFtsMatch("帮我部署 docker 容器服务");
    // "帮我部署" (4 chars) and "容器服务" (4 chars) are both ≥3.
    // "docker" (6) survives. Order is set-stable.
    expect(out).toContain('"帮我部署"');
    expect(out).toContain('"容器服务"');
    expect(out).toContain('"docker"');
  });

  it("returns null when only short CJK remains (caller falls back to pattern)", () => {
    expect(prepareFtsMatch("唐波")).toBeNull(); // 2-char CJK only
  });

  it("escapes quotes inside tokens for FTS5 phrase syntax", () => {
    const out = prepareFtsMatch('check "quoted" word');
    // FTS5 phrase syntax doubles the inner quote.
    expect(out).toBe('"check" "quoted" "word"');
  });

  it("strips punctuation that would otherwise become part of a phrase", () => {
    const out = prepareFtsMatch("React, Vue (Vite) — modern build tools");
    // Each ≥3-char token survives; commas / parens / em-dash dropped.
    // FTS5 trigram tokenizer is case-insensitive at MATCH time, so we
    // preserve original case in the phrase tokens.
    expect(out).toContain('"React"');
    expect(out).toContain('"Vue"');
    expect(out).toContain('"Vite"');
    expect(out).toContain('"modern"');
    expect(out).toContain('"tools"');
  });
});

describe("storage/keyword.extractPatternTerms", () => {
  it("returns 2-char ASCII tokens (not 1-char, not ≥3)", () => {
    const out = extractPatternTerms("up   docker py be do");
    expect(out).toContain("up");
    expect(out).toContain("py");
    expect(out).toContain("be");
    expect(out).toContain("do");
    expect(out).not.toContain("docker");
  });

  it("emits CJK bigrams over each CJK run", () => {
    const out = extractPatternTerms("帮我部署");
    expect(out).toContain("帮我");
    expect(out).toContain("我部");
    expect(out).toContain("部署");
  });

  it("keeps 2-char CJK runs as a single bigram", () => {
    const out = extractPatternTerms("唐波 是 产品经理");
    expect(out).toContain("唐波");
    expect(out).toContain("产品");
    expect(out).toContain("品经");
    expect(out).toContain("经理");
  });

  it("dedupes overlapping bigrams across runs", () => {
    const out = extractPatternTerms("唐波 唐波");
    expect(out.filter((t) => t === "唐波")).toEqual(["唐波"]);
  });

  it("ignores punctuation between CJK chars (treats as separator)", () => {
    const out = extractPatternTerms("唐波，李雷");
    expect(out).toContain("唐波");
    expect(out).toContain("李雷");
    expect(out).not.toContain("波，");
  });
});

describe("storage/keyword.reciprocalRankScore", () => {
  it("monotone-decreasing in rank, with default k=60", () => {
    const a = reciprocalRankScore(0);
    const b = reciprocalRankScore(1);
    const c = reciprocalRankScore(10);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(a).toBeCloseTo(1 / 61);
  });
});
