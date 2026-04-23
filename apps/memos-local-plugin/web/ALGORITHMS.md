# `web/` invariants

This file enumerates the invariants the viewer upholds for the
algorithm core. Violations are considered bugs even if the view
renders "something"; each invariant tries to prevent a class of
production issues rather than a specific screen.

## W1 — The viewer is read-mostly

**Invariant.** Only three viewer operations mutate core state:

1. `POST /api/v1/feedback` (FeedbackView)
2. `POST /api/v1/skills/retire` (SkillsView, behind a confirm prompt)
3. `DELETE /api/v1/sessions`/`/api/v1/episodes` (not currently
   surfaced in the UI but allowed via REST)

Nothing else writes. In particular the viewer **never** forges a
`TurnInputDTO` or `TurnResultDTO`; those shapes are only produced by
adapters with an authentic agent event.

**Why.** Memory state is expensive to mutate — it carries reflection
weights, crystallization signals, and audit history. An accidental
turn from the viewer would poison all three.

## W2 — No route preview without a route

**Invariant.** The viewer never issues a prefetch for a route the
user did not explicitly navigate to. Each view's `useEffect` runs
strictly on mount; on unmount it aborts outstanding fetches via
`AbortController`.

**Why.** Speculative prefetch would trigger algorithm-side work (e.g.
`searchMemory`) the user didn't ask for, burning LLM/embedding budget
and confusing audit logs about which turns the user actually saw.

## W3 — API-key propagation is uniform

**Invariant.** Every call path reads the api key from one place
(`localStorage["memos.apiKey"]`) and attaches it as `x-api-key`.
There are exactly three call sites:

- `api.get` / `api.post` / `api.del` (REST)
- `openSse` (SSE)
- (no third — these two cover every network request)

**Why.** Scattered header construction leads to leaks (keys in URLs,
sent to wrong origins) and misses (auth silently dropped on one path).
Centralizing keeps the auth surface auditable and side-effect free.

## W4 — SSE streams degrade gracefully, never crash the view

**Invariant.** When the SSE connection drops, the viewer displays the
last-known state and attempts reconnect with exponential backoff
(`500ms → 1s → … → 16s`). A dropped connection never unmounts the
view, and never duplicates rows after reconnect (the live list is
prepended and capped at 500–800 rows).

**Why.** Browser sleep, VPN flips, or restarts of the core should
show up as "temporarily disconnected" rather than a blank screen or a
rendering freeze. The algorithm itself keeps emitting; the viewer's
job is to catch back up silently.

## W5 — Injected content is displayed verbatim

**Invariant.** When the viewer shows `injectedContext`,
`invocationGuide`, `userText`, `agentText`, or any trace body, it
preserves the raw string exactly. No Markdown rendering, no HTML
unescape. Code-like content is wrapped in `<pre class="code">` with
`white-space: pre-wrap`.

**Why.** The algorithm expects to reason about the exact text it
saved. A prettified rendering would confuse operators trying to
debug why a skill fired or a retrieval matched — the UI would show
something different from what the LLM actually sees.

## W6 — Retire actions require confirmation

**Invariant.** `retireSkill` is always preceded by an affirmative
`confirm("Retire skill …?")`. Skills retire lazily, not eagerly.

**Why.** Retired skills stop being injected, which is irreversible
from the viewer alone (reinstating requires a trace-level signal). A
confirm step prevents one-click loss of adopted knowledge.

## W7 — Theme switches never lose state

**Invariant.** Toggling the theme updates `data-theme` on `<html>`
and writes `memos.theme` in localStorage; it does not remount the
app. Signal-backed view state (filters, selection, paused streams)
survives.

**Why.** Themes are cosmetic; forcing a reload for a light/dark
switch is clumsy and would drop an operator's filter/cursor while
they're trying to debug a live incident.

## W8 — No framework lock-in on routes

**Invariant.** The router is a single 40-line signal. Any viewer
change that requires a third-party routing library must first delete
this module and move the rest of the viewer off its API.

**Why.** The viewer's API surface is small enough that a real router
would be a liability, not a feature. This invariant keeps that
promise explicit.

## W9 — Every stream has a pause + clear

**Invariant.** EventsView and LogsView both expose `Pause` and
`Clear` controls, with state local to the view. Pausing does not
disconnect the stream; it only stops accumulating rows.

**Why.** During an incident, operators need to freeze the view while
they read it and wipe noise once they've understood a pattern. This
keeps those ergonomics fixed regardless of log volume.

## W10 — Types match the core by construction

**Invariant.** Every DTO used by the viewer is re-exported from
`../agent-contract` via `web/src/api/types.ts`. New types are never
declared inline in `web/src/`.

**Why.** When the contract evolves, the viewer fails to type-check
rather than rendering stale fields. `tsconfig.web.json` is part of
CI's typecheck matrix; drift surfaces at build time, not at demo
time.
