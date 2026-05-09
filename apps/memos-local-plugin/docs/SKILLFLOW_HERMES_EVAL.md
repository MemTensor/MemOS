# SkillFlow Hermes Evaluation Notes

This document records the local evaluation procedure used to test whether the
installed Hermes agent plus the MemOS local memory plugin can learn reusable
skills across SkillFlow-style office/data workflow tasks.

## Goal

Evaluate whether the plugin improves Hermes on a sequence of related tasks:

1. Run a task with the installed Hermes agent and installed MemOS plugin.
2. Let the plugin capture the task trace and verifier feedback.
3. Run the next task in the same SkillFlow family.
4. Check whether the plugin generated reusable experience / policy / skill.
5. Check whether the later task recalls and uses that skill.

The intended comparison is:

- **Baseline**: Hermes without useful prior plugin memory.
- **Plugin run**: Hermes with MemOS memory enabled across the family.

This guide focuses on the plugin-side interactive run first.

## Dataset

The downloaded family is:

```text
.test_skillflow_official_family/SEC-13F-Financial-Analysis
```

Official task order from `ALL_TASK_DIFFICULTY_RANKING.json`:

```text
fund-snapshot-canonical
fund-class-breakdown
fund-shift-screen
issuer-ownership-rollup
manager-pair-issuer-grid
cross-quarter-reconciliation
deduped-alert-pack
existing-brief-refresh
```

The manual evaluation uses the first three tasks:

```text
fund-snapshot-canonical
fund-class-breakdown
fund-shift-screen
```

## Correct Run Mode

When the goal is to observe tasks in the live Memory Viewer, run Hermes against
the installed MemOS home:

```text
~/.hermes/memos-plugin
```

Do not set `MEMOS_HOME` for this mode. If `MEMOS_HOME` is set to a separate
directory, the plugin writes traces, policies, skills, and logs to that
directory, and the live viewer at `http://127.0.0.1:18800` will not show them.

The legacy runner has a `--use-main-home` option, but do not treat the runner as
the authoritative interactive procedure until it is patched. The current checked
script still contains old behavior in some places, including top-level
`hermes -z` calls and feedback text that can contain the task-boundary phrase.
Those details are unsafe for a live Memory Viewer evaluation.

For manual step-by-step evaluation, run one task at a time and wait for the
operator to inspect the Memory Viewer before continuing. The whole family run
must use one Hermes CLI session id. Do not use top-level `hermes -z` for this
workflow.

Use `hermes chat -q` instead:

```bash
# First turn: create the Hermes CLI session.
hermes chat --quiet --yolo --accept-hooks --pass-session-id \
  -q "$TASK_PROMPT"

# Later turns: keep the same Hermes CLI session.
hermes chat --resume "$HERMES_SESSION_ID" --quiet --yolo \
  --accept-hooks --pass-session-id -q "$PROMPT"
```

Why: top-level `hermes -z` goes through Hermes' `oneshot` path and bypasses the
normal chat/resume path. In source, `hermes_cli.main` dispatches `-z` directly to
`hermes_cli.oneshot.run_oneshot()`, which constructs a fresh `AIAgent` without
using the CLI `--resume` session id. As a result, the memory provider receives a
new plugin session for every `-z` invocation, even if `--resume` was present on
the command line.

## Manual Step-By-Step Commands

Create or reuse a run directory:

```bash
RUN_DIR="/Users/jiang/MyProject/MemOS-jiang/apps/memos-local-plugin/.test_skillflow_official_family/runs/sec13f-chatq-YYYYMMDD-HHMMSS"
mkdir -p "$RUN_DIR/logs" "$RUN_DIR/workspaces" "$RUN_DIR/backups"
echo "$RUN_DIR" > .test_skillflow_official_family/current_main_run_dir.txt
```

Create the verifier environment once:

```bash
VENV="$RUN_DIR/.venv"
python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install pandas==2.3.3 rapidfuzz==3.14.3 pytest==8.4.1
```

For each task, create a clean workspace:

```bash
TASK="fund-snapshot-canonical"
FAMILY_DIR="$PWD/.test_skillflow_official_family/SEC-13F-Financial-Analysis"
WORKSPACE="$RUN_DIR/workspaces/$TASK"
rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE"
cp "$FAMILY_DIR/$TASK/instruction.md" "$WORKSPACE/instruction.md"
cp -R "$FAMILY_DIR/$TASK/environment/." "$WORKSPACE/"
```

The first task creates the Hermes CLI session:

```bash
hermes chat --quiet --yolo --accept-hooks --pass-session-id \
  -q "$TASK_PROMPT" > "$RUN_DIR/logs/1-$TASK.hermes.out" 2>&1

HERMES_SESSION_ID="$(rg -o 'session_id: .*' "$RUN_DIR/logs/1-$TASK.hermes.out" \
  | tail -n1 | sed 's/session_id: //')"
echo "$HERMES_SESSION_ID" > .test_skillflow_official_family/current_hermes_session_id.txt
echo "$HERMES_SESSION_ID" > "$RUN_DIR/hermes_session_id.txt"
```

