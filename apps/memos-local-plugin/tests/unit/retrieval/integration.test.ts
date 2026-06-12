import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRetrievalEventBus,
  repairRetrieve,
  subAgentRetrieve,
  skillInvokeRetrieve,
  taskProtocolOnlyPacket,
  toolDrivenRetrieve,
  turnStartRetrieve,
  type RetrievalDeps,
  type RetrievalEmbedder,
} from "../../../core/retrieval/index.js";
import type {
  EmbeddingVector,
  EpisodeId,
  PolicyId,
  SessionId,
  SkillId,
  TraceId,
  WorldModelId,
} from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000;

function vec(arr: number[]): EmbeddingVector {
  return Float32Array.from(arr) as unknown as EmbeddingVector;
}

/** Fake embedder returns a constant query vector so we can assert determinism. */
const fakeEmbedder: RetrievalEmbedder = {
  embed: async () => vec([1, 0, 0]),
};

function seed(handle: TmpDbHandle) {
  handle.repos.sessions.upsert({
    id: "s1" as SessionId,
    agent: "openclaw",
    startedAt: NOW,
    lastSeenAt: NOW,
    meta: {},
  });
  handle.repos.episodes.upsert({
    id: "ep1" as EpisodeId,
    sessionId: "s1" as SessionId,
    startedAt: NOW as never,
    endedAt: null,
    traceIds: [],
    rTask: null,
    status: "open",
  });

  // Two traces on the query axis [1,0,0]; one off-axis.
  const insertTrace = (id: string, value: number, priority: number, v: number[], tags: string[]) => {
    handle.repos.traces.insert({
      id: id as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: NOW as never,
      userText: `user text ${id}`,
      agentText: `agent text ${id}`,
      toolCalls: [],
      reflection: `${id}-ref`,
      value: value as never,
      alpha: 0.5 as never,
      rHuman: null,
      priority: priority as never,
      tags,
      vecSummary: vec(v),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });
  };
  insertTrace("t_hi", 0.9, 0.9, [1, 0, 0], ["docker"]);
  insertTrace("t_med", 0.3, 0.3, [0.9, 0.1, 0], ["docker"]);
  insertTrace("t_off", 0.5, 0.5, [0, 1, 0], ["pip"]);

  handle.repos.skills.upsert({
    id: "sk_docker" as SkillId,
    name: "run-docker-compose",
    status: "active",
    invocationGuide: "docker compose up -d",
    procedureJson: null,
    eta: 0.85,
    support: 3,
    gain: 0.6,
    trialsAttempted: 5,
    trialsPassed: 4,
    sourcePolicyIds: [],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: vec([1, 0, 0]),
    createdAt: NOW as never,
    updatedAt: NOW as never,
    version: 1,
  });
  handle.repos.skills.upsert({
    id: "sk_weak" as SkillId,
    name: "weak-skill",
    status: "active",
    invocationGuide: "nope",
    procedureJson: null,
    eta: 0.1, // below minSkillEta
    support: 1,
    gain: 0,
    trialsAttempted: 1,
    trialsPassed: 0,
    sourcePolicyIds: [],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: vec([1, 0, 0]),
    createdAt: NOW as never,
    updatedAt: NOW as never,
    version: 1,
  });

  handle.repos.policies.insert({
    id: "po_sec13f_issuer" as PolicyId,
    title: "SEC 13F issuer CUSIP parsing guardrail",
    trigger: "Parse SEC 13F holdings and extract issuer/CUSIP fields",
    procedure: "Use holdings table columns directly; do not infer issuer from filenames.",
    verification: "Issuer and CUSIP values align with the holdings row fields.",
    boundary: "Only SEC 13F holdings extraction.",
    support: 1,
    gain: 0.7,
    status: "active",
    experienceType: "failure_avoidance",
    evidencePolarity: "negative",
    salience: 0.9,
    confidence: 0.85,
    skillEligible: false,
    sourceEpisodeIds: ["ep1" as EpisodeId],
    sourceFeedbackIds: ["fb_sec13f" as never],
    sourceTraceIds: ["t_hi" as TraceId],
    inducedBy: "unit",
    decisionGuidance: {
      preference: [],
      antiPattern: ["Do not infer SEC 13F issuer from filenames."],
    },
    vec: vec([1, 0, 0]),
    createdAt: NOW as never,
    updatedAt: NOW as never,
  });

  handle.repos.worldModel.upsert({
    id: "wm_docker" as WorldModelId,
    title: "docker-compose model",
    body: "containers talk via compose network",
    structure: { environment: [], inference: [], constraints: [] },
    domainTags: [],
    confidence: 0.9,
    policyIds: [],
    sourceEpisodeIds: [],
    inducedBy: "",
    vec: vec([1, 0, 0]),
    createdAt: NOW as never,
    updatedAt: NOW as never,
    version: 1,
    status: "active",
  });
}

