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
          "You need to fix a bug in the django/django repository.",
          "",
          "## Bug Description",
          "ModelForm should not overwrite provided default values when cleaned_data contains an empty value.",
          "",
          "## Hints",
          "Check BoundField and model_to_dict interactions.",
          "diff --git a/django/forms/models.py b/django/forms/models.py index 1111111111..2222222222 100644 --- a/django/forms/models.py +++ b/django/forms/models.py @@ -10,1 +10,2 @@ def f(): - old value + new value",
          "",
          "STRICT RULES:",
          "Run every command through WRAPPER_PATH=/tmp/swebench-wrapper.",
        ].join("\n"),
        ts: NOW as never,
      },
    );

    expect(res.stats.llmFilterOutcome).toBe("llm_filtered");
    expect(filterPrompt).toContain("repo: django/django");
    expect(filterPrompt).toContain("ModelForm should not overwrite");
    expect(filterPrompt).toContain("Check BoundField");
    expect(filterPrompt).not.toContain("WRAPPER_PATH");
    expect(filterPrompt).not.toContain("STRICT RULES");
    expect(res.packet.rendered).toContain(
      "WRAPPER_PATH write /testbed/path/to/file",
    );
    expect(res.packet.rendered).toContain("Use the exact current `WRAPPER_PATH`");
    expect(res.packet.rendered).toContain("Immediate repair gate");
    expect(res.packet.rendered).toContain("First objective: produce a small non-empty source `git diff`");
    expect(res.packet.rendered).toContain("Patch-first completion contract");
    expect(res.packet.rendered).toContain("do not exceed eight inspect/search commands");
    expect(res.packet.rendered).toContain("current task action queue");
    expect(res.packet.rendered).toContain("Closure-stop rule");
    expect(res.packet.rendered).toContain("Do not inspect tests first");
    expect(res.packet.rendered).toContain("Do not reuse a hard-coded `/tmp/...-exec`");
    expect(res.packet.rendered).not.toContain("/tmp/swebench-wrapper write");
    expect(res.packet.rendered).toContain("double quotes around the `tmux-run` command");
    expect(res.packet.rendered).toContain("grep -n combine");
    expect(res.packet.rendered).toContain("not a phrase with spaces");
    expect(res.packet.rendered).toContain("Never grep for a phrase containing whitespace");
    expect(res.packet.rendered).toContain("no inline `python - <<`");
    expect(res.packet.rendered).toContain("Every non-poll `tmux-run` command must start with `cd /testbed &&`");
    expect(res.packet.rendered).toContain("git status --porcelain");
    expect(res.packet.rendered).toContain("temporary scripts");
    expect(res.packet.rendered).toContain("python /tmp/memos_edit.py");
    expect(res.packet.rendered).toContain("repeats stale source text");
    expect(res.packet.rendered).toContain("assert old in text");
    expect(res.packet.rendered).toContain("Do not put shell substitutions like `$(sed ...)`");
    expect(res.packet.rendered).toContain("diff markers (`+`/`-` prefixes)");
    expect(res.packet.rendered).toContain("host-side");
    expect(res.packet.rendered).toContain("no `apply_patch`");
    expect(res.packet.rendered).toContain("no `sh -lc`");
    expect(res.packet.rendered).toContain("no shell pipes (`|`)");
    expect(res.packet.rendered).toContain("Do not finish by saying the bug is already fixed");
    expect(res.packet.rendered).toContain("if `git diff` is empty");
    expect(res.packet.rendered).toContain("never switch to `/repo`");
    expect(res.packet.rendered).toContain("Do not install pytest");
    expect(res.packet.rendered).toContain("If bug hints contain a candidate source diff");
    expect(res.packet.rendered).toContain("do not generalize the same idea to other similar call sites");
    expect(res.packet.rendered).toContain("existing behavior checks");
    expect(res.packet.rendered).toContain("Held-out verification scores the source patch");
    expect(res.packet.rendered).toContain("inspect the target source file at most twice");
    expect(res.packet.rendered).toContain("Use simple single-token searches");
    expect(res.packet.rendered).toContain("avoid shell pipelines");
    expect(res.packet.rendered).toContain("## Visible bug clue digest");
    expect(res.packet.rendered).toContain("cleaned_data");
    expect(res.packet.rendered).toContain("do not start with `ls`/`pwd`");
    expect(res.packet.rendered).toContain("## Bug hint digest");
    expect(res.packet.rendered).toContain("Candidate diff hunks:");
    expect(res.packet.rendered).toContain("Primary edit target: /testbed/django/forms/models.py");
    expect(res.packet.rendered).toContain(
      "Required edit command starts with: `WRAPPER_PATH write /tmp/memos_edit.py",
    );
    expect(res.packet.rendered).toContain("Safe large-file edit pattern:");
    expect(res.packet.rendered).toContain('p = Path("/testbed/django/forms/models.py")');
    expect(res.packet.rendered).toContain("Do not paste compact diff hunks directly");
    expect(res.packet.rendered).toContain("run narrow existing tests, then `git diff`");
    expect(res.packet.rendered).toContain("it is a completion gate");
    expect(res.packet.rendered).toContain("OLD block not found");
    expect(res.packet.rendered).toContain("no inline `python - <<`");
    expect(res.packet.rendered).toContain("diff --git a/django/forms/models.py");
    expect(res.packet.rendered).toContain("\n- old value");
    expect(res.packet.rendered).toContain("\n+ new value");
    expect(res.packet.rendered).toContain("no `patch`");
  });

  it("turns visible bug description identifiers into a generic first-search checklist", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_visible_bug" as SessionId,
        userText: [
          "WRAPPER_PATH: /tmp/wrapper",
          "You need to fix a bug in the django/django repository.",
          "",
          "## Bug Description",
          "catch_all_view() does not support FORCE_SCRIPT_NAME.",
          "catch_all_view returns redirect to '%s/' % request.path_info (script name cut off there) instead of '%s/' % request.path",
          "Patch - https://example.invalid/project/pull/123",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("## Visible bug clue digest");
    expect(packet?.rendered).toContain("catch_all_view");
    expect(packet?.rendered).toContain("FORCE_SCRIPT_NAME");
    expect(packet?.rendered).toContain("request.path_info");
    expect(packet?.rendered).toContain("request.path");
    expect(packet?.rendered).toContain("Prompt wording suggests possible current -> expected");
    expect(packet?.rendered).toContain("Output data-flow guard");
    expect(packet?.rendered).toContain("externally observed output");
    expect(packet?.rendered).toContain("return Redirect(expected)");
    expect(packet?.rendered).toContain("Visible replacement closure");
    expect(packet?.rendered).toContain("exact-replacement script");
    expect(packet?.rendered).toContain("do not list the same block again");
    expect(packet?.rendered).toContain("do not start with `ls`/`pwd`");
    expect(packet?.rendered).toContain("grep -R -n 'catch_all_view' django tests");
    expect(packet?.rendered).not.toContain("example.invalid/project/pull/123");
  });

  it("expands compact paired operations into a generic reduction checklist", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_operation_reduction" as SessionId,
        userText: [
          "You need to fix a bug in the django/django repository.",
          "",
          "## Bug Description",
          "Reduce Add/RemoveIndex migration operations.",
          "We should reduce AddIndex/RemoveIndex operations when optimizing migration operations.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Search these exact visible identifiers/strings first");
    expect(packet?.rendered).toContain("`AddIndex`");
    expect(packet?.rendered).toContain("`RemoveIndex`");
    expect(packet?.rendered).toContain("Operation reduction closure");
    expect(packet?.rendered).toContain("Mandatory staged plan");
    expect(packet?.rendered).toContain("Do not search tests before step 3");
    expect(packet?.rendered).toContain("base reducer/optimizer contract");
    expect(packet?.rendered).toContain("same model/object key");
    expect(packet?.rendered).toContain("super().reduce");
    expect(packet?.rendered).toContain("return []");
    expect(packet?.rendered).toContain("Convergence budget");
  });

  it("turns cleaned_data default override wording into an empty-value guard", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_cleaned_default" as SessionId,
        userText: [
          "You need to fix a bug in the django/django repository.",
          "",
          "## Bug Description",
          "Allow cleaned_data to overwrite fields' default values.",
          "When a field is not in the raw data payload but clean() supplies a non-empty value in cleaned_data, the default value should not win.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Cleaned-data default override closure");
    expect(packet?.rendered).toContain("Visible pattern: cleaned_data/default override");
    expect(packet?.rendered).toContain("edit that guard now");
    expect(packet?.rendered).toContain("non-empty value");
    expect(packet?.rendered).toContain("not in cleaned_data");
    expect(packet?.rendered).toContain("no-op for this bug shape");
    expect(packet?.rendered).toContain("empty_values");
    expect(packet?.rendered).toContain("Patch shape");
    expect(packet?.rendered).toContain("cleaned_value in field.empty_values");
    expect(packet?.rendered).toContain("stop searching tests");
    expect(packet?.rendered).toContain("construct/assignment point");
  });

  it("turns enum field value wording into a shared choices casting guard", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_enum_choices" as SessionId,
        userText: [
          "You need to fix a bug in the django/django repository.",
          "",
          "## Bug Description",
          "The value of a TextChoices/IntegerChoices field has a differing type.",
          "A created instance keeps the enum value while a retrieved instance has the primitive str value.",
          "str(my_object.my_str_value) should be the same for both paths.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Enum value casting closure");
    expect(packet?.rendered).toContain("shared enum/choices value representation");
    expect(packet?.rendered).toContain("underlying `.value`");
  });

  it("turns abstract field equality wording into stable model-key comparison guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_field_comparison" as SessionId,
        userText: [
          "You need to fix a bug in the django/django repository.",
          "",
          "## Bug Description",
          "Abstract model field should not be equal across models.",
          "Fields only consider self.creation_counter in __eq__, so a shared set de-duplicates fields copied to two concrete models.",
          "Adjust __eq__, __hash__, and __lt__, while ordering first by creation_counter.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Model-attached object comparison closure");
    expect(packet?.rendered).toContain("owning model namespace");
    expect(packet?.rendered).toContain("stable primitive model labels/names");
    expect(packet?.rendered).toContain("not model classes/objects directly with `<`");
    expect(packet?.rendered).toContain("Do not implement ordering/hash as");
    expect(packet?.rendered).toContain("raw class/object");
    expect(packet?.rendered).toContain("(app_label, model_name)");
    expect(packet?.rendered).toContain("creation_counter, model_key");
  });

  it("turns random_state stratified shuffle wording into RNG propagation guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_random_state" as SessionId,
        userText: [
          "You need to fix a bug in the scikit-learn/scikit-learn repository.",
          "",
          "## Bug Description",
          "StratifiedKFold either shuffling is wrong or documentation is misleading.",
          "With shuffle=True, each stratification is shuffled the same way and different random_state values do not change useful batches.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Random-state propagation closure");
    expect(packet?.rendered).toContain("Visible pattern: shuffle/random_state propagation");
    expect(packet?.rendered).toContain("same RNG object");
    expect(packet?.rendered).toContain("random_state=rng");
    expect(packet?.rendered).toContain("normalizer(self.random_state)");
    expect(packet?.rendered).toContain("per-class pairings stay seed-insensitive");
    expect(packet?.rendered).toContain("Do not draw a fresh integer seed");
    expect(packet?.rendered).toContain("grep -R -n 'StratifiedKFold' sklearn");
  });

  it("turns single-alias delete wording into an alias initialization guard", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_single_alias_delete" as SessionId,
        userText: [
          "You need to fix a bug in the django/django repository.",
          "",
          "## Bug Description",
          "Model.objects.all().delete() subquery usage performance regression.",
          "The old SQL was DELETE FROM table, but now delete() emits a self subquery.",
          "",
          "## Hints",
          "It should be possible to prevent the query when dealing with a single alias.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Single-alias SQL fast-path closure");
    expect(packet?.rendered).toContain("base table alias is registered");
    expect(packet?.rendered).toContain("existing base/initial alias initializer");
    expect(packet?.rendered).toContain("an empty diff plus passing existing tests is not a fix");
  });

  it("turns alias_prefix collision hints into RHS relabelling guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_alias_prefix_collision" as SessionId,
        userText: [
          "You need to fix a bug in the django/django repository.",
          "",
          "## Bug Description",
          "Combining QuerySets with ForeignKey and ManyToManyField triggers AssertionError in Query.change_aliases.",
          "",
          "## Hints",
          "Both queries share the same alias_prefix. Change the alias_prefix of the rhs and change its alias accordingly before proceeding with creation of the change_map. Query.bump_prefix does the heavy lifting for subqueries but is not entirely applicable here.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Alias-prefix collision closure");
    expect(packet?.rendered).toContain("deterministic RHS alias-relabelling bug");
    expect(packet?.rendered).toContain("inspect `Query.combine()` and `Query.change_aliases()` once");
    expect(packet?.rendered).toContain("before constructing the combine `change_map`");
    expect(packet?.rendered).toContain("Do not randomize alias prefixes");
  });

  it("turns non-default DB natural-key loaddata wording into instance-state guidance", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_natural_key_db" as SessionId,
        userText: [
          "You need to fix a bug in the django/django repository.",
          "",
          "## Bug Description",
          "loaddata fails on non-default database when natural keys uses foreign keys.",
          "With ./manage.py loaddata --database other, Book.natural_key() traverses self.author.natural_key() and related_descriptors query the default database.",
          "The traceback points to django/core/serializers/base.py build_instance calling Model(**data).natural_key().",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Natural-key database-state closure");
    expect(packet?.rendered).toContain("temporary natural-key instance state");
    expect(packet?.rendered).toContain("set its `_state.db`");
    expect(packet?.rendered).toContain("deserialization `db`/`using` value");
    expect(packet?.rendered).toContain("Do not patch user model natural_key methods");
  });

  it("turns visible factor multiplicity wording into a grouping invariant", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s_factor_grouping" as SessionId,
        userText: [
          "You need to fix a bug in the sympy/sympy repository.",
          "",
          "## Bug Description",
          "sqf and sqf_list output is not consistant.",
          "We should have (x**2 - 5*x + 6, 3) and not 2 factors of multiplicity 3.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet?.rendered).toContain("Prompt wording suggests possible current -> expected");
    expect(packet?.rendered).toContain("`2 factors of multiplicity 3` -> `(x**2 - 5*x + 6, 3)`");
    expect(packet?.rendered).toContain("Factor-list grouping closure");
    expect(packet?.rendered).toContain("Visible pattern: factor-list multiplicity aggregation");
    expect(packet?.rendered).toContain("same multiplicity should be one factor");
    expect(packet?.rendered).toContain("Mandatory edit trigger");
    expect(packet?.rendered).toContain("group returned factor pairs by multiplicity");
    expect(packet?.rendered).toContain("public symbolic wrapper first explodes a top-level product");
    expect(packet?.rendered).toContain("method form as a local oracle");
    expect(packet?.rendered).toContain("preserving the coefficient");
    expect(packet?.rendered).toContain("broader API redesign");
    expect(packet?.rendered).toContain("grep -R -n 'sqf_list' sympy");
  });

  it("builds a protocol-only packet for software repair prompts without adapter state", () => {
    const packet = taskProtocolOnlyPacket(
      {
        reason: "turn_start",
        agent: "hermes",
        sessionId: "s_protocol" as SessionId,
        userText: [
          "You need to fix a bug in the django/django repository.",
          "",
          "## Bug Description",
          "Resetting the primary key for a child model should create a copy.",
          "",
          "## Hints",
          "Inspect the model inheritance save path.",
        ].join("\n"),
        ts: NOW as never,
      },
      NOW as never,
    );

    expect(packet).not.toBeNull();
    expect(packet?.snippets).toEqual([]);
    expect(packet?.rendered).toContain("Software engineering task protocol");
    expect(packet?.rendered).toContain("software repair task");
    expect(packet?.rendered).toContain("Inspect the model inheritance save path.");

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
      completeJson: async () => {
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