Later task turns, verifier-feedback turns, and same-task correction turns must
resume that same session:

```bash
hermes chat --resume "$HERMES_SESSION_ID" --quiet --yolo \
  --accept-hooks --pass-session-id -q "$PROMPT"
```

Every new benchmark task prompt starts with exactly:

```text
换个任务：
```

This explicit boundary helps the plugin close/finalize the previous task and
start a new episode.

Do not use `换个话题`, task-switching synonyms, or task-boundary phrases in this
evaluation. Use the exact boundary phrase above only for new benchmark tasks.
Verifier-feedback prompts and same-task correction prompts must not contain it.

## Manual Workflow

For each task, the operator workflow is:

1. Creates a clean task workspace under the run directory.
2. Copies only `instruction.md` and `environment/` into the workspace.
3. Does not expose `solution/`, `tests/`, or `expected_output.json` to Hermes.
4. Runs Hermes with `hermes chat -q` or `hermes chat --resume ... -q`.
5. Checks locally that `answers.json` exists before declaring the task round
   ready for inspection.
6. Stops and asks the operator to inspect the live Memory Viewer.
7. Runs the verifier only after the operator confirms inspection is complete.
8. Sends English verifier feedback back to Hermes as a follow-up turn.
9. Stops again and asks the operator to inspect the live Memory Viewer.
10. Prints a DB summary for `episodes`, `traces`, `policies`, `skills`,
   `skill_trials`, and `api_logs`.

Verifier feedback is important. SkillFlow's protocol includes trajectory and
rubric/verifier feedback before skill evolution. If the verifier result is only
checked by an external script and never shown to Hermes/plugin, the plugin sees
only that the agent claimed completion and has weak evidence for correction.

### Required Per-Round Feedback Turn

Every round must end with an explicit feedback turn to Hermes. This is not an
optional operator note; it is part of the evaluation protocol. After running the
verifier, the operator must tell Hermes:

- whether the task passed or failed;
- whether `answers.json` was missing;
- the expected vs actual field differences when available;
- the reusable lesson that should be retained for later tasks in the same
  family;
- that Hermes should consolidate this into memory / experience / skill for
  future related tasks, without re-solving the task or reading hidden
  `solution` / `tests` files.

The feedback prompt itself must be English and must not contain task-switching
phrases. In this evaluation, that means no `换个任务`, no `换个话题`, and no
Chinese sentence that asks Hermes to switch/start another task. The exact phrase
`换个任务：` should appear only at the start of a new benchmark task prompt.
Including a task-switching phrase in the verifier feedback turn can make the
memory plugin split the feedback into a separate task instead of attaching it to
the task that just ran.

Without this feedback turn, the plugin only captures the agent's self-reported
"done" message and tool trajectory. It may not know that the output was wrong,
so it has much weaker evidence for L2 induction or skill repair.

Use a feedback prompt with this shape:

```text
Verifier feedback for the SkillFlow SEC 13F task that just completed.

Read the feedback below. Consolidate the reusable SEC 13F data-processing
lesson into memory, experience, or skill for future related tasks in this same
family.

Do not modify any files. Do not solve the task again. Do not read solution
files, test files, expected output files, or original task repository files.

<English verifier result and reusable lesson>
```

Before sending feedback, run a local guard:

```bash
if printf '%s' "$feedback_prompt" | rg -q '换个任务|换个话题'; then
  echo "ERR: feedback prompt contains a forbidden task-switching phrase" >&2
  exit 2
fi
```

## Memory Viewer Notes

Hermes Memory Viewer is a separate daemon. `install.sh` starts it like this:

```bash
( cd "${prefix}" && nohup "${node_bin}" "${tsx_bin}" "${bridge_cts}" --agent=hermes --daemon >"${daemon_log}" 2>&1 & )
```

Important:

- Do not stop the viewer daemon when stopping an evaluation run.
- Do not use broad commands like `pkill -f ~/.hermes/memos-plugin/bridge.cts`
  during tests; this kills the Memory Viewer daemon too.
- Do not move or delete `~/.hermes/memos-plugin/data/memos.db` while the viewer
  is running.
- If the viewer is unavailable, check:

```bash
curl -sS --max-time 5 http://127.0.0.1:18800/api/v1/health
lsof -nP -iTCP:18800 -sTCP:LISTEN
```

## Operational Pitfalls

### Isolated MEMOS_HOME Hid Tasks From The Viewer

Do not use an isolated `MEMOS_HOME` when the goal is to observe the live Memory
Viewer:

```bash
MEMOS_HOME="$RUN_DIR/memos-home" hermes ...
```

This still uses the installed Hermes binary, but the plugin writes to:

```text
$RUN_DIR/memos-home/data/memos.db
```

The live viewer at `:18800` reads:

```text
~/.hermes/memos-plugin/data/memos.db
```

The live panel will not show tasks, memories, or skills from that isolated home.

### `--clean-db` Broke The Live Panel