function makeDeps(handle: TmpDbHandle): RetrievalDeps {
  return {
    repos: {
      skills: handle.repos.skills,
      traces: handle.repos.traces,
      worldModel: handle.repos.worldModel,
      policies: handle.repos.policies,
    },
    embedder: fakeEmbedder,
    config: {
      tier1TopK: 2,
      tier2TopK: 3,
      tier3TopK: 1,
      candidatePoolFactor: 4,
      weightCosine: 0.6,
      weightPriority: 0.4,
      mmrLambda: 0.7,
      includeLowValue: false,
      rrfConstant: 60,
      minSkillEta: 0.5,
      minTraceSim: 0.3,
      tagFilter: "auto",
      decayHalfLifeDays: 30,
      llmFilterEnabled: false,
      llmFilterMaxKeep: 4,
      llmFilterMinCandidates: 1,
    },
    now: () => NOW as never,
  };
}

describe("retrieval/integration", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb({ agent: "openclaw" });
    seed(handle);
  });
  afterEach(() => handle.cleanup());

  it("turn_start returns snippets across tiers + emits events", async () => {
    const bus = createRetrievalEventBus();
    const events: string[] = [];
    bus.on((e) => events.push(e.kind));

    const res = await turnStartRetrieve(
      makeDeps(handle),
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s1" as SessionId,
        userText: "run docker compose",
        ts: NOW as never,
      },
      { events: bus },
    );

    expect(res.packet.snippets.length).toBeGreaterThan(0);
    expect(res.stats.tier1Count).toBeGreaterThanOrEqual(1);
    expect(res.stats.tier2Count).toBeGreaterThanOrEqual(1);
    expect(res.stats.tier3Count).toBeGreaterThanOrEqual(1);
    expect(events).toEqual(["retrieval.started", "retrieval.done"]);

    // Expect the weak skill to be filtered out.
    const skillIds = res.packet.snippets
      .filter((s) => s.refKind === "skill")
      .map((s) => String(s.refId));
    expect(skillIds).toContain("sk_docker");
    expect(skillIds).not.toContain("sk_weak");
  });

  it("keeps abstract memories when long unique identifier queries require keywords", async () => {
    const res = await turnStartRetrieve(makeDeps(handle), {
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      userText: "zlxqyz_unique_marker_2026_test_no_such_content",
      ts: NOW as never,
    });

    const refKinds = res.packet.snippets.map((s) => s.refKind);
    expect(refKinds).toContain("skill");
    expect(refKinds).toContain("world-model");
    expect(refKinds).not.toContain("trace");
    expect(refKinds).not.toContain("episode");
  });

  it("recalls feedback experiences through keyword channels when embeddings degrade", async () => {
    const deps: RetrievalDeps = {
      ...makeDeps(handle),
      embedder: {
        embed: async () => {
          throw new Error("embedding down");
        },
      },
    };

    const res = await turnStartRetrieve(deps, {
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      userText: "SEC 13F issuer CUSIP parsing",
      ts: NOW as never,
    });

    const experience = res.packet.snippets.find(
      (s) => s.refKind === "experience",
    );
    expect(experience?.refId).toBe("po_sec13f_issuer");
    expect(experience?.title).toContain("SEC 13F issuer CUSIP");
    expect(experience?.body).toContain("Use holdings table columns directly");
    expect(experience?.body).not.toContain("confidence=");
    expect(experience?.body).not.toContain("evidence=");
    expect(res.packet.rendered).toContain("## Experiences");
    expect(res.packet.rendered).not.toContain("## Memories\n\n\n1. SEC 13F issuer");
    expect(res.stats.embedding).toMatchObject({
      attempted: true,
      ok: false,
      degraded: true,
    });
  });

  it("tool_driven skips tier1 (no skill snippets)", async () => {
    const res = await toolDrivenRetrieve(makeDeps(handle), {
      reason: "tool_driven",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      tool: "memos_search",
      args: { query: "docker compose" },
      ts: NOW as never,
    });
    expect(res.stats.tier1Count).toBe(0);
    expect(res.packet.snippets.every((s) => s.refKind !== "skill")).toBe(true);
  });

  it("lightweight mode only returns trace memories after summarizer filter succeeds", async () => {
    let filterCalls = 0;
    const llm: any = {
      completeJson: async (_messages: unknown, opts: { op?: string }) => {
        if (opts.op?.includes("retrieval.query.extract")) {
          return {
            value: { queryVecText: "run docker compose", keywords: ["docker", "compose"] },
            servedBy: "fake",
          };
        }
        filterCalls++;
        expect(opts.op).toContain("retrieval.filter");
        return {
          value: { selected: [1], sufficient: true },
          servedBy: "fake",
        };
      },
    };
    const res = await turnStartRetrieve(
      {
        ...makeDeps(handle),
        llm,
        config: {
          ...makeDeps(handle).config,
          lightweightMemory: true,
          llmFilterEnabled: true,
          llmFilterMinCandidates: 1,
        },
      },
      {
        reason: "turn_start",
        agent: "openclaw",
        // Cross-session: seeded traces live in `s1`, not the active turn session.
        sessionId: "s_current" as SessionId,
        userText: "run docker compose",
        ts: NOW as never,
      },
    );

    expect(res.packet.snippets.length).toBeGreaterThan(0);
    expect(res.packet.snippets.every((s) => s.refKind === "trace")).toBe(true);
    expect(res.stats.tier1Count).toBe(0);
    expect(res.stats.tier3Count).toBe(0);
    expect(res.stats.llmFilterOutcome).toBe("llm_filtered");
    expect(res.stats.emptyPacket).toBe(false);
    expect(filterCalls).toBe(1);
  });

  it("filters software-engineering prompts with the normalized bug query", async () => {
    let filterPrompt = "";
    const llm: any = {
      completeJson: async (messages: unknown, opts: { op?: string }) => {
        if (opts.op?.includes("retrieval.query.extract")) {
          return {
            value: {
              queryVecText: [
                "repository repair source fix",
                "repo: example-org/service-toolkit",
                "public route prefix",
                "route normalization helper",
              ].join("\n"),
              keywords: ["repository", "repair", "route", "prefix"],
            },
            servedBy: "fake",
          };
        }
        expect(opts.op).toContain("retrieval.filter");
        filterPrompt = JSON.stringify(messages);
        return {
          value: { selected: [1], sufficient: true },
          servedBy: "fake",
        };
      },
    };

    const res = await turnStartRetrieve(
      {
        ...makeDeps(handle),
        llm,
        config: {
          ...makeDeps(handle).config,
          llmFilterEnabled: true,
          llmFilterMinCandidates: 1,
        },
      },
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_current" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "A request handler returns an internal path when a public route prefix is configured.",
          "",
          "## Hints",
          "Check the route normalization helper and the response builder.",
          "diff --git a/src/routing/handler.py b/src/routing/handler.py index 1111111111..2222222222 100644 --- a/src/routing/handler.py +++ b/src/routing/handler.py @@ -10,1 +10,2 @@ def f(): - old value + new value",
          "",
          "STRICT RULES:",
          "Run every command through COMMAND_WRAPPER=/tmp/repair-wrapper.",
        ].join("\n"),
        ts: NOW as never,
      },
    );

    expect(res.stats.llmFilterOutcome).toBe("llm_filtered");
    expect(filterPrompt).toContain("repo: example-org/service-toolkit");
    expect(filterPrompt).toContain("public route prefix");
    expect(filterPrompt).toContain("route normalization helper");
    expect(filterPrompt).not.toContain("COMMAND_WRAPPER");
    expect(filterPrompt).not.toContain("STRICT RULES");
    expect(res.packet.rendered).toContain(
      "COMMAND_WRAPPER write path/to/file",
    );
    expect(res.packet.rendered).toContain("Command wrapper: `COMMAND_WRAPPER`");
    expect(res.packet.rendered).toContain("Use the exact current wrapper reference `COMMAND_WRAPPER`");
    expect(res.packet.rendered).toContain("Patch-readiness gate");
    expect(res.packet.rendered).toContain("First objective: produce a small non-empty source `git diff`");
    expect(res.packet.rendered).toContain("Patch-first completion contract");
    expect(res.packet.rendered).toContain("do not exceed eight inspect/search commands");
    expect(res.packet.rendered).toContain("current task action queue");
    expect(res.packet.rendered).toContain("## Generic repair heuristics");
    expect(res.packet.rendered).toContain("identifier/key collision handling");
    expect(res.packet.rendered).toContain("boundary conversion and value normalization");
    expect(res.packet.rendered).toContain("Edit-readiness rule");
    expect(res.packet.rendered).toContain("Do not inspect tests first");
    expect(res.packet.rendered).toContain("Do not reuse a hard-coded path from memory");
    expect(res.packet.rendered).not.toContain("/tmp/repair-wrapper write");
    expect(res.packet.rendered).toContain("double quotes around the `run` command");
    expect(res.packet.rendered).toContain("grep -n target_symbol");
    expect(res.packet.rendered).toContain("not a phrase with spaces");
    expect(res.packet.rendered).toContain("Never grep for a phrase containing whitespace");
    expect(res.packet.rendered).toContain("no inline `python - <<`");
    expect(res.packet.rendered).toContain("Never send multi-line Python");
    expect(res.packet.rendered).toContain("the shell is stuck in quote/heredoc continuation");
    expect(res.packet.rendered).toContain("Do not invent a repository root");
    expect(res.packet.rendered).toContain("git status --porcelain");
    expect(res.packet.rendered).toContain("temporary scripts");
    expect(res.packet.rendered).toContain("python /tmp/memmy_edit.py");
    expect(res.packet.rendered).toContain("repeats stale source text");
    expect(res.packet.rendered).toContain("assert old in text");
    expect(res.packet.rendered).toContain("Do not put shell substitutions like `$(sed ...)`");
    expect(res.packet.rendered).toContain("diff markers (`+`/`-` prefixes)");
    expect(res.packet.rendered).toContain("host-side");
    expect(res.packet.rendered).toContain("no `apply_patch`");
    expect(res.packet.rendered).toContain("no `sh -lc`");
    expect(res.packet.rendered).toContain("no shell pipes (`|`)");
    expect(res.packet.rendered).toContain("Do not finish by saying the issue is already fixed");
    expect(res.packet.rendered).toContain("if `git diff` is empty");
    expect(res.packet.rendered).toContain("Never switch to another repository directory");
    expect(res.packet.rendered).toContain("do not install a new test runner");
    expect(res.packet.rendered).toContain("If repair hints contain a candidate source diff");
    expect(res.packet.rendered).toContain("do not generalize the same idea to other similar call sites");
    expect(res.packet.rendered).toContain("existing behavior checks");
    expect(res.packet.rendered).toContain("Source behavior determines task success");
    expect(res.packet.rendered).toContain("inspect the target source file at most twice");
    expect(res.packet.rendered).toContain("Use simple single-token searches");
    expect(res.packet.rendered).toContain("avoid shell pipelines");
    expect(res.packet.rendered).toContain("host command parsers and allowlists");
    expect(res.packet.rendered).toContain("## Repair hint context");
    expect(res.packet.rendered).toContain("Candidate diff hunks:");
    expect(res.packet.rendered).toContain("Primary edit target: src/routing/handler.py");
    expect(res.packet.rendered).toContain(
      "Required edit command starts with: `COMMAND_WRAPPER write /tmp/memmy_edit.py",
    );
    expect(res.packet.rendered).toContain("Implementation anchors extracted from current hints");
    expect(res.packet.rendered).toContain("Prefer the first hint-guided search before traceback nouns");
    expect(res.packet.rendered).toContain("Safe large-file edit pattern:");
    expect(res.packet.rendered).toContain('p = Path("src/routing/handler.py")');
    expect(res.packet.rendered).toContain("Do not paste compact diff hunks directly");
    expect(res.packet.rendered).toContain("run narrow existing tests, then `git diff`");
    expect(res.packet.rendered).toContain("it is a completion gate");
    expect(res.packet.rendered).toContain("OLD block not found");
    expect(res.packet.rendered).toContain("no inline `python - <<`");
    expect(res.packet.rendered).toContain("diff --git a/src/routing/handler.py");
    expect(res.packet.rendered).toContain("\n- old value");
    expect(res.packet.rendered).toContain("\n+ new value");
    expect(res.packet.rendered).toContain("no `patch`");
  });

  it("turns visible issue description identifiers into a generic first-search checklist", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_visible_issue" as SessionId,
        userText: [
          "COMMAND_WRAPPER: /tmp/wrapper",
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "build_redirect() does not preserve PUBLIC_ROUTE_PREFIX.",
          "build_redirect returns redirect to internal_path instead of public_path.",
          "Patch - https://example.invalid/project/pull/123",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("## Visible issue context");
    expect(packet?.rendered).toContain("build_redirect");
    expect(packet?.rendered).toContain("PUBLIC_ROUTE_PREFIX");
    expect(packet?.rendered).toContain("internal_path");
    expect(packet?.rendered).toContain("public_path");
    expect(packet?.rendered).toContain("Prompt wording suggests possible current -> expected");
    expect(packet?.rendered).toContain("Output data-flow guard");
    expect(packet?.rendered).toContain("externally observed output");
    expect(packet?.rendered).toContain("return Redirect(expected)");
    expect(packet?.rendered).toContain("Visible replacement guidance");
    expect(packet?.rendered).toContain("exact-replacement script");
    expect(packet?.rendered).toContain("do not list the same block again");
    expect(packet?.rendered).toContain("do not start with `ls`/`pwd`");
    expect(packet?.rendered).toContain("COMMAND_WRAPPER run \"grep -R -n 'build_redirect' .\" 10");
    expect(packet?.rendered).not.toContain("example.invalid/project/pull/123");
  });

  it("keeps natural language fragments out of visible-issue first searches", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_visible_issue_fragments" as SessionId,
        userText: [
          "WRAPPER_PATH: /tmp/current-task-wrapper",
          "Run command: exec(\"/tmp/current-task-wrapper tmux-run \\\"command\\\" wait_seconds\")",
          "",
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "If the field is not in the data payload (e.g. it was omitted), self.cleaned_data should still allow normalized_value to override a default.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("self.cleaned_data");
    expect(packet?.rendered).toContain("normalized_value");
    expect(packet?.rendered).toContain("do not add a condition that an earlier guard already made impossible");
    expect(packet?.rendered).toContain("local alias and an object property");
    expect(packet?.rendered).toContain("If a just-run targeted test, reproduction, or assertion fails after your patch");
    expect(packet?.rendered).toContain("grep -R -n 'self.cleaned_data' .");
    expect(packet?.rendered).not.toContain("`e.g`");
    expect(packet?.rendered).not.toContain("data payload (e.g");
  });

  it("prioritizes the earliest concrete call example in visible issue text", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_visible_issue_ordered_examples" as SessionId,
        userText: [
          "WRAPPER_PATH: /tmp/current-task-wrapper",
          "Run command: exec(\"/tmp/current-task-wrapper tmux-run \\\"command\\\" wait_seconds\")",
          "",
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "Precompute slow CDF examples.",
          "cdf(Arcsin(\"x\", 0, 3))(1) returns an unevaluated integral.",
          "cdf(Logistic(\"x\", 1, 0.1))(2) throws an exception.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Ordered concrete examples detected");
    expect(packet?.rendered).toContain("`Arcsin`");
    expect(packet?.rendered).toContain("`Logistic`");
    expect(packet?.rendered).toContain("complete the earliest visible concrete example");
    expect(packet?.rendered).toContain("closed-form expression exactness");
    expect(packet?.rendered).toContain("mathematically equivalent output can still fail structural checks");
    expect(packet?.rendered).toContain("WRAPPER_PATH tmux-run \"grep -R -n 'Arcsin' .\" 10");
  });

  it("uses runtime conventions declared by the current repair prompt", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_runtime_conventions" as SessionId,
        userText: [
          "WRAPPER_PATH: /tmp/current-task-wrapper",
          "All commands MUST be executed via WRAPPER_PATH.",
          "Run command: exec(\"/tmp/current-task-wrapper tmux-run \\\"command\\\" wait_seconds\")",
          "Write file: exec(\"/tmp/current-task-wrapper write /target/path << 'EOF'\\nfile content\\nEOF\")",
          "Interrupt: exec(\"/tmp/current-task-wrapper tmux-run \\\"ctrl-c\\\" 3\")",
          "",
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "reset_token() returns a shared options map instead of an independent clone.",
          "",
          "Reply DONE when done.",
          "",
          "## Hints",
          "Inspect clone_token() and token_factory.py.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Command wrapper: `WRAPPER_PATH`");
    expect(packet?.rendered).toContain('Run command form: `WRAPPER_PATH tmux-run "command" 10`');
    expect(packet?.rendered).toContain('Interrupt form: `WRAPPER_PATH tmux-run "ctrl-c" 3`');
    expect(packet?.rendered).toContain("Completion token from the current prompt: `DONE`");
    expect(packet?.rendered).toContain('WRAPPER_PATH tmux-run "grep -R -n');
    expect(packet?.rendered).toContain("Implementation anchors extracted from current hints");
    expect(packet?.rendered).toContain("clone_token");
    expect(packet?.rendered).toContain("token_factory.py");
    expect(packet?.rendered).not.toContain("COMMAND_WRAPPER run");
  });

  it("prefers semantic capability anchors from repair hints", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_hint_capability_flag" as SessionId,
        userText: [
          "WRAPPER_PATH: /tmp/current-task-wrapper",
          "Run command: exec(\"/tmp/current-task-wrapper tmux-run \\\"command\\\" wait_seconds\")",
          "",
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "A generated expression crashes because the backend wraps an already compatible operation.",
          "",
          "## Hints",
          "Inspect render_expression() and the operation_compatible flag before changing generated SQL strings.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("operation_compatible");
    expect(packet?.rendered).toContain("compatibility/capability flag");
    expect(packet?.rendered).toContain("direct semantic guard or no-op");
    expect(packet?.rendered).toContain("over parsing generated output strings");
  });

  it("adds generic defect heuristics from visible issue words without library-specific prompts", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_generic_defect" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Issue Description",
          "Cloning a request token reuses the same options map. Mutating the clone changes the original token.",
          "The clone should preserve the timeout default and create an independent copy.",
          "",
          "## Hints",
          "Inspect the token factory and the constructor option handling.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("## Generic repair heuristics");
    expect(packet?.rendered).toContain("copy/mutation isolation");
    expect(packet?.rendered).toContain("configuration/default propagation");
    expect(packet?.rendered).toContain("Use them to choose the first source path to inspect");
  });

  it("adds generic default-assignment guidance without framework-specific terms", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_default_assignment" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "A form-like payload omits display_name in the raw input, but validation produces a non-empty normalized value.",
          "The constructor keeps the field default instead of assigning the normalized value.",
          "",
          "## Hints",
          "Inspect the construct path where raw payload presence and validated values are compared.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("omitted-input default guard");
    expect(packet?.rendered).toContain("normalized value is present");
    expect(packet?.rendered).toContain("empty normalized values");
    expect(packet?.rendered).toContain("repository's empty/sentinel helper");
  });

  it("adds generic repeated-seed guidance without task-specific library names", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_seed_reuse" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Issue Description",
          "Grouped shuffles reuse the same seed for every subgroup, so changing the seed only reorders groups and not within-group assignments.",
          "",
          "## Hints",
          "Inspect the loop that creates child split operations for each class bucket.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("stateful seed reuse across repeated work");
    expect(packet?.rendered).toContain("stateful generator/state object");
  });

  it("adds generic inverse-operation reduction guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_inverse_reduction" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "An AddItem operation followed by RemoveItem for the same key is not reduced to a no-op during optimization.",
          "",
          "## Hints",
          "Inspect the operation reducer and the pairwise optimization rules.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("paired inverse-operation reduction");
    expect(packet?.rendered).toContain("inverse operations on the same object/key");
  });

  it("adds generic owned-object identity guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_owned_identity" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "Objects copied from a base schema keep the same creation counter.",
          "Equality, hashing, and ordering treat copied fields from different owner namespaces as duplicates.",
          "",
          "## Hints",
          "Inspect the comparison helpers on the attached descriptor object.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("owned-object identity and ordering");
    expect(packet?.rendered).toContain("stable primitive owner or namespace key");
  });

  it("adds generic secondary-namespace relabel guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_namespace_relabel" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Issue Description",
          "Combining two expression graphs can collide when the right-hand graph reuses generated name prefixes from the left graph.",
          "The merged mapping then points references at the wrong node.",
          "",
          "## Hints",
          "Inspect the graph merge path and the reference map update.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("secondary namespace relabel before merge");
    expect(packet?.rendered).toContain("deterministically relabel the secondary side");
  });

  it("adds generic fast-path precondition guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_fast_path" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "A single-source optimized path is skipped and the planner emits an unnecessary subquery.",
          "The branch counts source handles before the base source initializer registers the handle.",
          "",
          "## Hints",
          "Inspect the branch that decides whether the shortcut can run.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("fast-path precondition initialization");
    expect(packet?.rendered).toContain("base source has been registered");
    expect(packet?.rendered).toContain("Do not make the fast path stricter");
    expect(packet?.rendered).toContain("same slow path or subquery");
  });

  it("adds generic single-column subquery projection guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_subquery_projection" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "A related lookup uses a subquery that now returns too many selected columns after annotations are added.",
          "The membership filter expects one target column but the nested query keeps the previous select list.",
          "",
          "## Hints",
          "Inspect the lookup preparation path where the subquery projection is set.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("single-column subquery projection");
    expect(packet?.rendered).toContain("select only the target column");
    expect(packet?.rendered).toContain("annotations, extra selected columns");
  });

  it("adds generic backend identifier quoting guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_identifier_quoting" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "A database backend constraint check fails when a table name is also a reserved word.",
          "The introspection SQL interpolates the raw table identifier without quoting it.",
          "",
          "## Hints",
          "Inspect the backend metadata statement builder and its existing quote helper.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("backend identifier quoting boundary");
    expect(packet?.rendered).toContain("metadata/introspection statements");
    expect(packet?.rendered).toContain("existing quote/escape helper");
  });

  it("adds generic public facade assembly guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_facade_assembly" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Issue Description",
          "The lower-level helper returns the expected grouped output, but the public wrapper list assembly returns separate items with the wrong output shape.",
          "",
          "## Hints",
          "Inspect the public facade before changing the internal grouping algorithm.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("public facade assembly consistency");
    expect(packet?.rendered).toContain("patch the wrapper/assembly boundary first");
  });

  it("builds a protocol-only packet for repository repair prompts without adapter state", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "hermes",
        sessionId: "s_protocol" as SessionId,
        userText: [
          "You need to fix a bug in the example-org/service-toolkit repository.",
          "",
          "## Bug Description",
          "Resetting a request token should create an independent copy.",
          "",
          "## Hints",
          "Inspect the token cloning path.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet).not.toBeNull();
    expect(packet?.snippets).toEqual([]);
    expect(packet?.rendered).toContain("Repository repair task protocol");
    expect(packet?.rendered).toContain("repository repair task");
    expect(packet?.rendered).toContain("Inspect the token cloning path.");

    const ordinary = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "hermes",
        sessionId: "s_plain" as SessionId,
        userText: "Summarize yesterday's notes.",
        ts: NOW as never,
      },
      NOW as never,
    );
    expect(ordinary).toBeNull();
  });

  it("can defer the local LLM pass for one final merged filter", async () => {
    let filterCalls = 0;
    const llm: any = {
      completeJson: async (_messages: unknown, opts: { op?: string }) => {
        if (opts.op?.includes("retrieval.query.extract")) {
          return {
            value: { queryVecText: "run docker compose", keywords: ["docker", "compose"] },
            servedBy: "fake",
          };
        }
        filterCalls++;
        return {
          value: { selected: [1], sufficient: true },
          servedBy: "fake",
        };
      },
    };
    const res = await turnStartRetrieve(
      {
        ...makeDeps(handle),
        llm,
        config: {
          ...makeDeps(handle).config,
          llmFilterEnabled: true,
          llmFilterMinCandidates: 1,
        },
      },
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_current" as SessionId,
        userText: "run docker compose",
        ts: NOW as never,
      },
      { skipLlmFilter: true },
    );

    expect(filterCalls).toBe(0);
    expect(res.packet.snippets.length).toBeGreaterThan(0);
    expect(res.stats.llmFilterOutcome).toBe("deferred_to_final");
    expect(res.stats.llmFilterKept).toBeGreaterThan(0);
  });

  it("lightweight mode keeps local memories when the summarizer filter is unavailable", async () => {
    const res = await turnStartRetrieve(
      {
        ...makeDeps(handle),
        llm: null,
        config: {
          ...makeDeps(handle).config,
          lightweightMemory: true,
          llmFilterEnabled: true,
          llmFilterMinCandidates: 1,
        },
      },
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_current" as SessionId,
        userText: "run docker compose",
        ts: NOW as never,
      },
    );

    expect(res.stats.tier2Count).toBeGreaterThan(0);
    expect(res.stats.llmFilterOutcome).toBe("no_llm");
    expect(res.stats.llmFilterKept).toBeGreaterThan(0);
    expect(res.packet.snippets.length).toBeGreaterThan(0);
    expect(res.stats.emptyPacket).toBe(false);
  });

  it("skill_invoke is tier1-heavy", async () => {
    const res = await skillInvokeRetrieve(makeDeps(handle), {
      reason: "skill_invoke",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      skillId: "sk_docker" as SkillId,
      query: "run docker compose up",
      ts: NOW as never,
    });
    const skillSnippets = res.packet.snippets.filter((s) => s.refKind === "skill");
    expect(skillSnippets.length).toBeGreaterThanOrEqual(1);
  });

  it("sub_agent skips tier1", async () => {
    const res = await subAgentRetrieve(makeDeps(handle), {
      reason: "sub_agent",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      mission: "docker plan",
      profile: "planner",
      ts: NOW as never,
    });
    expect(res.stats.tier1Count).toBe(0);
  });

  it("decision_repair with failureCount=0 returns null", async () => {
    const res = await repairRetrieve(makeDeps(handle), {
      reason: "decision_repair",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      failingTool: "docker.run",
      failureCount: 0,
      ts: NOW as never,
    });
    expect(res).toBeNull();
  });

  it("decision_repair includes low-value traces", async () => {
    // Add a zero-priority anti-pattern.
    handle.repos.traces.insert({
      id: "anti" as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: NOW as never,
      userText: "bad docker cmd",
      agentText: "this fails every time",
      toolCalls: [],
      reflection: "don't do this",
      value: -0.8 as never,
      alpha: 0.8 as never,
      rHuman: null,
      priority: 0 as never,
      tags: ["docker"],
      vecSummary: vec([1, 0, 0]),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });

    const res = await repairRetrieve(makeDeps(handle), {
      reason: "decision_repair",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      failingTool: "docker.run",
      failureCount: 3,
      lastErrorCode: "NETWORK_REFUSED",
      ts: NOW as never,
    });
    expect(res).not.toBeNull();
    expect(res!.packet.snippets.length).toBeGreaterThan(0);
  });

  it("emits retrieval.failed on embedder error (degraded, not thrown)", async () => {
    const deps: RetrievalDeps = {
      ...makeDeps(handle),
      embedder: {
        embed: async () => {
          throw new Error("boom");
        },
      },
    };
    const bus = createRetrievalEventBus();
    const kinds: string[] = [];
    bus.on((e) => kinds.push(e.kind));
    const res = await turnStartRetrieve(
      deps,
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s1" as SessionId,
        userText: "anything",
        ts: NOW as never,
      },
      { events: bus },
    );
    // Graceful degradation: empty packet + started + done, not a throw.
    expect(res.packet.snippets.length).toBe(0);
    expect(res.stats.emptyPacket).toBe(true);
    expect(res.stats.embedding).toMatchObject({
      attempted: true,
      ok: false,
      degraded: true,
      errorMessage: "boom",
    });
    expect(kinds).toEqual(["retrieval.started", "retrieval.done"]);
  });

  it("does not call the query embedder for blank turn-start text", async () => {
    let calls = 0;
    const deps: RetrievalDeps = {
      ...makeDeps(handle),
      embedder: {
        embed: async () => {
          calls++;
          throw new Error("should not be called");
        },
      },
    };

    const res = await turnStartRetrieve(deps, {
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      userText: "   ",
      ts: NOW as never,
    });

    expect(calls).toBe(0);
    expect(res.stats.embedding).toMatchObject({
      attempted: false,
      ok: false,
      degraded: false,
    });
  });
});
