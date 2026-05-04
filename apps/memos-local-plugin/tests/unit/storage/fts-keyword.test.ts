/**
 * Tests for the FTS5 trigram + LIKE pattern keyword channels.
 *
 * Coverage targets:
 *   - traces / skills / world_model all gain `searchByText` + `searchByPattern`
 *   - English queries hit via FTS
 *   - 2-char CJK queries miss FTS but hit via pattern
 *   - 3+ char CJK queries hit via FTS
 *   - INSERT / UPDATE / DELETE on the base table flows through to FTS
 *     via the migration triggers
 */
import { describe, expect, it } from "vitest";

import { makeTmpDb } from "../../helpers/tmp-db.js";

function vec(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

describe("storage/keyword channels — traces", () => {
  function seedTrace(
    repos: ReturnType<typeof makeTmpDb>["repos"],
    opts: {
      id: string;
      userText: string;
      agentText?: string;
      summary?: string;
      tags?: string[];
    },
  ): void {
    // Use the trace id to disambiguate session+episode so multiple
    // calls in the same test don't collide on the (unique) episode id.
    const sid = `s_${opts.id}`;
    const eid = `e_${opts.id}`;
    repos.sessions.upsert({
      id: sid,
      agent: "openclaw",
      startedAt: 0,
      lastSeenAt: 0,
      meta: {},
    });
    repos.episodes.insert({
      id: eid,
      sessionId: sid,
      startedAt: 0,
      endedAt: null,
      traceIds: [],
      rTask: null,
      status: "open",
    });
    repos.traces.insert({
      id: opts.id as never,
      episodeId: eid as never,
      sessionId: sid as never,
      ts: Date.now() as never,
      userText: opts.userText,
      agentText: opts.agentText ?? "",
      toolCalls: [],
      summary: opts.summary ?? null,
      reflection: null,
      value: 0.5 as never,
      alpha: 0 as never,
      rHuman: null,
      priority: 0.5 as never,
      tags: opts.tags ?? [],
      vecSummary: vec([1, 0, 0]),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });
  }

  it("FTS hit on English query", () => {
    const handle = makeTmpDb();
    try {
      seedTrace(handle.repos, {
        id: "t_docker",
        userText: "How do I deploy nginx with docker compose?",
      });
      seedTrace(handle.repos, {
        id: "t_python",
        userText: "Write a python pytest test for the JWT module",
      });
      const hits = handle.repos.traces.searchByText('"docker"', 10);
      expect(hits.map((h) => h.id)).toContain("t_docker");
      expect(hits.map((h) => h.id)).not.toContain("t_python");
    } finally {
      handle.cleanup();
    }
  });

  it("FTS hit on 3+ char CJK query", () => {
    const handle = makeTmpDb();
    try {
      seedTrace(handle.repos, {
        id: "t_zh",
        userText: "帮我部署docker容器服务到生产环境",
      });
      seedTrace(handle.repos, {
        id: "t_unrelated",
        userText: "今天天气不错",
      });
      const hits = handle.repos.traces.searchByText('"帮我部"', 10);
      expect(hits.map((h) => h.id)).toContain("t_zh");
      expect(hits.map((h) => h.id)).not.toContain("t_unrelated");
    } finally {
      handle.cleanup();
    }
  });

  it("pattern hit on 2-char CJK query (FTS misses these)", () => {
    const handle = makeTmpDb();
    try {
      seedTrace(handle.repos, {
        id: "t_short",
        userText: "我之前提到过唐波是产品经理",
      });
      seedTrace(handle.repos, {
        id: "t_other",
        userText: "另一个完全无关的对话",
      });
      // 2-char trigram FTS misses
      expect(handle.repos.traces.searchByText('"唐波"', 10)).toEqual([]);
      // pattern recovers it
      const hits = handle.repos.traces.searchByPattern(["唐波"], 10);
      expect(hits.map((h) => h.id)).toContain("t_short");
      expect(hits.map((h) => h.id)).not.toContain("t_other");
    } finally {
      handle.cleanup();
    }
  });

  it("trigger keeps FTS in sync on INSERT / UPDATE / DELETE", () => {
    const handle = makeTmpDb();
    try {
      seedTrace(handle.repos, {
        id: "t_orig",
        userText: "Lorem ipsum about postgres replication",
      });
      // INSERT flow → FTS hit
      expect(
        handle.repos.traces.searchByText('"postgres"', 10).map((h) => h.id),
      ).toContain("t_orig");

      // UPDATE the row's user_text → FTS should now match the new text
      // and miss the old one. The capture pipeline rewrites the row via
      // `updateBody`; we exercise the same path here.
      handle.repos.traces.updateBody("t_orig" as never, {
        userText: "Now talking about kubernetes only",
      });
      expect(
        handle.repos.traces.searchByText('"postgres"', 10).map((h) => h.id),
      ).not.toContain("t_orig");
      expect(
        handle.repos.traces.searchByText('"kubernetes"', 10).map((h) => h.id),
      ).toContain("t_orig");

      // DELETE → no hit at all
      handle.repos.traces.deleteById("t_orig" as never);
      expect(
        handle.repos.traces.searchByText('"kubernetes"', 10).map((h) => h.id),
      ).toEqual([]);
    } finally {
      handle.cleanup();
    }
  });
});

describe("storage/keyword channels — skills", () => {
  function seedSkill(repos: ReturnType<typeof makeTmpDb>["repos"], opts: {
    id: string;
    name: string;
    invocationGuide: string;
    status?: "active" | "candidate" | "archived";
  }): void {
    repos.skills.upsert({
      id: opts.id as never,
      name: opts.name,
      status: opts.status ?? "active",
      invocationGuide: opts.invocationGuide,
      procedureJson: null,
      eta: 0.8,
      support: 1,
      gain: 0.2,
      trialsAttempted: 1,
      trialsPassed: 1,
      sourcePolicyIds: [],
      sourceWorldModelIds: [],
      evidenceAnchors: [],
      vec: vec([1, 0, 0]),
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    });
  }

  it("FTS matches skill name + invocation guide", () => {
    const handle = makeTmpDb();
    try {
      seedSkill(handle.repos, {
        id: "sk_docker",
        name: "Docker syslib install fix",
        invocationGuide: "When pip install fails in Alpine, add libxml2-dev",
      });
      seedSkill(handle.repos, {
        id: "sk_jwt",
        name: "Validate JWT signature",
        invocationGuide: "Use PyJWT with HS256",
      });
      const hits = handle.repos.skills.searchByText('"libxml"', 10);
      expect(hits.map((h) => h.id)).toContain("sk_docker");
      expect(hits.map((h) => h.id)).not.toContain("sk_jwt");
    } finally {
      handle.cleanup();
    }
  });

  it("status filter is honoured in FTS path", () => {
    const handle = makeTmpDb();
    try {
      seedSkill(handle.repos, {
        id: "sk_active",
        name: "active fix",
        invocationGuide: "kubernetes pod restart",
        status: "active",
      });
      seedSkill(handle.repos, {
        id: "sk_archived",
        name: "stale fix",
        invocationGuide: "kubernetes pod restart",
        status: "archived",
      });
      const hits = handle.repos.skills.searchByText('"kubernetes"', 10, {
        statusIn: ["active", "candidate"],
      });
      const ids = hits.map((h) => h.id);
      expect(ids).toContain("sk_active");
      expect(ids).not.toContain("sk_archived");
    } finally {
      handle.cleanup();
    }
  });

  it("pattern recovers 2-char CJK names", () => {
    const handle = makeTmpDb();
    try {
      seedSkill(handle.repos, {
        id: "sk_zh",
        name: "唐波 偏好整理",
        invocationGuide: "记得用唐波偏好的命名风格",
      });
      seedSkill(handle.repos, {
        id: "sk_other",
        name: "其他 skill",
        invocationGuide: "无关",
      });
      // 2-char CJK → FTS empty
      expect(handle.repos.skills.searchByText('"唐波"', 10)).toEqual([]);
      // pattern hits
      const hits = handle.repos.skills.searchByPattern(["唐波"], 10);
      expect(hits.map((h) => h.id)).toContain("sk_zh");
    } finally {
      handle.cleanup();
    }
  });
});

describe("storage/keyword channels — world model", () => {
  function seedWorld(repos: ReturnType<typeof makeTmpDb>["repos"], opts: {
    id: string;
    title: string;
    body: string;
  }): void {
    repos.worldModel.upsert({
      id: opts.id as never,
      title: opts.title,
      body: opts.body,
      structure: { environment: [], inference: [], constraints: [] },
      domainTags: [],
      confidence: 0.9,
      policyIds: [],
      sourceEpisodeIds: [],
      inducedBy: "",
      vec: vec([1, 0, 0]),
      createdAt: 0,
      updatedAt: 0,
      version: 1,
      status: "active",
    });
  }

  it("FTS hit on title + body", () => {
    const handle = makeTmpDb();
    try {
      seedWorld(handle.repos, {
        id: "wm_docker",
        title: "Docker compose",
        body: "Containers communicate via the compose-defined network",
      });
      seedWorld(handle.repos, {
        id: "wm_react",
        title: "React project layout",
        body: "Components live in src/components/",
      });
      const hits = handle.repos.worldModel.searchByText('"docker"', 10);
      expect(hits.map((h) => h.id)).toContain("wm_docker");
      expect(hits.map((h) => h.id)).not.toContain("wm_react");
    } finally {
      handle.cleanup();
    }
  });

  it("pattern recovers 2-char CJK", () => {
    const handle = makeTmpDb();
    try {
      seedWorld(handle.repos, {
        id: "wm_zh",
        title: "项目 布局",
        body: "源码在 src/components/ 唐波 是产品经理",
      });
      const hits = handle.repos.worldModel.searchByPattern(["唐波"], 10);
      expect(hits.map((h) => h.id)).toContain("wm_zh");
    } finally {
      handle.cleanup();
    }
  });
});