Do not move the installed `memos.db` or kill `bridge.cts` during an interactive
evaluation. The live Memory Viewer daemon uses the same installed home, so broad
cleanup commands can break the panel. Treat runner-level `--clean-db` behavior
as unsafe unless it is known not to touch the installed DB or daemon.

### Running All Three Tasks Without Stops Was Hard To Inspect

Run one task at a time, then stop so the operator can inspect the Memory Viewer.
This is better for validating whether episode closure, reward, L2 induction, and
skill crystallization happened at each step.

### SkillFlow Q2/Q3 Are Not Separate Tasks

For `fund-shift-screen`, `2025-q2` and `2025-q3` are inputs to the same task.
They should not be treated as train/test tasks by themselves. The official
family order should be used instead.

### Task Boundary Phrase Must Be Exact

For this evaluation, only use the exact task boundary phrase:

```text
换个任务：
```

Do not replace it with `换个话题`, and do not use other topic-switching or
task-switching synonyms. `换个话题` is not the documented SkillFlow task boundary
for this evaluation, and it can still look like a task/topic switch to the
plugin. It must not appear in verifier feedback or same-task correction prompts.

### Hermes Can Claim Completion Without Writing The File

Hermes can claim that a task is complete even when `./answers.json` was not
written. Do not trust the final text response alone. After every task turn,
check the workspace from the outside:

```bash
test -f "$WORKSPACE/answers.json"
```

Only then tell the operator that the task is ready for Memory Viewer inspection.
If the file is missing, send a same-task correction prompt that does not contain
the task-boundary phrase. The correction prompt should explicitly say this is the
same current task, name the exact workspace, and require an existence check.

### Same-Task Correction Prompts Are Not Feedback

If Hermes acknowledges a task without producing `answers.json`, send a same-task
continuation/correction prompt before verification. This prompt is still part of
the current task. It must not contain `换个任务`, `换个话题`, or any equivalent
task-switching phrase. Do not run the verifier until there is an actual
`answers.json` file to verify, unless the intended verifier result is explicitly
"missing answers.json".

### Avoid zsh Read-Only Variable Names

In zsh, `status` is a read-only special parameter. Wrapper scripts should use
`rc=$?` or `hermes_status=$?` instead.

### Quote Feedback Heredocs

When creating Markdown feedback with shell heredocs, do not use an unquoted
heredoc delimiter if the content contains Markdown backticks. An unquoted heredoc
can run command substitution inside backticks. Use one of these safer patterns:

```bash
cat > "$FEEDBACK_FILE" <<'EOF'
Verifier feedback for completed task <task-name>:
...
EOF
```

or avoid Markdown backticks in shell-generated feedback.

### Watch For Schema Carryover Across Related Tasks

Because all tasks are in the same SEC 13F family, Hermes may carry over output
fields or assumptions from a previous related task. Verifier feedback should
explicitly teach:

- always re-read the current `instruction.md`;
- emit exactly the current task's requested JSON schema;
- do not carry output fields across related tasks unless the current instruction
  asks for them.

## Interpreting Memory Output

The Memory Viewer and inspection script should be treated as live diagnostic
tools, not as a place to encode one-off run history in this document. Each rerun
may start from a cleared database, so record only the current run's observations
outside this guide.

Useful interpretation rules:

- If `skills=0`, that does not necessarily mean the Skill generator rejected a
  candidate. Check whether any eligible policy exists first.
- The expected path is `L1 traces -> L2 candidate pool -> L2 policy -> Skill`.
  Skill crystallization needs an eligible L2 policy input.
- If verifier feedback is not attached to the same task episode, memory quality
  will be weak. Check session continuity and forbidden task-switching phrases
  before changing thresholds.
- If related tasks do not induce a reusable policy, inspect whether candidate
  grouping is too tool/action-centric for SkillFlow-style tasks.

## Tuning Guidance

Do not start by lowering every threshold. Prefer investigating the evidence path:

1. Make sure all turns in a family use one Hermes CLI session id.
2. Make sure verifier feedback is English, attached to the just-completed task,
   and free of task-switching phrases.
3. Check whether L2 candidates are grouped by reusable workflow concepts rather
   than fragmented low-level tool patterns.
4. Consider a verifier-feedback-specific path into L2/Skill formation if the
   general L1 -> L2 -> Skill pipeline is too slow for SkillFlow's rubric-feedback
   protocol.

If threshold changes are needed, scope them to explicit evaluation or verifier
feedback turns where possible. A global reduction can create noisy policies
during ordinary chat.

## Useful Inspection Commands

```bash
sqlite3 ~/.hermes/memos-plugin/data/memos.db \
  "SELECT COUNT(*) FROM episodes; SELECT COUNT(*) FROM traces; SELECT COUNT(*) FROM policies; SELECT COUNT(*) FROM skills;"
```

```bash
python3 .test_skillflow_official_family/inspect_memos_skillflow.py \
  --db ~/.hermes/memos-plugin/data/memos.db \
  --since-ms 0
```

```bash
curl -sS --max-time 5 http://127.0.0.1:18800/api/v1/health
```
